// =============================================================================
// @pmatrix/openclaw-monitor — extensions/gateway-methods.ts
// Gateway RPC 메서드 (§9-4):
//   pmatrix.status — 세션 상태 JSON 반환 (LLM 미경유, 0ms 응답)
// =============================================================================

import { OpenClawPluginAPI, PMatrixConfig, SessionState } from '../types';
import { PMatrixHttpClient } from '../client';
import { getSession, sessions } from '../session-state';

// ─── 등록 진입점 ──────────────────────────────────────────────────────────────

export function registerGatewayMethods(
  api: OpenClawPluginAPI,
  config: PMatrixConfig,
  client: PMatrixHttpClient
): void {
  registerPMatrixStatus(api, config, client);
}

// ─── pmatrix.status ───────────────────────────────────────────────────────────

/**
 * pmatrix.status RPC 메서드 (§9-4)
 *
 * 파라미터:
 *   params.sessionKey — 특정 세션 조회 (없으면 전체 세션 목록 반환)
 *
 * 반환:
 *   단일 세션: { sessionKey, agentId, grade, rt, mode, axes, isHalted, ... }
 *   전체 목록: { sessions: [...], count: N }
 *
 * 외부 자동화(CI/CD, 대시보드)에서 LLM 호출 없이 즉각 응답.
 */
function registerPMatrixStatus(
  api: OpenClawPluginAPI,
  config: PMatrixConfig,
  _client: PMatrixHttpClient
): void {
  api.registerGatewayMethod('pmatrix.status', async (params) => {
    const sessionKey =
      typeof params['sessionKey'] === 'string' ? params['sessionKey'] : null;

    if (sessionKey) {
      const state = getSession(sessionKey);
      if (!state) {
        return { error: 'session_not_found', sessionKey };
      }
      if (config.debug) {
        api.logger.debug(
          `[P-MATRIX] pmatrix.status RPC: session=${sessionKey}`
        );
      }
      return serializeState(sessionKey, state);
    }

    // 전체 세션 목록
    const all: unknown[] = [];
    for (const [key, state] of sessions.entries()) {
      all.push(serializeState(key, state));
    }

    if (config.debug) {
      api.logger.debug(
        `[P-MATRIX] pmatrix.status RPC: ${all.length} sessions`
      );
    }

    return { sessions: all, count: all.length };
  });
}

// ─── 내부 헬퍼 ────────────────────────────────────────────────────────────────

function serializeState(sessionKey: string, state: SessionState): unknown {
  return {
    sessionKey,
    agentId: state.agentId,
    grade: state.grade,
    pScore: state.pScore,
    rt: state.currentRt,
    mode: state.currentMode,
    axes: { ...state.axes },
    isHalted: state.isHalted,
    haltReason: state.haltReason ?? null,
    turnNumber: state.turnNumber,
    dangerEvents: state.dangerEvents,
    credentialBlocks: state.credentialBlocks,
    safetyGateBlocks: state.safetyGateBlocks,
    bufferSize: state.signalBuffer.length,
    startedAt: state.startedAt.toISOString(),
    channel: state.channel,
  };
}
