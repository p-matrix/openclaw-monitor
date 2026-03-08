// =============================================================================
// autonomy.test.ts — GA B-5 자율성 에스컬레이션 감지 자가 검증
// =============================================================================
//
// 검증 범위:
//   1. 턴 시작 시 자율성 카운터 리셋 (before_agent_start → resetTurnAutonomy)
//   2. ALLOW된 도구 호출 → consecutiveToolCalls 증가
//   3. HIGH 위험 도구 → turnHighRiskCalls 증가
//   4. 연속 3개 → 'autonomy_warning' 신호 버퍼링
//   5. 연속 5개 → NORM -0.10 감점 + 'autonomy_escalation' 신호 (sendCritical)
//   6. 연속 10개 → 2번째 NORM 감점 (반복 감점)
//   7. dataSharing=false → 감점은 적용, 신호 없음
//   8. HIGH 위험 비율 ≥ 60% (최소 3회) → 'high_risk_ratio_warning' 신호
//   9. 턴 경계에서 카운터 리셋 확인
//  10. applyNormDelta → axes.norm 감소 + R(t) 재계산
// =============================================================================

import { sessions, createSession, applyNormDelta, resetTurnAutonomy, computeLocalRt } from '../session-state';
import { registerToolHooks } from '../hooks/tool';
import { registerTurnHooks } from '../hooks/turn';
import type { PMatrixConfig, OpenClawPluginAPI } from '../types';

// ─── 헬퍼 ────────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<PMatrixConfig> = {}): PMatrixConfig {
  return {
    serverUrl: 'https://api.pmatrix.io',
    agentId: 'autonomy-agent',
    apiKey: 'test-key',
    safetyGate: { enabled: false, confirmTimeoutMs: 20_000, serverTimeoutMs: 2_500 },
    credentialProtection: { enabled: false, blockTranscript: false, customPatterns: [] },
    killSwitch: { autoHaltOnRt: 0.75, safeModel: 'claude-opus-4-6' },
    outboundAllowlist: { enabled: false, allowedChannels: [] },
    dataSharing: true,
    batch: { maxSize: 10, flushIntervalMs: 2_000, retryMax: 0 },
    debug: false,
    ...overrides,
  };
}

function setupHooks(configOverrides: Partial<PMatrixConfig> = {}) {
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
    flush: jest.fn().mockResolvedValue(undefined),
    healthCheck: jest.fn().mockResolvedValue({ healthy: true, grade: null }),
    sendSessionSummary: jest.fn().mockResolvedValue(undefined),
  };

  const config = makeConfig(configOverrides);
  registerToolHooks(api as unknown as OpenClawPluginAPI, config, client as any);
  registerTurnHooks(api as unknown as OpenClawPluginAPI, config, client as any);

  return { api, client, config, hookHandlers };
}

const SESSION_KEY = 'autonomy-test-session';

beforeEach(() => {
  sessions.clear();
});

// ─── applyNormDelta 유닛 ─────────────────────────────────────────────────────

describe('applyNormDelta', () => {
  it('10. norm 감소 + R(t) 재계산', () => {
    createSession(SESSION_KEY, 'autonomy-agent');
    const state = sessions.get(SESSION_KEY)!;
    expect(state.axes.norm).toBe(1.0);

    const result = applyNormDelta(SESSION_KEY, -0.10);

    expect(result).not.toBeNull();
    expect(result!.norm).toBeCloseTo(0.9, 4);
    expect(state.axes.norm).toBeCloseTo(0.9, 4);
    // R(t) = 1 - (1.0 + 0.9 + (1-0) + 1.0) / 4 = 1 - 3.9/4 = 1 - 0.975 = 0.025
    expect(state.currentRt).toBeCloseTo(0.025, 4);
  });

  it('10b. norm 0 이하로 내려가지 않음 (clamp)', () => {
    createSession(SESSION_KEY, 'autonomy-agent');
    applyNormDelta(SESSION_KEY, -1.5);
    const state = sessions.get(SESSION_KEY)!;
    expect(state.axes.norm).toBe(0.0);
  });

  it('10c. sessionKey 없으면 null 반환', () => {
    const result = applyNormDelta('nonexistent', -0.10);
    expect(result).toBeNull();
  });
});

// ─── resetTurnAutonomy 유닛 ──────────────────────────────────────────────────

describe('resetTurnAutonomy', () => {
  it('1. 카운터 리셋', () => {
    createSession(SESSION_KEY, 'autonomy-agent');
    const state = sessions.get(SESSION_KEY)!;
    state.consecutiveToolCalls = 5;
    state.turnToolCalls = 8;
    state.turnHighRiskCalls = 3;

    resetTurnAutonomy(SESSION_KEY);

    expect(state.consecutiveToolCalls).toBe(0);
    expect(state.turnToolCalls).toBe(0);
    expect(state.turnHighRiskCalls).toBe(0);
  });
});

// ─── 자율성 에스컬레이션 통합 테스트 ─────────────────────────────────────────

describe('자율성 에스컬레이션 감지', () => {
  /** ALLOW되는 도구 호출 이벤트 헬퍼 */
  async function callTool(
    hookHandlers: Record<string, any>,
    toolName = 'bash',
    sessionKey = SESSION_KEY
  ) {
    await hookHandlers['before_tool_call'](
      { toolName, callId: `call-${Date.now()}-${Math.random()}` },
      { sessionKey }
    );
  }

  it('2. ALLOW된 도구 호출 → consecutiveToolCalls 증가', async () => {
    const { hookHandlers } = setupHooks();
    createSession(SESSION_KEY, 'autonomy-agent');

    await callTool(hookHandlers, 'read');
    const state = sessions.get(SESSION_KEY)!;
    expect(state.consecutiveToolCalls).toBe(1);
    expect(state.turnToolCalls).toBe(1);
  });

  it('3. HIGH 위험 도구 → turnHighRiskCalls 증가', async () => {
    const { hookHandlers } = setupHooks();
    createSession(SESSION_KEY, 'autonomy-agent');

    await callTool(hookHandlers, 'bash');  // HIGH
    await callTool(hookHandlers, 'read');  // LOW
    await callTool(hookHandlers, 'exec');  // HIGH

    const state = sessions.get(SESSION_KEY)!;
    expect(state.turnToolCalls).toBe(3);
    expect(state.turnHighRiskCalls).toBe(2);
  });

  it('4. 연속 3개 → autonomy_warning 신호 버퍼링', async () => {
    const { hookHandlers } = setupHooks({ dataSharing: true });
    createSession(SESSION_KEY, 'autonomy-agent');

    await callTool(hookHandlers, 'read');
    await callTool(hookHandlers, 'read');
    await callTool(hookHandlers, 'read');

    const state = sessions.get(SESSION_KEY)!;
    // tool_call 신호 3개 + autonomy_warning 1개 = 4개
    const warningSignals = state.signalBuffer.filter(
      s => s.metadata.event_type === 'autonomy_warning'
    );
    expect(warningSignals).toHaveLength(1);
    expect(warningSignals[0]!.metadata.consecutive_tool_count).toBe(3);
  });

  it('5. 연속 5개 → NORM -0.10 감점 + autonomy_escalation', async () => {
    const { hookHandlers, client } = setupHooks({ dataSharing: true });
    createSession(SESSION_KEY, 'autonomy-agent');

    for (let i = 0; i < 5; i++) {
      await callTool(hookHandlers, 'read');
    }

    const state = sessions.get(SESSION_KEY)!;
    expect(state.axes.norm).toBeCloseTo(0.9, 4);  // 1.0 - 0.10
    expect(state.consecutiveToolCalls).toBe(5);
    expect(client.sendCritical).toHaveBeenCalled();

    const criticalCall = client.sendCritical.mock.calls[0]![0];
    expect(criticalCall.metadata.event_type).toBe('autonomy_escalation');
    expect(criticalCall.metadata.norm_delta).toBe(-0.10);
    expect(criticalCall.metadata.consecutive_tool_count).toBe(5);
  });

  it('6. 연속 10개 → 2번째 NORM 감점', async () => {
    const { hookHandlers, client } = setupHooks({ dataSharing: true });
    createSession(SESSION_KEY, 'autonomy-agent');

    for (let i = 0; i < 10; i++) {
      await callTool(hookHandlers, 'read');
    }

    const state = sessions.get(SESSION_KEY)!;
    expect(state.axes.norm).toBeCloseTo(0.8, 4);  // 1.0 - 0.10 - 0.10
    expect(state.consecutiveToolCalls).toBe(10);
    // sendCritical 2번 호출 (5th, 10th)
    expect(client.sendCritical).toHaveBeenCalledTimes(2);
  });

  it('7. dataSharing=false → NORM 감점 적용, 신호 없음', async () => {
    const { hookHandlers, client } = setupHooks({ dataSharing: false });
    createSession(SESSION_KEY, 'autonomy-agent');

    for (let i = 0; i < 5; i++) {
      await callTool(hookHandlers, 'read');
    }

    const state = sessions.get(SESSION_KEY)!;
    expect(state.axes.norm).toBeCloseTo(0.9, 4);  // 감점은 적용
    expect(client.sendCritical).not.toHaveBeenCalled();  // 신호 없음
    expect(state.signalBuffer).toHaveLength(0);  // 버퍼도 비어 있음
  });

  it('8. HIGH 위험 비율 ≥ 60% (최소 3회) → high_risk_ratio_warning 신호', async () => {
    const { hookHandlers } = setupHooks({ dataSharing: true });
    createSession(SESSION_KEY, 'autonomy-agent');

    // 3개 중 2개 HIGH = 66.7%
    await callTool(hookHandlers, 'bash');   // HIGH
    await callTool(hookHandlers, 'exec');   // HIGH
    await callTool(hookHandlers, 'read');   // LOW

    const state = sessions.get(SESSION_KEY)!;
    const ratioWarnings = state.signalBuffer.filter(
      s => s.metadata.event_type === 'high_risk_ratio_warning'
    );
    expect(ratioWarnings.length).toBeGreaterThanOrEqual(1);
  });

  it('9. 턴 경계에서 카운터 리셋', async () => {
    const { hookHandlers } = setupHooks({ dataSharing: true });
    createSession(SESSION_KEY, 'autonomy-agent');

    // 턴 1: 4개 호출
    await hookHandlers['before_agent_start']({}, { sessionKey: SESSION_KEY });
    for (let i = 0; i < 4; i++) {
      await callTool(hookHandlers, 'read');
    }
    const state = sessions.get(SESSION_KEY)!;
    expect(state.consecutiveToolCalls).toBe(4);

    // 턴 2 시작 → 카운터 리셋
    await hookHandlers['before_agent_start']({}, { sessionKey: SESSION_KEY });
    expect(state.consecutiveToolCalls).toBe(0);
    expect(state.turnToolCalls).toBe(0);
    expect(state.turnHighRiskCalls).toBe(0);
  });
});
