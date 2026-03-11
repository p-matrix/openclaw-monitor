// =============================================================================
// turn-hook.test.ts — registerTurnHooks 자가 검증 (GA B-4: 턴 경계 축 업데이트)
// =============================================================================
//
// 검증 범위:
//   1. registerTurnHooks → before_agent_start + agent_end 2개 훅 등록
//
//   before_agent_start:
//   2. turnNumber 증가
//   3. turnStartedAt 기록 (Date.now() ms)
//   4. dataSharing=true → 'turn_start' 신호 버퍼링
//   5. dataSharing=false → turnNumber 증가만, 신호 없음
//   6. sessionKey 없음 → {} 즉시 반환
//
//   agent_end:
//   7. durationMs 계산 (turnStartedAt → now)
//   8. dataSharing=true → 'turn_end' 신호 버퍼링 (durationMs 포함)
//   9. turnStartedAt null 리셋
//  10. dataSharing=false → 신호 없음, turnStartedAt 리셋만
//  11. sessionKey 없음 → {} 즉시 반환
//  12. turnStartedAt null → durationMs undefined (크래시 없음)
//
//   통합:
//  13. before_agent_start → agent_end 순서 → 정상 durationMs
//  14. 연속 2턴 → turnNumber 2, 각각 독립 durationMs
// =============================================================================

import { sessions, createSession } from '../session-state';
import { registerTurnHooks } from '../hooks/turn';
import type { PMatrixConfig, OpenClawPluginAPI } from '../types';

// ─── 헬퍼 ────────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<PMatrixConfig> = {}): PMatrixConfig {
  return {
    serverUrl: 'https://api.pmatrix.io',
    agentId: 'turn-agent',
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

const SESSION_KEY = 'turn-test-session';

beforeEach(() => {
  sessions.clear();
});

// ─── 1. 등록 ────────────────────────────────────────────────────────────────

describe('registerTurnHooks', () => {
  it('1. before_agent_start + agent_end 2개 훅 등록', () => {
    const { api } = setupTurnHooks();
    const names = api.on.mock.calls.map((c: any) => c[0]);
    expect(names).toContain('before_agent_start');
    expect(names).toContain('agent_end');
    expect(api.on).toHaveBeenCalledTimes(2);
  });
});

// ─── before_agent_start ──────────────────────────────────────────────────────

describe('before_agent_start', () => {
  it('2. turnNumber 증가', async () => {
    const { hookHandlers } = setupTurnHooks();
    createSession(SESSION_KEY, 'turn-agent');
    const state = sessions.get(SESSION_KEY)!;
    expect(state.turnNumber).toBe(0);

    await hookHandlers['before_agent_start']({}, { sessionKey: SESSION_KEY });
    expect(state.turnNumber).toBe(1);
  });

  it('3. turnStartedAt 기록', async () => {
    const { hookHandlers } = setupTurnHooks();
    createSession(SESSION_KEY, 'turn-agent');
    const state = sessions.get(SESSION_KEY)!;
    expect(state.turnStartedAt).toBeNull();

    const before = Date.now();
    await hookHandlers['before_agent_start']({}, { sessionKey: SESSION_KEY });
    const after = Date.now();

    expect(state.turnStartedAt).toBeGreaterThanOrEqual(before);
    expect(state.turnStartedAt).toBeLessThanOrEqual(after);
  });

  it('4. dataSharing=true → turn_start 신호 버퍼링', async () => {
    const { hookHandlers } = setupTurnHooks({ dataSharing: true });
    createSession(SESSION_KEY, 'turn-agent');

    await hookHandlers['before_agent_start']({}, { sessionKey: SESSION_KEY });

    const state = sessions.get(SESSION_KEY)!;
    expect(state.signalBuffer).toHaveLength(1);
    const signal = state.signalBuffer[0]!;
    expect(signal.metadata.event_type).toBe('turn_start');
    expect(signal.metadata.turn_number).toBe(1);
    expect(signal.agent_id).toBe('turn-agent');
    expect(signal.signal_source).toBe('adapter_stream');
    expect(signal.framework).toBe('openclaw');
  });

  it('5. dataSharing=false → 신호 없음, turnNumber는 증가', async () => {
    const { hookHandlers } = setupTurnHooks({ dataSharing: false });
    createSession(SESSION_KEY, 'turn-agent');

    await hookHandlers['before_agent_start']({}, { sessionKey: SESSION_KEY });

    const state = sessions.get(SESSION_KEY)!;
    expect(state.turnNumber).toBe(1);
    expect(state.turnStartedAt).not.toBeNull();
    expect(state.signalBuffer).toHaveLength(0);
  });

  it('6. sessionKey 없음 → {} 반환', async () => {
    const { hookHandlers } = setupTurnHooks();
    const result = await hookHandlers['before_agent_start']({}, {});
    expect(result).toEqual({});
  });
});

// ─── agent_end ───────────────────────────────────────────────────────────────

describe('agent_end', () => {
  it('7. durationMs 계산', async () => {
    const { hookHandlers } = setupTurnHooks();
    createSession(SESSION_KEY, 'turn-agent');
    const state = sessions.get(SESSION_KEY)!;

    // 시작 시각 시뮬레이션
    state.turnStartedAt = Date.now() - 500;

    await hookHandlers['agent_end']({}, { sessionKey: SESSION_KEY });

    const signal = state.signalBuffer[0]!;
    expect(signal.metadata.duration_ms).toBeGreaterThanOrEqual(500);
    expect(signal.metadata.duration_ms).toBeLessThan(1000);
  });

  it('8. dataSharing=true → turn_end 신호 버퍼링', async () => {
    const { hookHandlers } = setupTurnHooks({ dataSharing: true });
    createSession(SESSION_KEY, 'turn-agent');
    const state = sessions.get(SESSION_KEY)!;
    state.turnNumber = 3;
    state.turnStartedAt = Date.now() - 100;

    await hookHandlers['agent_end']({}, { sessionKey: SESSION_KEY });

    expect(state.signalBuffer).toHaveLength(1);
    const signal = state.signalBuffer[0]!;
    expect(signal.metadata.event_type).toBe('turn_end');
    expect(signal.metadata.turn_number).toBe(3);
    expect(signal.metadata.duration_ms).toBeDefined();
  });

  it('9. turnStartedAt null 리셋', async () => {
    const { hookHandlers } = setupTurnHooks();
    createSession(SESSION_KEY, 'turn-agent');
    const state = sessions.get(SESSION_KEY)!;
    state.turnStartedAt = Date.now();

    await hookHandlers['agent_end']({}, { sessionKey: SESSION_KEY });
    expect(state.turnStartedAt).toBeNull();
  });

  it('10. dataSharing=false → 신호 없음, turnStartedAt 리셋', async () => {
    const { hookHandlers } = setupTurnHooks({ dataSharing: false });
    createSession(SESSION_KEY, 'turn-agent');
    const state = sessions.get(SESSION_KEY)!;
    state.turnStartedAt = Date.now();

    await hookHandlers['agent_end']({}, { sessionKey: SESSION_KEY });

    expect(state.turnStartedAt).toBeNull();
    expect(state.signalBuffer).toHaveLength(0);
  });

  it('11. sessionKey 없음 → {} 반환', async () => {
    const { hookHandlers } = setupTurnHooks();
    const result = await hookHandlers['agent_end']({}, {});
    expect(result).toEqual({});
  });

  it('12. turnStartedAt null → duration_ms undefined (크래시 없음)', async () => {
    const { hookHandlers } = setupTurnHooks();
    createSession(SESSION_KEY, 'turn-agent');
    const state = sessions.get(SESSION_KEY)!;
    state.turnStartedAt = null;

    await hookHandlers['agent_end']({}, { sessionKey: SESSION_KEY });

    const signal = state.signalBuffer[0]!;
    expect(signal.metadata.duration_ms).toBeUndefined();
  });
});

// ─── 통합 시나리오 ───────────────────────────────────────────────────────────

describe('턴 경계 통합', () => {
  it('13. before_agent_start → agent_end 순서 → 정상 durationMs', async () => {
    const { hookHandlers } = setupTurnHooks();
    createSession(SESSION_KEY, 'turn-agent');

    await hookHandlers['before_agent_start']({}, { sessionKey: SESSION_KEY });

    // 약간의 시간 경과 시뮬레이션
    const state = sessions.get(SESSION_KEY)!;
    state.turnStartedAt = Date.now() - 200;

    await hookHandlers['agent_end']({}, { sessionKey: SESSION_KEY });

    // turn_start + turn_end = 2개 신호
    expect(state.signalBuffer).toHaveLength(2);
    expect(state.signalBuffer[0]!.metadata.event_type).toBe('turn_start');
    expect(state.signalBuffer[1]!.metadata.event_type).toBe('turn_end');
    expect(state.signalBuffer[1]!.metadata.duration_ms).toBeGreaterThanOrEqual(200);
  });

  it('14. 연속 2턴 → turnNumber 2, 독립 durationMs', async () => {
    const { hookHandlers } = setupTurnHooks();
    createSession(SESSION_KEY, 'turn-agent');

    // 턴 1
    await hookHandlers['before_agent_start']({}, { sessionKey: SESSION_KEY });
    const state = sessions.get(SESSION_KEY)!;
    state.turnStartedAt = Date.now() - 100;
    await hookHandlers['agent_end']({}, { sessionKey: SESSION_KEY });

    // 턴 2
    await hookHandlers['before_agent_start']({}, { sessionKey: SESSION_KEY });
    state.turnStartedAt = Date.now() - 300;
    await hookHandlers['agent_end']({}, { sessionKey: SESSION_KEY });

    expect(state.turnNumber).toBe(2);
    // 4개 경계 신호 + drift_detected 가능 (B-6: 턴 간 durationMs 편차)
    expect(state.signalBuffer.length).toBeGreaterThanOrEqual(4);
    expect(state.signalBuffer[1]!.metadata.duration_ms).toBeGreaterThanOrEqual(100);
    expect(state.signalBuffer[3]!.metadata.duration_ms).toBeGreaterThanOrEqual(300);
  });

  it('15. 4축 스냅샷이 신호에 정확히 반영됨', async () => {
    const { hookHandlers } = setupTurnHooks();
    createSession(SESSION_KEY, 'turn-agent');
    const state = sessions.get(SESSION_KEY)!;

    // 축 값 수정 (다른 훅에서 변경된 상태 시뮬레이션)
    state.axes.baseline = 0.9;
    state.axes.norm = 0.8;
    state.axes.stability = 0.1;
    state.axes.meta_control = 0.7;

    await hookHandlers['before_agent_start']({}, { sessionKey: SESSION_KEY });

    const signal = state.signalBuffer[0]!;
    expect(signal.baseline).toBe(0.9);
    expect(signal.norm).toBe(0.8);
    expect(signal.stability).toBe(0.1);
    expect(signal.meta_control).toBe(0.7);
  });
});
