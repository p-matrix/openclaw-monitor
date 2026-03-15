// =============================================================================
// @pmatrix/openclaw-monitor — hooks/turn.ts  (GA B-4: 턴 경계 축 업데이트)
// 턴 경계 훅:
//   before_agent_start — 턴 시작 시각 기록, INIT 축 경계 신호 (baseline 스냅샷)
//   agent_end          — durationMs 계산, NORM 축 경계 신호, 4축 일괄 갱신
//
// 설계 원칙 (GA Dev Plan §2-3):
//   - 경계 훅(boundary hook): 측정 타이밍 결정 (before_agent_start, agent_end)
//   - 축 변화 훅(axis-change hook): 실제 축 값 이동 (tool, llm, message 등)
//   - 턴 경계 훅은 "축 스냅샷 전송" 역할 — 축 값 자체는 변경하지 않음
//
// 턴 단위 4축 일괄 갱신 구조:
//   before_agent_start: turnNumber++, turnStartedAt = now
//     → INIT 경계 신호 (현재 4축 스냅샷)
//   agent_end: durationMs = now - turnStartedAt
//     → NORM 경계 신호 (4축 + durationMs + turn_number)
// =============================================================================

import { OpenClawPluginAPI, PMatrixConfig, HookContext } from '../types';
import { PMatrixHttpClient } from '../client';
import type { FieldNode } from '@pmatrix/field-node-runtime';
import {
  getSession,
  getOrCreateSession,
  incrementTurnNumber,
  resetTurnAutonomy,
  bufferSignal,
  buildSignalPayload,
  captureTurnSnapshot,
  computeTurnDrift,
  applyStabilityDelta,
} from '../session-state';

// ─── 등록 진입점 ──────────────────────────────────────────────────────────────

export function registerTurnHooks(
  api: OpenClawPluginAPI,
  config: PMatrixConfig,
  client: PMatrixHttpClient,
  fieldNode?: FieldNode | null,
): void {
  registerBeforeAgentStart(api, config);
  registerAgentEnd(api, config, fieldNode);
}

// ─── before_agent_start ──────────────────────────────────────────────────────

/**
 * 에이전트 턴 시작 경계:
 *   1. turnNumber 증가
 *   2. turnStartedAt 기록 (agent_end에서 durationMs 계산)
 *   3. INIT 경계 신호 버퍼링 (현재 4축 스냅샷, dataSharing 동의 시)
 */
function registerBeforeAgentStart(
  api: OpenClawPluginAPI,
  config: PMatrixConfig
): void {
  api.on('before_agent_start', async (event, ctx) => {
    const sessionKey = resolveKey(ctx, event);
    if (!sessionKey) return {};

    // OC-2: sessionTarget 방어 — stale session에 대한 새 세션 생성 방지
    const sessionTarget = event['sessionTarget'] as string | undefined;
    if (sessionTarget && sessionTarget !== 'current') {
      const existing = getSession(sessionKey);
      if (!existing) return {};  // stale session → skip (오염 방지)
    }

    const state = getOrCreateSession(sessionKey, config.agentId);

    // 1. 턴 카운터 증가
    incrementTurnNumber(sessionKey);

    // 2. 자율성 추적 카운터 리셋 (B-5)
    resetTurnAutonomy(sessionKey);

    // 3. 턴 시작 시각 기록
    state.turnStartedAt = Date.now();

    // 4. INIT 경계 신호 (현재 4축 스냅샷) — dataSharing 동의 시에만
    if (config.dataSharing) {
      const signal = buildSignalPayload(state, {
        event_type: 'turn_start',
        turn_number: state.turnNumber,
      });
      bufferSignal(sessionKey, signal);
    }

    if (config.debug) {
      api.logger.debug(
        `[P-MATRIX] before_agent_start: turn=${state.turnNumber}, ` +
          `axes=[B=${state.axes.baseline.toFixed(2)}, N=${state.axes.norm.toFixed(2)}, ` +
          `S=${state.axes.stability.toFixed(2)}, M=${state.axes.meta_control.toFixed(2)}]`
      );
    }

    return {};
  });
}

// ─── agent_end ───────────────────────────────────────────────────────────────

/** Drift 감지 stability 증가 임계값 (moderate) */
const DRIFT_MODERATE_THRESHOLD = 0.5;
/** Drift 감지 stability 증가 임계값 (significant) */
const DRIFT_SIGNIFICANT_THRESHOLD = 1.0;
/** Moderate drift → stability +0.05 */
const DRIFT_MODERATE_DELTA = 0.05;
/** Significant drift → stability +0.10 */
const DRIFT_SIGNIFICANT_DELTA = 0.10;

/**
 * 에이전트 턴 종료 경계:
 *   1. durationMs 계산 (turnStartedAt → now)
 *   2. NORM 경계 신호 버퍼링 (4축 스냅샷 + durationMs, dataSharing 동의 시)
 *   3. 턴 스냅샷 캡처 + Drift 감지 (B-6)
 *   4. turnStartedAt 초기화
 */
function registerAgentEnd(
  api: OpenClawPluginAPI,
  config: PMatrixConfig,
  fieldNode?: FieldNode | null,
): void {
  api.on('agent_end', async (event, ctx) => {
    const sessionKey = resolveKey(ctx, event);
    if (!sessionKey) return {};

    const state = getSession(sessionKey);
    if (!state) return {};

    // 1. durationMs 계산
    const durationMs = state.turnStartedAt != null
      ? Date.now() - state.turnStartedAt
      : null;

    // 2. NORM 경계 신호 — dataSharing 동의 시에만
    if (config.dataSharing) {
      const signal = buildSignalPayload(state, {
        event_type: 'turn_end',
        turn_number: state.turnNumber,
        duration_ms: durationMs ?? undefined,
      });
      bufferSignal(sessionKey, signal);
    }

    // 3. 턴 스냅샷 캡처 + Drift 감지 (B-6)
    const safeDurationMs = durationMs ?? 0;
    const prevSnapshot = captureTurnSnapshot(sessionKey, safeDurationMs);

    if (prevSnapshot) {
      // 이전 턴이 존재 → drift score 계산
      const currentSnapshot = state.prevTurnSnapshot!; // captureTurnSnapshot이 방금 저장한 값
      const driftScore = computeTurnDrift(currentSnapshot, prevSnapshot);

      if (driftScore >= DRIFT_SIGNIFICANT_THRESHOLD) {
        // 심각한 drift → stability +0.10
        const updatedAxes = applyStabilityDelta(sessionKey, DRIFT_SIGNIFICANT_DELTA);
        if (config.dataSharing && updatedAxes) {
          const driftSignal = buildSignalPayload(state, {
            event_type: 'drift_detected',
            drift_score: Math.round(driftScore * 1000) / 1000,
            drift_level: 'significant',
            stability_delta: DRIFT_SIGNIFICANT_DELTA,
            turn_number: state.turnNumber,
          }, updatedAxes);
          bufferSignal(sessionKey, driftSignal);
        }

        if (config.debug) {
          api.logger.debug(
            `[P-MATRIX] Drift detected (significant): score=${driftScore.toFixed(3)}, ` +
              `stability +${DRIFT_SIGNIFICANT_DELTA}`
          );
        }
      } else if (driftScore >= DRIFT_MODERATE_THRESHOLD) {
        // 중간 drift → stability +0.05
        const updatedAxes = applyStabilityDelta(sessionKey, DRIFT_MODERATE_DELTA);
        if (config.dataSharing && updatedAxes) {
          const driftSignal = buildSignalPayload(state, {
            event_type: 'drift_detected',
            drift_score: Math.round(driftScore * 1000) / 1000,
            drift_level: 'moderate',
            stability_delta: DRIFT_MODERATE_DELTA,
            turn_number: state.turnNumber,
          }, updatedAxes);
          bufferSignal(sessionKey, driftSignal);
        }

        if (config.debug) {
          api.logger.debug(
            `[P-MATRIX] Drift detected (moderate): score=${driftScore.toFixed(3)}, ` +
              `stability +${DRIFT_MODERATE_DELTA}`
          );
        }
      }
    }

    // 4. 4.0 Field: State Vector 전송 (in-process, fail-open)
    if (fieldNode) {
      try {
        fieldNode.sendStateVector({
          baseline: state.axes.baseline,
          norm: state.axes.norm,
          stability: state.axes.stability,
          meta_control: state.axes.meta_control,
          loopCount: state.turnNumber,
          currentMode: state.currentMode,
        });
      } catch {
        // Fail-open: SV 전송 실패해도 턴 처리 계속
      }
    }

    // 5. turnStartedAt 초기화
    state.turnStartedAt = null;

    if (config.debug) {
      api.logger.debug(
        `[P-MATRIX] agent_end: turn=${state.turnNumber}, ` +
          `duration=${durationMs ?? '?'}ms, ` +
          `axes=[B=${state.axes.baseline.toFixed(2)}, N=${state.axes.norm.toFixed(2)}, ` +
          `S=${state.axes.stability.toFixed(2)}, M=${state.axes.meta_control.toFixed(2)}]`
      );
    }

    return {};
  });
}

// ─── 내부 헬퍼 ────────────────────────────────────────────────────────────────

function resolveKey(
  ctx: HookContext,
  event: Record<string, unknown>
): string | null {
  return (
    ctx.sessionKey ??
    (event['sessionKey'] as string | undefined) ??
    (event['sessionId'] as string | undefined) ??
    (event['session_id'] as string | undefined) ??
    // ACP Provenance fallback (upstream 2026-03-13)
    ((event['provenance'] as Record<string, unknown> | undefined)?.['sessionTraceId'] as string | undefined) ??
    null
  );
}
