// =============================================================================
// @pmatrix/openclaw-monitor — hooks/subagent.ts
// 하위 에이전트 훅 (§5-5):
//   subagent_spawning         — 폭발 감지 + Kill Switch 연동
//   subagent_spawned          — 생성 완료 기록 (NORM 신호)
//   subagent_ended            — 하위 에이전트 종료 기록
//   subagent_delivery_target  — GA B-3: 결과 전달 대상 관찰 (Cross-Agent 통신 맵)
// =============================================================================

import { OpenClawPluginAPI, PMatrixConfig, HookContext } from '../types';
import { PMatrixHttpClient } from '../client';
import {
  getOrCreateSession,
  getSession,
  bufferSignal,
  buildSignalPayload,
  applyMetaControlDelta,
  haltSession,
  recordSubagentSpawn,
  getRecentSubagentCount,
  incrementDangerEvents,
  pendingChildLinks,
  sweepStalePendingLinks,
} from '../session-state';
import { formatHaltAuto } from '../ui/formatter';

// ─── 상수 ────────────────────────────────────────────────────────────────────

/** 하위 에이전트 폭발 감지 임계값 (§5-5) */
const SUBAGENT_EXPLOSION_THRESHOLD = 5;
/** 폭발 감지 윈도우: 5분 (ms) */
const SUBAGENT_EXPLOSION_WINDOW_MS = 5 * 60_000;
/** 폭발 감지 시 meta_control 감점 */
const SUBAGENT_EXPLOSION_META_CONTROL_DELTA = -0.30;

// ─── 등록 진입점 ──────────────────────────────────────────────────────────────

export function registerSubagentHooks(
  api: OpenClawPluginAPI,
  config: PMatrixConfig,
  client: PMatrixHttpClient
): void {
  registerSubagentSpawning(api, config, client);
  registerSubagentSpawned(api, config);
  registerSubagentEnded(api, config);
  registerSubagentDeliveryTarget(api, config);
}

// ─── subagent_spawning (§5-5) ────────────────────────────────────────────────

/**
 * 하위 에이전트 생성 직전:
 *   1. Halt 상태 → 즉시 차단 (status: 'error')
 *   2. 5분 내 5개 이상 → 폭발 감지 → meta_control -0.30 + 차단
 *   3. 통과 시 타임스탬프 기록 + NORM 신호 버퍼
 */
function registerSubagentSpawning(
  api: OpenClawPluginAPI,
  config: PMatrixConfig,
  client: PMatrixHttpClient
): void {
  api.on('subagent_spawning', async (event, ctx) => {
    const sessionKey = resolveKey(ctx, event);
    if (!sessionKey) return {};

    const state = getOrCreateSession(sessionKey, config.agentId);

    // ── 1. Halt 상태 → 즉시 차단 ─────────────────────────────────────────
    if (state.isHalted) {
      if (config.debug) {
        api.logger.debug(
          `[P-MATRIX] subagent_spawning blocked: session is Halted`
        );
      }
      return { status: 'error' };
    }

    // ── 2. 하위 에이전트 폭발 감지 (5분 내 5개 이상) ─────────────────────
    const recentCount = getRecentSubagentCount(
      sessionKey,
      SUBAGENT_EXPLOSION_WINDOW_MS
    );

    if (recentCount >= SUBAGENT_EXPLOSION_THRESHOLD) {
      const updatedAxes = applyMetaControlDelta(
        sessionKey,
        SUBAGENT_EXPLOSION_META_CONTROL_DELTA
      );

      // 자동 Halt 여부 확인 (R(t) ≥ 0.75)
      if (state.currentRt >= config.killSwitch.autoHaltOnRt) {
        haltSession(
          sessionKey,
          `하위 에이전트 폭발: ${recentCount}개 생성 (5분)`
        );
        const haltMsg = formatHaltAuto(state.currentRt, [
          `하위 에이전트 폭발적 생성 (5분 내 ${recentCount}개)`,
        ]);
        api.logger.warn(haltMsg);
      }

      // 긴급 신호 전송
      if (config.dataSharing && updatedAxes) {
        const signal = buildSignalPayload(
          state,
          {
            event_type: 'subagent_explosion',
            meta_control_delta: SUBAGENT_EXPLOSION_META_CONTROL_DELTA,
            priority: 'critical',
            subagents_active: recentCount,
          },
          updatedAxes
        );
        // FIX #32: Promise 오류 묵살 방지 — debug 로그
        void client.sendCritical(signal).catch((err: Error) => {
          if (config.debug) {
            api.logger.debug(`[P-MATRIX] sendCritical failed: ${err.message}`);
          }
        });
      }

      incrementDangerEvents(sessionKey);
      api.logger.warn(
        `[P-MATRIX] 하위 에이전트 폭발 감지: ${recentCount}개 (5분) — 차단`
      );
      return { status: 'error' };
    }

    // ── 3. 통과 — pendingChildLinks 등록 + 타임스탬프 기록 + NORM 신호 ──

    // [Tier-2 §A-1] TTL sweep (stale entries 정리) — 발화마다 수행
    sweepStalePendingLinks();

    // [Tier-2 §A-1] 자식 세션 브릿지 등록
    // key = child agentId (session_start에서 동일 키로 조회)
    // ★ parentAgentId = state.agentId (SessionState에서 가져옴 — event 직접 추출 금지)
    const childAgentId =
      (event['agentId'] as string | undefined) ??
      (event['subagentId'] as string | undefined) ??
      null;
    // FIX #54: 중복 subagent_spawning 이벤트 덮어쓰기 방지 — 첫 번째 링크 보존
    if (childAgentId && !pendingChildLinks.has(childAgentId)) {
      pendingChildLinks.set(childAgentId, {
        parentAgentId: state.agentId,
        depth: (state.agentDepth ?? 0) + 1,
        createdAt: Date.now(),
      });
    }

    recordSubagentSpawn(sessionKey);

    if (config.dataSharing) {
      const mode = String(event['mode'] ?? event['subagentMode'] ?? 'unknown');
      const signal = buildSignalPayload(state, {
        event_type: 'subagent_spawning',
        tool_name: mode,
        subagents_active: recentCount + 1,
      });
      bufferSignal(sessionKey, signal);
    }

    return {};
  });
}

// ─── subagent_spawned ────────────────────────────────────────────────────────

/**
 * 하위 에이전트 생성 완료 — 성공 기록
 */
function registerSubagentSpawned(
  api: OpenClawPluginAPI,
  config: PMatrixConfig
): void {
  api.on('subagent_spawned', async (event, ctx) => {
    const sessionKey = resolveKey(ctx, event);
    if (!sessionKey) return {};

    if (config.debug) {
      const subId = event['subagentId'] ?? event['id'] ?? 'unknown';
      api.logger.debug(`[P-MATRIX] Subagent spawned: ${String(subId)}`);
    }

    return {};
  });
}

// ─── subagent_ended ──────────────────────────────────────────────────────────

/**
 * 하위 에이전트 종료 — NORM 신호 버퍼링
 */
function registerSubagentEnded(
  api: OpenClawPluginAPI,
  config: PMatrixConfig
): void {
  api.on('subagent_ended', async (event, ctx) => {
    const sessionKey = resolveKey(ctx, event);
    if (!sessionKey) return {};

    const state = getSession(sessionKey);
    if (!state) return {};

    if (config.dataSharing) {
      const signal = buildSignalPayload(state, {
        event_type: 'subagent_ended',
      });
      bufferSignal(sessionKey, signal);
    }

    return {};
  });
}

// ─── subagent_delivery_target (GA B-3) ────────────────────────────────────────

/**
 * 하위 에이전트 결과 전달 대상 관찰 — Cross-Agent 통신 맵 구축.
 * 관찰 전용 — 차단 없음, 신호 버퍼링만.
 */
function registerSubagentDeliveryTarget(
  api: OpenClawPluginAPI,
  config: PMatrixConfig
): void {
  api.on('subagent_delivery_target', async (event, ctx) => {
    const sessionKey = resolveKey(ctx, event);
    if (!sessionKey) return {};

    const state = getSession(sessionKey);
    if (!state) return {};

    if (config.dataSharing) {
      const targetId = String(
        event['targetId'] ?? event['target_id'] ?? 'unknown'
      );
      const deliveryMode = String(
        event['deliveryMode'] ?? event['delivery_mode'] ?? 'unknown'
      );
      const signal = buildSignalPayload(state, {
        event_type: 'subagent_delivery_target',
        target_agent_id: targetId,
        delivery_mode: deliveryMode,
      });
      bufferSignal(sessionKey, signal);
    }

    return {};
  });
}

// ─── 내부 헬퍼 ────────────────────────────────────────────────────────────────

function resolveKey(
  ctx: HookContext,
  event: Record<string, unknown>
): string | null {
  // FIX #18: camelCase sessionKey fallback 추가 (message.ts와 통일)
  return (
    ctx.sessionKey ??
    (event['sessionKey'] as string | undefined) ??
    (event['sessionId'] as string | undefined) ??
    (event['session_id'] as string | undefined) ??
    null
  );
}
