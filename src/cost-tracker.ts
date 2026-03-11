// =============================================================================
// @pmatrix/openclaw-monitor — cost-tracker.ts (Tier-2 §A-2)
// 세션별 토큰 누적 추적기
//
// 설계 원칙 (v2.4 확정):
//   ① 플러그인은 토큰 수만 누적한다. cost_usd 계산은 서버 pricing.py 담당.
//   ② 서버가 llm_model + input_tokens + output_tokens → cost_usd 계산.
//   ③ SessionState.totalInputTokens / totalOutputTokens에 직접 쓰기.
//      (세션 종료 시 session-state.deleteSession()이 정리 — 별도 cleanup 불필요)
//   ④ dataSharing 여부 무관하게 로컬 누적 수행 (Safety Gate 판단에도 활용 가능).
//
// 사용 패턴:
//   hooks/llm.ts — llm_output Hook에서 accumulateTokens() 호출
//   extensions/commands.ts — /pmatrix status 명령에서 getTokenTotals() 조회
// =============================================================================

import { sessions } from './session-state';

// ─── 공개 API ────────────────────────────────────────────────────────────────

/**
 * 세션 누적 토큰 추가
 *
 * llm_output Hook에서 호출.
 * 음수 값은 0으로 처리 (잘못된 이벤트 데이터 방어).
 *
 * @param sessionKey  세션 격리 키
 * @param inputTokens LLM 입력 토큰 수 (usage.input)
 * @param outputTokens LLM 출력 토큰 수 (usage.output)
 */
export function accumulateTokens(
  sessionKey: string,
  inputTokens: number,
  outputTokens: number
): void {
  const state = sessions.get(sessionKey);
  if (!state) return;

  state.totalInputTokens += Math.max(0, inputTokens);
  state.totalOutputTokens += Math.max(0, outputTokens);
}

/**
 * 세션 누적 토큰 조회
 *
 * @returns { inputTokens, outputTokens } 또는 null (세션 미존재)
 */
export function getTokenTotals(
  sessionKey: string
): { inputTokens: number; outputTokens: number } | null {
  const state = sessions.get(sessionKey);
  if (!state) return null;
  return {
    inputTokens: state.totalInputTokens,
    outputTokens: state.totalOutputTokens,
  };
}

/**
 * 세션 비용 요약 (signal metadata / /pmatrix status 출력용)
 *
 * cost_usd 계산 없음 — 서버 pricing.py 담당.
 * 토큰 수만 반환하여 서버가 단가 적용 후 cost 계산.
 *
 * @returns metadata 삽입용 객체 또는 null (세션 미존재)
 */
export function getCostSummaryMetadata(
  sessionKey: string
): { total_input_tokens: number; total_output_tokens: number } | null {
  const state = sessions.get(sessionKey);
  if (!state) return null;
  return {
    total_input_tokens: state.totalInputTokens,
    total_output_tokens: state.totalOutputTokens,
  };
}

/**
 * 세션 토큰 총합 (입력 + 출력)
 * Safety Gate 판단 또는 요약 표시용
 *
 * @returns 총 토큰 수 또는 null (세션 미존재)
 */
export function getTotalTokenCount(sessionKey: string): number | null {
  const state = sessions.get(sessionKey);
  if (!state) return null;
  return state.totalInputTokens + state.totalOutputTokens;
}
