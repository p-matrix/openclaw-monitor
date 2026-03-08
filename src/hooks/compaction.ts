// =============================================================================
// @pmatrix/openclaw-monitor — hooks/compaction.ts
// 컨텍스트 관리 훅 (분석서 §1-8, 신호 22~24):
//   before_compaction — 컨텍스트 윈도우 압축 직전 (norm+stability)
//   after_compaction  — 컨텍스트 윈도우 압축 완료 (NORM)
//   before_reset      — 세션 초기화 직전 (norm+stability)
//
// 설계 원칙:
//   - 로컬 이동 평균 없음 (서버가 inspect_signal_features 시계열에서 계산)
//   - 이벤트 빈도·압축률 원시값 전송 → 서버 stability/norm 분석
//   - dataSharing=false 시 신호 전송 없음 (로컬 카운팅도 없음)
// =============================================================================

import { OpenClawPluginAPI, PMatrixConfig, HookContext } from '../types';
import {
  getSession,
  getOrCreateSession,
  bufferSignal,
  buildSignalPayload,
} from '../session-state';

// ─── 등록 진입점 ──────────────────────────────────────────────────────────────

/**
 * 컨텍스트 관리 훅 일괄 등록
 * index.ts의 setup()에서 호출
 */
export function registerCompactionHooks(
  api: OpenClawPluginAPI,
  config: PMatrixConfig
): void {
  registerBeforeCompaction(api, config);
  registerAfterCompaction(api, config);
  registerBeforeReset(api, config);
}

// ─── before_compaction (§1-8 ㉒) ─────────────────────────────────────────────

/**
 * 컨텍스트 윈도우 압축 직전:
 *   NORM 축: compaction 발생 빈도 이동 평균 대비 편차
 *            잦은 compaction = 극도로 긴 컨텍스트 사용 신호 → 0.1 하락
 *   stability 축: 주간 compaction 횟수 장기 추세 → 0.1 상승
 *
 * 전송 필드: currentMessageCount, estimatedTokens
 * 서버가 시계열 집계 → 빈도 분석 (로컬 이동 평균 불필요)
 */
function registerBeforeCompaction(
  api: OpenClawPluginAPI,
  config: PMatrixConfig
): void {
  api.on('before_compaction', async (event, ctx) => {
    const sessionKey = resolveKey(ctx, event);
    if (!sessionKey) return {};

    const state = getOrCreateSession(sessionKey, config.agentId);

    if (!config.dataSharing) return {};

    const currentMessageCount = Number(
      event['currentMessageCount'] ?? event['current_message_count'] ?? 0
    );
    const estimatedTokens = Number(
      event['estimatedTokens'] ?? event['estimated_tokens'] ?? 0
    );

    const signal = buildSignalPayload(state, {
      event_type: 'before_compaction',
      current_message_count: currentMessageCount || undefined,
      estimated_tokens: estimatedTokens || undefined,
    });
    bufferSignal(sessionKey, signal);

    if (config.debug) {
      api.logger.debug(
        `[P-MATRIX] before_compaction: messages=${currentMessageCount}, ` +
          `tokens≈${estimatedTokens}`
      );
    }

    return {};
  });
}

// ─── after_compaction (§1-8 ㉓) ──────────────────────────────────────────────

/**
 * 컨텍스트 윈도우 압축 완료:
 *   NORM 축: 압축률(removedCount / total) 이동 평균 대비 편차
 *            극단적 압축(>80%) = 컨텍스트 과부하 신호
 *
 * 전송 필드: removedCount, retainedCount, compression_ratio
 * compression_ratio = removedCount / (removedCount + retainedCount), [0.0, 1.0]
 */
function registerAfterCompaction(
  api: OpenClawPluginAPI,
  config: PMatrixConfig
): void {
  api.on('after_compaction', async (event, ctx) => {
    const sessionKey = resolveKey(ctx, event);
    if (!sessionKey) return {};

    // before_compaction이 getOrCreate했으므로 getSession으로 조회
    const state = getSession(sessionKey);
    // FIX #34: before/after 사이에 세션이 삭제된 경우 debug 로그
    if (!state) {
      if (config.debug) {
        api.logger.debug(
          `[P-MATRIX] after_compaction: session not found (session=${sessionKey}) — skipped`
        );
      }
      return {};
    }

    if (!config.dataSharing) return {};

    const removedCount = Number(
      event['removedCount'] ?? event['removed_count'] ?? 0
    );
    const retainedCount = Number(
      event['retainedCount'] ?? event['retained_count'] ?? 0
    );
    const total = removedCount + retainedCount;

    // 압축률: 제거된 메시지 비율 (0.0 ~ 1.0)
    const compressionRatio =
      total > 0
        ? parseFloat((removedCount / total).toFixed(4))
        : 0;

    const signal = buildSignalPayload(state, {
      event_type: 'after_compaction',
      removed_count: removedCount || undefined,
      retained_count: retainedCount || undefined,
      compression_ratio: compressionRatio > 0 ? compressionRatio : undefined,
    });
    bufferSignal(sessionKey, signal);

    if (config.debug) {
      api.logger.debug(
        `[P-MATRIX] after_compaction: removed=${removedCount}, ` +
          `retained=${retainedCount}, ratio=${(compressionRatio * 100).toFixed(1)}%`
      );
    }

    return {};
  });
}

// ─── before_reset (§1-8 ㉔) ──────────────────────────────────────────────────

/**
 * 세션 초기화(메모리·컨텍스트 전체 삭제) 직전:
 *   NORM 축: reset 빈도 이동 평균 대비 편차. 빈번한 reset = 불안정 패턴 → 0.15 하락
 *   stability 축: 주간 reset 횟수 추세. 에이전트 지속성 하락 신호
 *
 * 전송 필드: reason
 */
function registerBeforeReset(
  api: OpenClawPluginAPI,
  config: PMatrixConfig
): void {
  api.on('before_reset', async (event, ctx) => {
    const sessionKey = resolveKey(ctx, event);
    if (!sessionKey) return {};

    const state = getSession(sessionKey);
    if (!state) return {};

    if (!config.dataSharing) return {};

    const reason = String(event['reason'] ?? 'unknown');

    const signal = buildSignalPayload(state, {
      event_type: 'before_reset',
      reset_reason: reason,
    });
    bufferSignal(sessionKey, signal);

    if (config.debug) {
      api.logger.debug(`[P-MATRIX] before_reset: reason=${reason}`);
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
