// =============================================================================
// @pmatrix/openclaw-monitor — hooks/tool.ts
// 도구 호출 훅:
//   before_tool_call  — Safety Gate 핵심 (§5-2, §14-1, §14-2)
//   after_tool_call   — 실행 시간 추적 → NORM 이동 평균
//
// 핵심 안전 원칙:
//   §14-1: before_tool_call에 반드시 2,500ms 타임아웃 (fail-open)
//   §14-2: Halt/차단은 반드시 { block: true } 반환 — throw는 무시됨 (catchErrors: true)
//   §14-3: sessionKey 기반 세션 격리 필수
// =============================================================================

import {
  OpenClawPluginAPI,
  PMatrixConfig,
  HookContext,
  HookResult,
  SafetyMode,
} from '../types';
import { PMatrixHttpClient } from '../client';
import {
  getSession,
  getOrCreateSession,
  bufferSignal,
  buildSignalPayload,
  applyMetaControlDelta,
  applyNormDelta,
  haltSession,
  incrementSafetyGateBlocks,
  incrementDangerEvents,
  pushToolDuration,
  pushToolChain,
  CHAIN_RISK_NORM_DELTA,
} from '../session-state';
import {
  classifyToolRisk,
  evaluateSafetyGate,
  checkMetaControlRules,
  serializeParams,
  summarizeParams,
  rtToMode,
} from '../safety-gate';
import {
  formatGateBlock,
  formatGateConfirm,
  formatMetaControlBlock,
  formatHaltAuto,
} from '../ui/formatter';

// ─── 모듈 수준 도구 호출 시작 시각 추적 ──────────────────────────────────────

/** callId → { sessionKey, startedAt } — after_tool_call에서 duration 계산용 */
const pendingToolCalls = new Map<string, { sessionKey: string; startedAt: number }>();

// FIX #24: after_tool_call 미발화 시 Map 무한 증가 방지 TTL
const PENDING_TOOL_CALLS_TTL_MS = 5 * 60_000; // 5분

// ─── Safety Gate 서버 타임아웃 (§14-1) ───────────────────────────────────────

const SERVER_GATE_TIMEOUT_MS = 2_500;

// ─── CONFIRM 거부/타임아웃 meta_control 감점 ──────────────────────────────────

const GATE_DENIED_META_CONTROL_DELTA = -0.10;

// ─── 등록 진입점 ──────────────────────────────────────────────────────────────

export function registerToolHooks(
  api: OpenClawPluginAPI,
  config: PMatrixConfig,
  client: PMatrixHttpClient
): void {
  registerBeforeToolCall(api, config, client);
  registerAfterToolCall(api, config);
}

// ─── before_tool_call ─────────────────────────────────────────────────────────

function registerBeforeToolCall(
  api: OpenClawPluginAPI,
  config: PMatrixConfig,
  client: PMatrixHttpClient
): void {
  api.on(
    'before_tool_call',
    async (event, ctx): Promise<HookResult | void> => {
      const sessionKey = resolveKey(ctx, event);
      if (!sessionKey) return {};

      const toolName = String(event['toolName'] ?? event['tool_name'] ?? '');
      const params = event['params'] ?? event['arguments'] ?? null;
      const callId = String(event['callId'] ?? event['call_id'] ?? Date.now());

      // FIX #24: stale entry TTL sweep (after_tool_call 미발화 방지)
      if (pendingToolCalls.size > 0) {
        const _now = Date.now();
        for (const [_id, _entry] of pendingToolCalls.entries()) {
          if (_now - _entry.startedAt > PENDING_TOOL_CALLS_TTL_MS) {
            pendingToolCalls.delete(_id);
          }
        }
      }

      // 시작 시각 기록 (after_tool_call duration 계산용)
      pendingToolCalls.set(callId, { sessionKey, startedAt: Date.now() });

      const state = getOrCreateSession(sessionKey, config.agentId);

      // ── 1. Halt 상태 즉시 차단 (§14-2: throw 금지, block:true 필수) ────────
      if (state.isHalted) {
        pendingToolCalls.delete(callId);
        return {
          block: true,
          blockReason: `P-MATRIX Halt 상태. /pmatrix resume 으로 해제하세요.`,
        };
      }

      // ── 2. meta_control 특별 규칙 (R(t) 무관 즉시 차단) ───────────────────
      const mcBlock = checkMetaControlRules(toolName, params);
      if (mcBlock) {
        pendingToolCalls.delete(callId);

        // 로컬 axes 낙관적 업데이트
        const updatedAxes = applyMetaControlDelta(sessionKey, mcBlock.metaControlDelta);

        // 즉시 긴급 신호 전송 (retry 없음, fire-and-forget)
        if (config.dataSharing && updatedAxes) {
          const signal = buildSignalPayload(state, {
            event_type: 'meta_control_block',
            tool_name: toolName,
            meta_control_delta: mcBlock.metaControlDelta,
            priority: 'critical',
          }, updatedAxes);
          // FIX #32: Promise 오류 묵살 방지 — debug 로그
          void client.sendCritical(signal).catch((err: Error) => {
            if (config.debug) {
              api.logger.debug(`[P-MATRIX] sendCritical failed: ${err.message}`);
            }
          });
        }

        incrementDangerEvents(sessionKey);
        incrementSafetyGateBlocks(sessionKey);

        const msg = formatMetaControlBlock(toolName, mcBlock.reason, mcBlock.metaControlDelta);
        api.logger.warn(msg);

        return { block: true, blockReason: mcBlock.reason };
      }

      // ── 3. R(t) 기반 Safety Gate (타임아웃 2,500ms, fail-open §14-1) ──────
      const rt = state.currentRt;
      const toolRisk = classifyToolRisk(
        toolName,
        config.safetyGate.customToolRisk
      );

      // Safety Gate 비활성 설정 시 스킵
      if (!config.safetyGate.enabled) {
        bufferNormSignal(sessionKey, state.agentId, toolName, config);
        trackAutonomyEscalation(sessionKey, toolRisk, toolName, config, api, client);
        detectChainRisk(sessionKey, toolName, config, api);
        return {};
      }

      let gateResult: { action: 'ALLOW' | 'BLOCK' | 'CONFIRM'; reason: string };

      try {
        // NOTE §14-1 (Promise.race Placeholder):
        // evaluateSafetyGate()는 현재 로컬 캐시(state.currentRt) 기반 동기 계산이므로
        // Promise.resolve(...)는 항상 0ms에 완료되어 failOpenTimeout(2500)은
        // 실질적으로 dead code다.
        // 이 구조는 향후 evaluateSafetyGate를 원격 서버 판정(client.getAgentGrade() 등)으로
        // 교체할 때를 대비한 Placeholder다. 그 시점에 내부를 실제 비동기 호출로 교체할 것.
        // 현재 로컬 계산 유지 목적이라면: gateResult = evaluateSafetyGate(rt, toolRisk);
        gateResult = await Promise.race([
          Promise.resolve(evaluateSafetyGate(rt, toolRisk)),
          failOpenTimeout(SERVER_GATE_TIMEOUT_MS),
        ]);
      } catch {
        // 예외 발생 시 fail-open
        gateResult = { action: 'ALLOW', reason: '' };
      }

      const mode = rtToMode(rt);

      if (gateResult.action === 'BLOCK') {
        pendingToolCalls.delete(callId);
        incrementSafetyGateBlocks(sessionKey);
        incrementDangerEvents(sessionKey);

        // 차단 신호 버퍼링
        if (config.dataSharing) {
          const signal = buildSignalPayload(state, {
            event_type: 'safety_gate_block',
            tool_name: toolName,
            priority: 'critical',
          });
          // FIX #32: Promise 오류 묵살 방지 — debug 로그
          void client.sendCritical(signal).catch((err: Error) => {
            if (config.debug) {
              api.logger.debug(`[P-MATRIX] sendCritical failed: ${err.message}`);
            }
          });
        }

        const paramsSummary = summarizeParams(params);
        const msg = formatGateBlock(toolName, paramsSummary, rt, mode, gateResult.reason);
        api.logger.warn(msg);

        return { block: true, blockReason: gateResult.reason };
      }

      if (gateResult.action === 'CONFIRM') {
        const confirmResult = await requestUserConfirmation(
          sessionKey,
          toolName,
          params,
          rt,
          mode,
          gateResult.reason,
          api,
          config
        );

        if (confirmResult !== 'approved') {
          pendingToolCalls.delete(callId);
          incrementSafetyGateBlocks(sessionKey);
          incrementDangerEvents(sessionKey);

          // gate_denied / gate_timeout 긴급 신호 전송
          const eventType = confirmResult === 'timeout' ? 'gate_timeout' : 'gate_denied';
          if (config.dataSharing) {
            const updatedAxes = applyMetaControlDelta(sessionKey, GATE_DENIED_META_CONTROL_DELTA);
            if (updatedAxes) {
              const signal = buildSignalPayload(state, {
                event_type: eventType,
                tool_name: toolName,
                meta_control_delta: GATE_DENIED_META_CONTROL_DELTA,
                priority: 'critical',
              }, updatedAxes);
              void client.sendCritical(signal).catch((err: Error) => {
                if (config.debug) {
                  api.logger.debug(`[P-MATRIX] sendCritical failed: ${err.message}`);
                }
              });
            }
          }

          const blockReason = confirmResult === 'timeout'
            ? '확인 타임아웃 — 차단됨 (fail-closed)'
            : '사용자 거부 — 차단됨 (fail-closed)';
          return { block: true, blockReason };
        }

        // 사용자가 허용 → gate_override 이벤트 전송 (§12-4 A-5)
        if (config.dataSharing) {
          const signal = buildSignalPayload(state, {
            event_type: 'gate_override',
            tool_name: toolName,
            rt_at_override: rt,
            mode_at_override: mode,
          });
          bufferSignal(sessionKey, signal);
        }
      }

      // ── 4. 허용 — NORM 신호 버퍼링 ──────────────────────────────────────
      bufferNormSignal(sessionKey, state.agentId, toolName, config);

      // ── 5. 자율성 에스컬레이션 감지 (GA B-5) ──────────────────────────────
      trackAutonomyEscalation(sessionKey, toolRisk, toolName, config, api, client);

      // ── 6. 도구 체인 위험도 감지 (GA B-7) ──────────────────────────────────
      detectChainRisk(sessionKey, toolName, config, api);

      return {};
    }
  );
}

// ─── after_tool_call ──────────────────────────────────────────────────────────

function registerAfterToolCall(
  api: OpenClawPluginAPI,
  config: PMatrixConfig
): void {
  api.on('after_tool_call', async (event, ctx) => {
    const callId = String(event['callId'] ?? event['call_id'] ?? '');
    const pending = callId ? pendingToolCalls.get(callId) : undefined;

    if (pending) {
      pendingToolCalls.delete(callId);
      const durationMs = Date.now() - pending.startedAt;
      const toolName = String(event['toolName'] ?? event['tool_name'] ?? '');

      pushToolDuration(pending.sessionKey, toolName, durationMs);

      if (config.debug) {
        api.logger.debug(
          `[P-MATRIX] tool=${toolName} duration=${durationMs}ms`
        );
      }
    }
  });
}

// ─── 사용자 확인 대기 (CONFIRM 액션) ─────────────────────────────────────────

/**
 * Safety Gate CONFIRM 액션 — 채팅창에 확인 메시지 표시 후 응답 대기
 *
 * - 대기 시간: confirmTimeoutMs (기본 20,000ms)
 * - fail-closed: 타임아웃 시 false 반환 → 자동 차단
 * - /pmatrix allow once 명령으로 resolve(true) → 허용
 *
 * PendingConfirmation은 SessionState에 저장.
 * Week 4에서 registerCommand('pmatrix')에 allow once 처리 추가.
 */
async function requestUserConfirmation(
  sessionKey: string,
  toolName: string,
  params: unknown,
  rt: number,
  mode: SafetyMode,
  reason: string,
  api: OpenClawPluginAPI,
  config: PMatrixConfig
): Promise<'approved' | 'denied' | 'timeout'> {
  const state = getSession(sessionKey);
  if (!state) return 'denied';

  // 이미 확인 대기 중이면 차단 (중복 요청 방지)
  if (state.pendingConfirmation) {
    return 'denied';
  }

  const paramsSummary = summarizeParams(params);
  const timeoutSec = Math.round(config.safetyGate.confirmTimeoutMs / 1_000);
  const msg = formatGateConfirm(
    toolName,
    paramsSummary,
    rt,
    mode,
    reason,
    timeoutSec
  );

  // 채팅창에 확인 메시지 전송 (fire-and-forget)
  api.logger.warn(msg);

  return new Promise<'approved' | 'denied' | 'timeout'>((outerResolve) => {
    const timeoutHandle = setTimeout(() => {
      // fail-closed: 타임아웃 → gate_timeout
      if (state.pendingConfirmation) {
        state.pendingConfirmation = null;
      }
      outerResolve('timeout');
    }, config.safetyGate.confirmTimeoutMs);

    state.pendingConfirmation = {
      sessionKey,
      toolName,
      reason,
      resolve: (approved: boolean) => {
        clearTimeout(timeoutHandle);
        if (state.pendingConfirmation) {
          state.pendingConfirmation = null;
        }
        outerResolve(approved ? 'approved' : 'denied');
      },
      timeoutHandle,
    };
  });
}

// ─── 내부 헬퍼 ────────────────────────────────────────────────────────────────

/**
 * NORM 신호 버퍼링 (허용된 도구 호출)
 */
function bufferNormSignal(
  sessionKey: string,
  agentId: string,
  toolName: string,
  config: PMatrixConfig
): void {
  if (!config.dataSharing) return;
  const state = getSession(sessionKey);
  if (!state) return;

  const signal = buildSignalPayload(state, {
    event_type: 'tool_call',
    tool_name: toolName,
  });
  bufferSignal(sessionKey, signal);
}

// ─── 자율성 에스컬레이션 감지 (GA B-5) ──────────────────────────────────────

/** 연속 도구 호출 경고 임계값 */
const AUTONOMY_WARN_THRESHOLD = 3;
/** 연속 도구 호출 감점 임계값 */
const AUTONOMY_PENALTY_THRESHOLD = 5;
/** NORM 감점 폭 (5+ 연속) */
const AUTONOMY_NORM_DELTA = -0.10;
/** HIGH 위험 도구 비율 경고 임계값 */
const HIGH_RISK_RATIO_THRESHOLD = 0.6;

import type { ToolRiskTier } from '../types';

/**
 * ALLOW된 도구 호출에 대해 자율성 에스컬레이션 추적 (GA B-5)
 *
 * 규칙:
 *   1. 연속 3개 호출 → 경고 신호 (autonomy_warning)
 *   2. 연속 5개+ 호출 → NORM -0.10 감점 + 에스컬레이션 신호
 *   3. HIGH 위험 도구 비율 ≥ 60% (최소 3회) → 경고 신호
 */
function trackAutonomyEscalation(
  sessionKey: string,
  toolRisk: ToolRiskTier,
  toolName: string,
  config: PMatrixConfig,
  api: OpenClawPluginAPI,
  client: PMatrixHttpClient
): void {
  const state = getSession(sessionKey);
  if (!state) return;

  // 카운터 갱신
  state.consecutiveToolCalls++;
  state.turnToolCalls++;
  if (toolRisk === 'HIGH') {
    state.turnHighRiskCalls++;
  }

  const consecutive = state.consecutiveToolCalls;

  // ── 연속 5개+ → NORM 감점 ──────────────────────────────────────────────
  if (consecutive >= AUTONOMY_PENALTY_THRESHOLD && consecutive % AUTONOMY_PENALTY_THRESHOLD === 0) {
    // 5, 10, 15... 도달 시마다 NORM 감점 (반복 감점)
    const updatedAxes = applyNormDelta(sessionKey, AUTONOMY_NORM_DELTA);

    if (config.dataSharing && updatedAxes) {
      const signal = buildSignalPayload(state, {
        event_type: 'autonomy_escalation',
        tool_name: toolName,
        consecutive_tool_count: consecutive,
        autonomy_score: state.turnToolCalls > 0
          ? consecutive / state.turnToolCalls
          : 0,
        norm_delta: AUTONOMY_NORM_DELTA,
        priority: 'critical',
      }, updatedAxes);
      void client.sendCritical(signal).catch((err: Error) => {
        if (config.debug) {
          api.logger.debug(`[P-MATRIX] sendCritical failed: ${err.message}`);
        }
      });
    }

    incrementDangerEvents(sessionKey);

    api.logger.warn(
      `[P-MATRIX] Autonomy escalation: ${consecutive} consecutive tool calls — NORM ${AUTONOMY_NORM_DELTA}`
    );
  }
  // ── 연속 3개 → 경고 (감점 없음) ───────────────────────────────────────
  else if (consecutive === AUTONOMY_WARN_THRESHOLD) {
    if (config.dataSharing) {
      const signal = buildSignalPayload(state, {
        event_type: 'autonomy_warning',
        tool_name: toolName,
        consecutive_tool_count: consecutive,
      });
      bufferSignal(sessionKey, signal);
    }

    if (config.debug) {
      api.logger.debug(
        `[P-MATRIX] Autonomy warning: ${consecutive} consecutive tool calls`
      );
    }
  }

  // ── HIGH 위험 도구 비율 ≥ 60% (최소 3회) → 경고 ─────────────────────────
  if (
    state.turnToolCalls >= 3 &&
    state.turnHighRiskCalls / state.turnToolCalls >= HIGH_RISK_RATIO_THRESHOLD
  ) {
    // 턴당 1회만 버퍼링 (비율이 달성되는 최초 시점)
    if (state.turnHighRiskCalls === Math.ceil(state.turnToolCalls * HIGH_RISK_RATIO_THRESHOLD)) {
      if (config.dataSharing) {
        const signal = buildSignalPayload(state, {
          event_type: 'high_risk_ratio_warning',
          high_risk_ratio: state.turnHighRiskCalls / state.turnToolCalls,
          turn_tool_calls: state.turnToolCalls,
          turn_high_risk_calls: state.turnHighRiskCalls,
        });
        bufferSignal(sessionKey, signal);
      }

      if (config.debug) {
        api.logger.debug(
          `[P-MATRIX] HIGH risk ratio warning: ${state.turnHighRiskCalls}/${state.turnToolCalls} ` +
            `(${((state.turnHighRiskCalls / state.turnToolCalls) * 100).toFixed(0)}%)`
        );
      }
    }
  }
}

// ─── 도구 체인 위험도 감지 (GA B-7) ──────────────────────────────────────────

/**
 * 도구 호출 시퀀스에서 위험 체인 패턴 매칭 + NORM 감점
 *
 * 규칙:
 *   - 최근 5개 도구 호출 윈도우에서 서브시퀀스 패턴 매칭
 *   - 매칭 시 NORM -0.05 + chain_risk_detected 신호
 *   - 턴당 패턴별 1회만 감점 (중복 방지)
 */
function detectChainRisk(
  sessionKey: string,
  toolName: string,
  config: PMatrixConfig,
  api: OpenClawPluginAPI
): void {
  const matchedPattern = pushToolChain(sessionKey, toolName);
  if (!matchedPattern) return;

  // NORM 감점
  const updatedAxes = applyNormDelta(sessionKey, CHAIN_RISK_NORM_DELTA);

  // 신호 버퍼링 (dataSharing 동의 시)
  if (config.dataSharing && updatedAxes) {
    const state = getSession(sessionKey);
    if (state) {
      const signal = buildSignalPayload(state, {
        event_type: 'chain_risk_detected',
        tool_name: toolName,
        chain_pattern: matchedPattern.name,
        chain_description: matchedPattern.description,
        norm_delta: CHAIN_RISK_NORM_DELTA,
      }, updatedAxes);
      bufferSignal(sessionKey, signal);
    }
  }

  if (config.debug) {
    api.logger.debug(
      `[P-MATRIX] Chain risk detected: ${matchedPattern.name} (${matchedPattern.description}) — NORM ${CHAIN_RISK_NORM_DELTA}`
    );
  }

  api.logger.warn(
    `[P-MATRIX] Dangerous tool chain detected: ${matchedPattern.name} — NORM ${CHAIN_RISK_NORM_DELTA}`
  );
}

/**
 * Safety Gate 서버 타임아웃 — fail-open (§14-1)
 * 2,500ms 초과 시 ALLOW 반환 (서버 지연이 에이전트 전체를 막아서는 안 됨)
 */
function failOpenTimeout(
  ms: number
): Promise<{ action: 'ALLOW'; reason: string }> {
  return new Promise((resolve) =>
    setTimeout(() => resolve({ action: 'ALLOW', reason: '' }), ms)
  );
}

/**
 * sessionKey 해석 — ctx.sessionKey 우선 (§14-3)
 */
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
