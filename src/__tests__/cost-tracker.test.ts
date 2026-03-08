// =============================================================================
// cost-tracker.test.ts — cost-tracker.ts 자가 검증 (Tier-2 §A-2)
// =============================================================================
//
// 검증 범위:
//   1. accumulateTokens: 기본 누적
//   2. accumulateTokens: 여러 번 호출 시 합산됨
//   3. accumulateTokens: 음수 값 → 0으로 처리 (방어 로직)
//   4. accumulateTokens: 세션 미존재 → 조용히 무시 (크래시 없음)
//   5. getTokenTotals: 초기값 { inputTokens: 0, outputTokens: 0 }
//   6. getTokenTotals: 누적 후 올바른 값 반환
//   7. getTokenTotals: 세션 미존재 → null 반환
//   8. getCostSummaryMetadata: total_input_tokens, total_output_tokens 키 포함
//   9. getCostSummaryMetadata: 세션 미존재 → null 반환
//  10. getTotalTokenCount: 입력 + 출력 합산
//  11. getTotalTokenCount: 세션 미존재 → null 반환
//  12. 세션 독립성: 다른 sessionKey는 서로 영향 없음
// =============================================================================

import { sessions, createSession } from '../session-state';
import {
  accumulateTokens,
  getTokenTotals,
  getCostSummaryMetadata,
  getTotalTokenCount,
} from '../cost-tracker';

beforeEach(() => {
  sessions.clear();
  jest.clearAllMocks();
});

// =============================================================================
// 1~4. accumulateTokens
// =============================================================================

describe('accumulateTokens', () => {

  test('기본 누적 — input + output 각각 SessionState에 더해짐', () => {
    const state = createSession('cost-1', 'agent-cost');

    accumulateTokens('cost-1', 500, 200);

    expect(state.totalInputTokens).toBe(500);
    expect(state.totalOutputTokens).toBe(200);
  });

  test('여러 번 호출 시 합산됨', () => {
    const state = createSession('cost-2', 'agent-cost');

    accumulateTokens('cost-2', 300, 100);
    accumulateTokens('cost-2', 400, 150);
    accumulateTokens('cost-2', 200, 50);

    expect(state.totalInputTokens).toBe(900);
    expect(state.totalOutputTokens).toBe(300);
  });

  test('음수 값 → 0으로 처리 (방어 로직)', () => {
    const state = createSession('cost-3', 'agent-cost');
    state.totalInputTokens = 100;
    state.totalOutputTokens = 50;

    accumulateTokens('cost-3', -50, -20);  // 음수

    // 음수는 0으로 처리되므로 기존 값 유지
    expect(state.totalInputTokens).toBe(100);
    expect(state.totalOutputTokens).toBe(50);
  });

  test('세션 미존재 → 조용히 무시 (크래시 없음)', () => {
    expect(() => {
      accumulateTokens('ghost-session', 100, 50);
    }).not.toThrow();
  });

});

// =============================================================================
// 5~7. getTokenTotals
// =============================================================================

describe('getTokenTotals', () => {

  test('초기값 — { inputTokens: 0, outputTokens: 0 }', () => {
    createSession('cost-gt-1', 'agent-cost');

    const totals = getTokenTotals('cost-gt-1');

    expect(totals).not.toBeNull();
    expect(totals!.inputTokens).toBe(0);
    expect(totals!.outputTokens).toBe(0);
  });

  test('누적 후 올바른 값 반환', () => {
    createSession('cost-gt-2', 'agent-cost');
    accumulateTokens('cost-gt-2', 1000, 400);
    accumulateTokens('cost-gt-2', 200, 80);

    const totals = getTokenTotals('cost-gt-2');

    expect(totals!.inputTokens).toBe(1200);
    expect(totals!.outputTokens).toBe(480);
  });

  test('세션 미존재 → null 반환', () => {
    const totals = getTokenTotals('nonexistent');
    expect(totals).toBeNull();
  });

});

// =============================================================================
// 8~9. getCostSummaryMetadata
// =============================================================================

describe('getCostSummaryMetadata', () => {

  test('total_input_tokens, total_output_tokens 키 포함됨', () => {
    createSession('cost-meta-1', 'agent-cost');
    accumulateTokens('cost-meta-1', 700, 300);

    const meta = getCostSummaryMetadata('cost-meta-1');

    expect(meta).not.toBeNull();
    expect(meta!.total_input_tokens).toBe(700);
    expect(meta!.total_output_tokens).toBe(300);
    // cost_usd 없음 (서버 pricing.py 담당)
    expect(meta).not.toHaveProperty('cost_usd');
  });

  test('세션 미존재 → null 반환', () => {
    const meta = getCostSummaryMetadata('ghost');
    expect(meta).toBeNull();
  });

});

// =============================================================================
// 10~11. getTotalTokenCount
// =============================================================================

describe('getTotalTokenCount', () => {

  test('입력 + 출력 합산 반환', () => {
    createSession('cost-total-1', 'agent-cost');
    accumulateTokens('cost-total-1', 600, 250);

    expect(getTotalTokenCount('cost-total-1')).toBe(850);
  });

  test('세션 미존재 → null 반환', () => {
    expect(getTotalTokenCount('ghost')).toBeNull();
  });

});

// =============================================================================
// 12. 세션 독립성
// =============================================================================

describe('세션 독립성', () => {

  test('다른 sessionKey는 서로 영향 없음', () => {
    createSession('sess-A', 'agent-a');
    createSession('sess-B', 'agent-b');

    accumulateTokens('sess-A', 1000, 400);
    accumulateTokens('sess-B', 200, 80);

    const totalsA = getTokenTotals('sess-A');
    const totalsB = getTokenTotals('sess-B');

    expect(totalsA!.inputTokens).toBe(1000);
    expect(totalsA!.outputTokens).toBe(400);
    expect(totalsB!.inputTokens).toBe(200);
    expect(totalsB!.outputTokens).toBe(80);
  });

});
