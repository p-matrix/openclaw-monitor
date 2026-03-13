// =============================================================================
// drift.test.ts — GA B-6 Plugin-side Drift 신호 자가 검증
// =============================================================================
//
// 검증 범위:
//   computeTurnDrift (유닛):
//   1. 동일 스냅샷 → drift_score = 0
//   2. 도구 호출 수 편차 반영
//   3. HIGH 위험 비율 편차 반영
//   4. 소요 시간 편차 반영
//   5. 평균 출력 토큰 편차 반영
//   6. 큰 편차 → drift_score > 1.0
//
//   captureTurnSnapshot (유닛):
//   7. 첫 턴 → prevSnapshot null 반환 (비교 불가)
//   8. 두 번째 턴 → prevSnapshot 반환 (이전 턴)
//   9. 스냅샷에 정확한 메트릭 반영
//
//   applyStabilityDelta (유닛):
//  10. stability 증가 + R(t) 재계산
//  11. stability clamp [0, 1]
//
//   agent_end 통합:
//  12. 첫 턴 → drift 신호 없음 (이전 턴 없음)
//  13. 동일 행동 패턴 → drift 신호 없음
//  14. moderate drift (score >= 0.5) → stability +0.05 + drift_detected 신호
//  15. significant drift (score >= 1.0) → stability +0.10 + drift_detected 신호
//  16. dataSharing=false → stability 변경 적용, 신호 없음
// =============================================================================

import {
  sessions,
  createSession,
  applyStabilityDelta,
  captureTurnSnapshot,
  computeTurnDrift,
} from '../session-state';
import { registerTurnHooks } from '../hooks/turn';
import type { PMatrixConfig, OpenClawPluginAPI, TurnSnapshot } from '../types';

// ─── 헬퍼 ────────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<PMatrixConfig> = {}): PMatrixConfig {
  return {
    serverUrl: 'https://api.pmatrix.io',
    agentId: 'drift-agent',
    apiKey: 'test-key',
    safetyGate: { enabled: true, confirmTimeoutMs: 20_000, serverTimeoutMs: 2_500 },
    credentialProtection: { enabled: true, blockTranscript: false, customPatterns: [] },
    killSwitch: { autoHaltOnRt: 0.75, safeModel: 'claude-opus-4-6' },
    outboundAllowlist: { enabled: false, allowedChannels: [] },
    dataSharing: true,
    batch: { maxSize: 10, flushIntervalMs: 2_000, retryMax: 0 },
    debug: false,
    ...overrides,
  };
}

function setupTurnHooks(configOverrides: Partial<PMatrixConfig> = {}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hookHandlers: Record<string, any> = {};

  const api = {
    registerHook: jest.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on: jest.fn((name: string, fn: any) => {
      hookHandlers[name] = fn;
    }),
    registerCommand: jest.fn(),
    registerGatewayMethod: jest.fn(),
    registerService: jest.fn(),
    logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    },
  };

  const client = {
    sendCritical: jest.fn().mockResolvedValue(undefined),
    sendBatch: jest.fn().mockResolvedValue({ received: 1 }),
  };

  const config = makeConfig(configOverrides);
  registerTurnHooks(api as unknown as OpenClawPluginAPI, config, client as any);

  return { api, client, config, hookHandlers };
}

const SESSION_KEY = 'drift-test-session';

beforeEach(() => {
  sessions.clear();
});

// ─── computeTurnDrift 유닛 ───────────────────────────────────────────────────

describe('computeTurnDrift', () => {
  const baseline: TurnSnapshot = {
    toolCalls: 4,
    highRiskCalls: 1,
    durationMs: 2000,
    avgOutputTokens: 500,
  };

  it('1. 동일 스냅샷 → drift_score = 0', () => {
    expect(computeTurnDrift(baseline, baseline)).toBe(0);
  });

  it('2. 도구 호출 수 편차 반영', () => {
    const current: TurnSnapshot = { ...baseline, toolCalls: 8 };
    const drift = computeTurnDrift(current, baseline);
    // toolCalls: |8-4|/4 = 1.0, others ~0 → avg > 0
    expect(drift).toBeGreaterThan(0);
  });

  it('3. HIGH 위험 비율 편차 반영', () => {
    const current: TurnSnapshot = { ...baseline, highRiskCalls: 4 };
    // currRatio = 4/4 = 1.0, prevRatio = 1/4 = 0.25, diff = 0.75
    const drift = computeTurnDrift(current, baseline);
    expect(drift).toBeGreaterThan(0);
  });

  it('4. 소요 시간 편차 반영', () => {
    const current: TurnSnapshot = { ...baseline, durationMs: 10000 };
    const drift = computeTurnDrift(current, baseline);
    // |10000-2000|/2000 = 4.0
    expect(drift).toBeGreaterThan(0.5);
  });

  it('5. 평균 출력 토큰 편차 반영', () => {
    const current: TurnSnapshot = { ...baseline, avgOutputTokens: 2000 };
    const drift = computeTurnDrift(current, baseline);
    // |2000-500|/500 = 3.0
    expect(drift).toBeGreaterThan(0.5);
  });

  it('6. 큰 편차 → drift_score > 1.0', () => {
    const current: TurnSnapshot = {
      toolCalls: 20,
      highRiskCalls: 15,
      durationMs: 30000,
      avgOutputTokens: 5000,
    };
    const drift = computeTurnDrift(current, baseline);
    expect(drift).toBeGreaterThan(1.0);
  });
});

// ─── captureTurnSnapshot 유닛 ────────────────────────────────────────────────

describe('captureTurnSnapshot', () => {
  it('7. 첫 턴 → null 반환 (비교 불가)', () => {
    createSession(SESSION_KEY, 'drift-agent');
    const prev = captureTurnSnapshot(SESSION_KEY, 1000);
    expect(prev).toBeNull();
  });

  it('8. 두 번째 턴 → prevSnapshot 반환', () => {
    createSession(SESSION_KEY, 'drift-agent');
    captureTurnSnapshot(SESSION_KEY, 1000);
    const prev = captureTurnSnapshot(SESSION_KEY, 2000);
    expect(prev).not.toBeNull();
    expect(prev!.durationMs).toBe(1000);
  });

  it('9. 스냅샷에 정확한 메트릭 반영', () => {
    createSession(SESSION_KEY, 'drift-agent');
    const state = sessions.get(SESSION_KEY)!;
    state.turnToolCalls = 5;
    state.turnHighRiskCalls = 2;
    state.movingAvg.outputTokens = [100, 200, 300];

    captureTurnSnapshot(SESSION_KEY, 3000);

    expect(state.prevTurnSnapshot).not.toBeNull();
    expect(state.prevTurnSnapshot!.toolCalls).toBe(5);
    expect(state.prevTurnSnapshot!.highRiskCalls).toBe(2);
    expect(state.prevTurnSnapshot!.durationMs).toBe(3000);
    expect(state.prevTurnSnapshot!.avgOutputTokens).toBe(200);
  });
});

// ─── applyStabilityDelta 유닛 ────────────────────────────────────────────────

describe('applyStabilityDelta', () => {
  it('10. stability 증가 + R(t) 재계산', () => {
    createSession(SESSION_KEY, 'drift-agent');
    const state = sessions.get(SESSION_KEY)!;
    expect(state.axes.stability).toBe(0.0);

    const result = applyStabilityDelta(SESSION_KEY, 0.10);

    expect(result).not.toBeNull();
    expect(result!.stability).toBeCloseTo(0.10, 4);
    expect(state.axes.stability).toBeCloseTo(0.10, 4);
    // expected R(t) ≈ 0.025
    expect(state.currentRt).toBeCloseTo(0.025, 4);
  });

  it('11. stability clamp [0, 1]', () => {
    createSession(SESSION_KEY, 'drift-agent');
    applyStabilityDelta(SESSION_KEY, 1.5);
    const state = sessions.get(SESSION_KEY)!;
    expect(state.axes.stability).toBe(1.0);
  });
});

// ─── agent_end Drift 통합 ────────────────────────────────────────────────────

describe('agent_end Drift 감지', () => {
  it('12. 첫 턴 → drift 신호 없음', async () => {
    const { hookHandlers } = setupTurnHooks({ dataSharing: true });
    createSession(SESSION_KEY, 'drift-agent');

    // 턴 1
    await hookHandlers['before_agent_start']({}, { sessionKey: SESSION_KEY });
    const state = sessions.get(SESSION_KEY)!;
    state.turnStartedAt = Date.now() - 1000;
    await hookHandlers['agent_end']({}, { sessionKey: SESSION_KEY });

    const driftSignals = state.signalBuffer.filter(
      (s: any) => s.metadata.event_type === 'drift_detected'
    );
    expect(driftSignals).toHaveLength(0);
    expect(state.axes.stability).toBe(0.0); // 변화 없음
  });

  it('13. 동일 행동 패턴 → drift 신호 없음', async () => {
    const { hookHandlers } = setupTurnHooks({ dataSharing: true });
    createSession(SESSION_KEY, 'drift-agent');

    // 턴 1
    await hookHandlers['before_agent_start']({}, { sessionKey: SESSION_KEY });
    const state = sessions.get(SESSION_KEY)!;
    state.turnStartedAt = Date.now() - 1000;
    state.turnToolCalls = 3;
    state.turnHighRiskCalls = 1;
    await hookHandlers['agent_end']({}, { sessionKey: SESSION_KEY });

    // 턴 2 — 동일 패턴
    await hookHandlers['before_agent_start']({}, { sessionKey: SESSION_KEY });
    state.turnStartedAt = Date.now() - 1000;
    state.turnToolCalls = 3;
    state.turnHighRiskCalls = 1;
    await hookHandlers['agent_end']({}, { sessionKey: SESSION_KEY });

    const driftSignals = state.signalBuffer.filter(
      (s: any) => s.metadata.event_type === 'drift_detected'
    );
    expect(driftSignals).toHaveLength(0);
    expect(state.axes.stability).toBe(0.0);
  });

  it('14. moderate drift → stability +0.05 + drift_detected 신호', async () => {
    const { hookHandlers } = setupTurnHooks({ dataSharing: true });
    createSession(SESSION_KEY, 'drift-agent');

    // 턴 1: 기준선
    await hookHandlers['before_agent_start']({}, { sessionKey: SESSION_KEY });
    const state = sessions.get(SESSION_KEY)!;
    state.turnStartedAt = Date.now() - 1000;
    state.turnToolCalls = 4;
    state.turnHighRiskCalls = 1;
    state.movingAvg.outputTokens = [500];
    await hookHandlers['agent_end']({}, { sessionKey: SESSION_KEY });

    // 턴 2: 큰 변화 (moderate drift)
    await hookHandlers['before_agent_start']({}, { sessionKey: SESSION_KEY });
    state.turnStartedAt = Date.now() - 3000; // 3x duration
    state.turnToolCalls = 8;  // 2x tools
    state.turnHighRiskCalls = 1;
    state.movingAvg.outputTokens = [500]; // same
    await hookHandlers['agent_end']({}, { sessionKey: SESSION_KEY });

    const driftSignals = state.signalBuffer.filter(
      (s: any) => s.metadata.event_type === 'drift_detected'
    );
    expect(driftSignals.length).toBeGreaterThanOrEqual(1);
    expect(state.axes.stability).toBeGreaterThan(0.0);
  });

  it('15. significant drift → stability +0.10 + drift_detected 신호', async () => {
    const { hookHandlers } = setupTurnHooks({ dataSharing: true });
    createSession(SESSION_KEY, 'drift-agent');

    // 턴 1: 기준선
    await hookHandlers['before_agent_start']({}, { sessionKey: SESSION_KEY });
    const state = sessions.get(SESSION_KEY)!;
    state.turnStartedAt = Date.now() - 1000;
    state.turnToolCalls = 2;
    state.turnHighRiskCalls = 0;
    state.movingAvg.outputTokens = [100];
    await hookHandlers['agent_end']({}, { sessionKey: SESSION_KEY });

    // 턴 2: 극적 변화 (significant drift)
    await hookHandlers['before_agent_start']({}, { sessionKey: SESSION_KEY });
    state.turnStartedAt = Date.now() - 20000; // 20x duration
    state.turnToolCalls = 20; // 10x tools
    state.turnHighRiskCalls = 15;
    state.movingAvg.outputTokens = [5000]; // 50x tokens
    await hookHandlers['agent_end']({}, { sessionKey: SESSION_KEY });

    const driftSignals = state.signalBuffer.filter(
      (s: any) => s.metadata.event_type === 'drift_detected'
    );
    expect(driftSignals.length).toBeGreaterThanOrEqual(1);
    const lastDrift = driftSignals[driftSignals.length - 1]!;
    expect(lastDrift.metadata.drift_level).toBe('significant');
    expect(lastDrift.metadata.stability_delta).toBe(0.10);
    expect(state.axes.stability).toBeCloseTo(0.10, 4);
  });

  it('16. dataSharing=false → stability 변경, 신호 없음', async () => {
    const { hookHandlers } = setupTurnHooks({ dataSharing: false });
    createSession(SESSION_KEY, 'drift-agent');

    // 턴 1
    await hookHandlers['before_agent_start']({}, { sessionKey: SESSION_KEY });
    const state = sessions.get(SESSION_KEY)!;
    state.turnStartedAt = Date.now() - 1000;
    state.turnToolCalls = 2;
    state.movingAvg.outputTokens = [100];
    await hookHandlers['agent_end']({}, { sessionKey: SESSION_KEY });

    // 턴 2: 극적 변화
    await hookHandlers['before_agent_start']({}, { sessionKey: SESSION_KEY });
    state.turnStartedAt = Date.now() - 20000;
    state.turnToolCalls = 20;
    state.turnHighRiskCalls = 15;
    state.movingAvg.outputTokens = [5000];
    await hookHandlers['agent_end']({}, { sessionKey: SESSION_KEY });

    // stability는 변경됨 (로컬 계산)
    expect(state.axes.stability).toBeGreaterThan(0.0);
    // 신호 없음
    expect(state.signalBuffer).toHaveLength(0);
  });
});
