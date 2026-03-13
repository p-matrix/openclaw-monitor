// =============================================================================
// @pmatrix/openclaw-monitor — hooks/session.ts
// Gateway 및 세션 라이프사이클 훅:
//   gateway_start  — 서버 연결 확인, 초기 Grade 캐싱, 시작 알림
//   gateway_stop   — 정리 메시지
//   session_start  — SessionState 초기화
//   session_end    — 미전송 신호 플러시, 세션 요약 전송, 상태 삭제
// =============================================================================

import {
  OpenClawPluginAPI,
  PMatrixConfig,
} from '../types';
import { PMatrixHttpClient } from '../client';
import {
  getOrCreateSession,
  getSession,
  deleteSession,
  popBuffer,
  updateRtCache,
  pendingChildLinks,
  sweepStalePendingLinks,
} from '../session-state';

// ─── 등록 진입점 ──────────────────────────────────────────────────────────────

/**
 * 세션 관련 훅 일괄 등록
 * index.ts의 setup()에서 호출
 */
export function registerSessionHooks(
  api: OpenClawPluginAPI,
  config: PMatrixConfig,
  client: PMatrixHttpClient
): void {
  registerGatewayStart(api, config, client);
  registerGatewayStop(api, config);
  registerSessionStart(api, config);
  registerSessionEnd(api, config, client);
}

// ─── gateway_start ────────────────────────────────────────────────────────────

/**
 * Gateway 시작 시 (§5-1):
 *   1. 서버 healthCheck (fail-open — 실패해도 계속 동작)
 *   2. 초기 Grade/R(t) 캐싱 (있으면)
 *   3. 시작 알림 출력
 *   4. 설정 누락 경고
 */
function registerGatewayStart(
  api: OpenClawPluginAPI,
  config: PMatrixConfig,
  client: PMatrixHttpClient
): void {
  api.on('gateway_start', async () => {
    api.logger.info('[P-MATRIX] Monitor starting...');

    const { healthy, grade } = await client.healthCheck();

    // 초기 Grade를 세션-독립 전역 캐시에 임시 보관
    // (세션 시작 전이므로 실제 세션 키가 없음 — 세션 생성 시 갱신)
    if (healthy && grade) {
      // gateway_start에서 얻은 Grade는 첫 세션 생성 시 적용됨
      // 여기서는 로그만 출력
    }

    const statusIcon = healthy ? '✅' : '⚠️ offline';
    const gradeStr = grade
      ? `Grade ${grade.grade} / R(t): ${grade.risk.toFixed(2)}`
      : '연결 중...';

    // §9-5 Gateway 시작 시 초기 알림 형식
    api.logger.info(
      `[P-MATRIX Monitor v0.3.0]\n` +
        `  서버: ${config.serverUrl} ${statusIcon}\n` +
        `  에이전트: ${config.agentId || '(미설정)'}\n` +
        `  Grade: ${gradeStr}\n` +
        `  Safety Gate: ${config.safetyGate.enabled ? '활성' : '비활성'}\n` +
        `  크레덴셜 보호: ${config.credentialProtection.enabled ? '활성' : '비활성'}`
    );

    // 설정 누락 경고
    if (!config.apiKey) {
      api.logger.warn(
        '[P-MATRIX] ⚠️  API 키 미설정 — PMATRIX_API_KEY 환경변수를 설정하세요.'
      );
    }
    if (!config.agentId) {
      api.logger.warn(
        '[P-MATRIX] ⚠️  Agent ID 미설정 — openclaw.json의 pmatrix.agentId를 설정하세요.'
      );
    }
    if (!config.dataSharing) {
      api.logger.warn(
        '[P-MATRIX] ⚠️  데이터 공유 미동의 — Safety Gate 로컬 전용 동작 중. ' +
          '`openclaw pmatrix setup` 실행 후 동의하세요.'
      );
    }
  });
}

// ─── gateway_stop ─────────────────────────────────────────────────────────────

function registerGatewayStop(
  api: OpenClawPluginAPI,
  config: PMatrixConfig
): void {
  api.on('gateway_stop', async () => {
    // [Tier-2 §A-1] 플러그인 레벨 종료 → pendingChildLinks 전체 정리
    // gateway_stop = 플러그인 프로세스 종료 (세션 레벨 아님) → .clear() 올바름
    pendingChildLinks.clear();

    if (config.debug) {
      api.logger.debug('[P-MATRIX] Gateway 종료.');
    }
    api.logger.info('[P-MATRIX] Monitor stopped.');
  });
}

// ─── session_start ────────────────────────────────────────────────────────────

/**
 * 유저 세션 시작 시 SessionState 초기화
 * agentId / channel은 event 필드에서 읽거나 config 기본값 사용
 */
function registerSessionStart(
  api: OpenClawPluginAPI,
  config: PMatrixConfig
): void {
  api.on('session_start', async (event, ctx) => {
    if (config.debug) {
      api.logger.info('[P-MATRIX] session_start hook FIRED');
    }
    const sessionKey = resolveSessionKey(ctx, event);
    if (!sessionKey) return;

    // FIX #67: P-MATRIX agentId는 항상 config에서 사용.
    // OpenClaw event의 agentId는 내부 식별자("a" 등)로, P-MATRIX agent_id와 다름.
    const pmatrixAgentId = config.agentId;

    // OpenClaw 내부 agentId — Sub-Agent 트리 매칭용 (pendingChildLinks)
    const openclawAgentId =
      (event['agentId'] as string | undefined) ??
      (event['agent_id'] as string | undefined) ??
      config.agentId;

    const channel =
      (event['channel'] as string | undefined) ?? 'unknown';

    // [Tier-2 §A-1] TTL sweep — session_start에서도 수행 (커버리지 향상)
    // subagent_spawning 없이 시간이 지난 stale entries 정리
    sweepStalePendingLinks();

    const state = getOrCreateSession(sessionKey, pmatrixAgentId, channel);

    // [Tier-2 §A-1] pendingChildLinks 조회 → Sub-Agent 트리 depth 초기화
    // subagent_spawning이 이미 발화했다면 부모가 등록해 둔 link를 소비
    const link = pendingChildLinks.get(openclawAgentId);
    if (link) {
      state.parentAgentId = link.parentAgentId;
      state.agentDepth = link.depth;
      pendingChildLinks.delete(openclawAgentId);  // consume — 중복 소비 방지
    }
    // link 없으면 root agent → agentDepth=0, parentAgentId=null 유지 (초기값)

    if (config.debug) {
      const depthStr = state.agentDepth > 0
        ? ` depth=${state.agentDepth} parent=${state.parentAgentId}`
        : ' (root)';
      api.logger.info(
        `[P-MATRIX] Session started: ${sessionKey} (agent: ${state.agentId}, channel: ${channel}${depthStr})`
      );
    }
  });
}

// ─── session_end ──────────────────────────────────────────────────────────────

/**
 * 세션 종료 시 (§5-7):
 *   1. 버퍼 잔여 신호 플러시
 *   2. 세션 요약 전송 (dataSharing 동의 시)
 *   3. SessionState 삭제
 */
function registerSessionEnd(
  api: OpenClawPluginAPI,
  config: PMatrixConfig,
  client: PMatrixHttpClient
): void {
  api.on('session_end', async (event, ctx) => {
    const sessionKey = resolveSessionKey(ctx, event);
    if (!sessionKey) return;

    const state = getSession(sessionKey);

    // 1. 미전송 신호 플러시
    const remaining = popBuffer(sessionKey);
    if (remaining.length > 0) {
      await client.flush(remaining, { priority: 'session_end' });
    }

    // 2. 세션 요약 전송 (dataSharing 동의 후에만)
    if (state && config.dataSharing) {
      await client.sendSessionSummary({
        sessionId: sessionKey,
        agentId: state.agentId,
        totalTurns: state.turnNumber,
        dangerEvents: state.dangerEvents,
        credentialBlocks: state.credentialBlocks,
        safetyGateBlocks: state.safetyGateBlocks,
        endReason: event['reason'] as string | undefined,
        signal_source: 'adapter_stream',
        framework: 'openclaw',
        framework_tag: config.frameworkTag ?? 'stable',
      });
    }

    // 3. 상태 삭제 (deleteSession 내부에서 pendingConfirmation 정리)
    deleteSession(sessionKey);

    if (config.debug) {
      const summary = state
        ? `turns=${state.turnNumber}, dangers=${state.dangerEvents}, ` +
          `credBlocks=${state.credentialBlocks}, gateBlocks=${state.safetyGateBlocks}`
        : '(no state)';
      api.logger.debug(`[P-MATRIX] Session ended: ${sessionKey} — ${summary}`);
    }
  });
}

// ─── 유틸 ─────────────────────────────────────────────────────────────────────

/**
 * sessionKey 해석 — ctx.sessionKey 우선, 없으면 event.sessionId
 * 일관된 키 사용이 세션 격리의 핵심 (§14-3)
 */
function resolveSessionKey(
  ctx: { sessionKey?: string },
  event: Record<string, unknown>
): string | null {
  const key =
    ctx.sessionKey ??
    (event['sessionId'] as string | undefined) ??
    (event['session_id'] as string | undefined);

  return key ?? null;
}
