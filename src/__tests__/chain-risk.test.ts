// =============================================================================
// chain-risk.test.ts — GA B-7 도구 체인 위험도 자가 검증
// =============================================================================
//
// 검증 범위:
//   classifyToolCategory (유닛):
//   1. READ 도구 분류 (read, grep, glob, cat 등)
//   2. WRITE 도구 분류 (edit, write, apply_patch)
//   3. EXEC 도구 분류 (bash, exec, shell 등)
//   4. OTHER 도구 분류 (unknown, web_fetch 등)
//
//   pushToolChain (유닛):
//   5. 첫 호출 → 패턴 미매칭 (시퀀스 부족)
//   6. read → edit → bash → read_write_exec 패턴 매칭
//   7. read → bash → read_exec 패턴 매칭
//   8. edit → bash → write_exec 패턴 매칭
//   9. 동일 패턴 2회 → 1회만 반환 (중복 방지)
//  10. OTHER 도구 → 윈도우에 추가되지 않음
//  11. 윈도우 크기 5 초과 → 오래된 항목 드롭
//  12. 비연속 서브시퀀스 매칭 (read → OTHER → edit → OTHER → bash)
//
//   before_tool_call 통합:
//  13. read → edit → bash 체인 → NORM -0.05 + chain_risk_detected 신호
//  14. 패턴 미매칭 → NORM 변화 없음
//  15. dataSharing=false → NORM 감점 적용, 신호 없음
//  16. 턴 리셋 후 체인 초기화 확인
// =============================================================================

import {
  sessions,
  createSession,
  resetTurnAutonomy,
  pushToolChain,
  classifyToolCategory,
  CHAIN_RISK_NORM_DELTA,
} from '../session-state';
import { registerToolHooks } from '../hooks/tool';
import type { PMatrixConfig, OpenClawPluginAPI } from '../types';

// ─── 헬퍼 ────────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<PMatrixConfig> = {}): PMatrixConfig {
  return {
    serverUrl: 'https://api.pmatrix.io',
    agentId: 'chain-agent',
    apiKey: 'test-key',
    safetyGate: { enabled: false, confirmTimeoutMs: 20_000, serverTimeoutMs: 2_500 },
    credentialProtection: { enabled: true, blockTranscript: false, customPatterns: [] },
    killSwitch: { autoHaltOnRt: 0.75, safeModel: 'claude-opus-4-6' },
    outboundAllowlist: { enabled: false, allowedChannels: [] },
    dataSharing: true,
    batch: { maxSize: 10, flushIntervalMs: 2_000, retryMax: 0 },
    debug: false,
    ...overrides,
  };
}

function setupToolHooks(configOverrides: Partial<PMatrixConfig> = {}) {
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
  registerToolHooks(api as unknown as OpenClawPluginAPI, config, client as any);

  return { api, client, config, hookHandlers };
}

const SESSION_KEY = 'chain-test-session';

beforeEach(() => {
  sessions.clear();
});

// ─── classifyToolCategory 유닛 ──────────────────────────────────────────────

describe('classifyToolCategory', () => {
  it('1. READ 도구 분류', () => {
    expect(classifyToolCategory('read')).toBe('READ');
    expect(classifyToolCategory('Read')).toBe('READ');
    expect(classifyToolCategory('grep')).toBe('READ');
    expect(classifyToolCategory('glob')).toBe('READ');
    expect(classifyToolCategory('cat')).toBe('READ');
    expect(classifyToolCategory('find')).toBe('READ');
    expect(classifyToolCategory('search')).toBe('READ');
    expect(classifyToolCategory('list_files')).toBe('READ');
    expect(classifyToolCategory('head')).toBe('READ');
    expect(classifyToolCategory('tail')).toBe('READ');
    expect(classifyToolCategory('ls')).toBe('READ');
    expect(classifyToolCategory('file_read')).toBe('READ');
  });

  it('2. WRITE 도구 분류', () => {
    expect(classifyToolCategory('edit')).toBe('WRITE');
    expect(classifyToolCategory('Edit')).toBe('WRITE');
    expect(classifyToolCategory('write')).toBe('WRITE');
    expect(classifyToolCategory('Write')).toBe('WRITE');
    expect(classifyToolCategory('apply_patch')).toBe('WRITE');
  });

  it('3. EXEC 도구 분류', () => {
    expect(classifyToolCategory('bash')).toBe('EXEC');
    expect(classifyToolCategory('Bash')).toBe('EXEC');
    expect(classifyToolCategory('exec')).toBe('EXEC');
    expect(classifyToolCategory('shell')).toBe('EXEC');
    expect(classifyToolCategory('run')).toBe('EXEC');
    expect(classifyToolCategory('terminal')).toBe('EXEC');
    expect(classifyToolCategory('code_interpreter')).toBe('EXEC');
  });

  it('4. OTHER 도구 분류', () => {
    expect(classifyToolCategory('web_fetch')).toBe('OTHER');
    expect(classifyToolCategory('unknown_tool')).toBe('OTHER');
    expect(classifyToolCategory('browser')).toBe('OTHER');
    expect(classifyToolCategory('pmatrix_status')).toBe('OTHER');
  });
});

// ─── pushToolChain 유닛 ─────────────────────────────────────────────────────

describe('pushToolChain', () => {
  it('5. 첫 호출 → 패턴 미매칭', () => {
    createSession(SESSION_KEY, 'chain-agent');
    const result = pushToolChain(SESSION_KEY, 'read');
    expect(result).toBeNull();
  });

  it('6. read → edit → bash → read_write_exec 패턴 매칭', () => {
    createSession(SESSION_KEY, 'chain-agent');
    expect(pushToolChain(SESSION_KEY, 'read')).toBeNull();
    expect(pushToolChain(SESSION_KEY, 'edit')).toBeNull();
    const result = pushToolChain(SESSION_KEY, 'bash');
    expect(result).not.toBeNull();
    expect(result!.name).toBe('read_write_exec');
  });

  it('7. read → bash → read_exec 패턴 매칭', () => {
    createSession(SESSION_KEY, 'chain-agent');
    expect(pushToolChain(SESSION_KEY, 'read')).toBeNull();
    const result = pushToolChain(SESSION_KEY, 'bash');
    expect(result).not.toBeNull();
    expect(result!.name).toBe('read_exec');
  });

  it('8. edit → bash → write_exec 패턴 매칭', () => {
    createSession(SESSION_KEY, 'chain-agent');
    expect(pushToolChain(SESSION_KEY, 'edit')).toBeNull();
    const result = pushToolChain(SESSION_KEY, 'bash');
    expect(result).not.toBeNull();
    expect(result!.name).toBe('write_exec');
  });

  it('9. 동일 패턴 2회 → 1회만 반환 (중복 방지)', () => {
    createSession(SESSION_KEY, 'chain-agent');
    pushToolChain(SESSION_KEY, 'read');
    pushToolChain(SESSION_KEY, 'bash'); // read_exec 매칭

    // 같은 패턴 다시 시도
    pushToolChain(SESSION_KEY, 'read');
    const result = pushToolChain(SESSION_KEY, 'bash');
    // read_exec는 이미 감지됨 → null
    // 하지만 write_exec 같은 다른 패턴은 매칭 가능
    // read → bash → read → bash 에서 두 번째 read_exec는 null
    expect(result).toBeNull();
  });

  it('10. OTHER 도구 → 윈도우에 추가되지 않음', () => {
    createSession(SESSION_KEY, 'chain-agent');
    const result = pushToolChain(SESSION_KEY, 'web_fetch');
    expect(result).toBeNull();
    const state = sessions.get(SESSION_KEY)!;
    expect(state.recentToolChain).toHaveLength(0);
  });

  it('11. 윈도우 크기 5 초과 → 오래된 항목 드롭', () => {
    createSession(SESSION_KEY, 'chain-agent');
    // 6개 호출 → 윈도우에 5개만 유지
    pushToolChain(SESSION_KEY, 'read');
    pushToolChain(SESSION_KEY, 'read');
    pushToolChain(SESSION_KEY, 'read');
    pushToolChain(SESSION_KEY, 'read');
    pushToolChain(SESSION_KEY, 'read');
    pushToolChain(SESSION_KEY, 'read'); // 6번째 → 첫 번째 드롭

    const state = sessions.get(SESSION_KEY)!;
    expect(state.recentToolChain).toHaveLength(5);
  });

  it('12. 비연속 서브시퀀스 매칭 (read → OTHER 건너뛰고 → edit → bash)', () => {
    createSession(SESSION_KEY, 'chain-agent');
    pushToolChain(SESSION_KEY, 'read');       // READ
    pushToolChain(SESSION_KEY, 'web_fetch');  // OTHER — 윈도우에 안 들어감
    pushToolChain(SESSION_KEY, 'edit');       // WRITE
    const result = pushToolChain(SESSION_KEY, 'bash'); // EXEC
    // 윈도우: [READ, WRITE, EXEC] → read_write_exec 매칭
    expect(result).not.toBeNull();
    expect(result!.name).toBe('read_write_exec');
  });
});

// ─── before_tool_call 체인 위험도 통합 ───────────────────────────────────────

describe('before_tool_call 체인 위험도 감지', () => {
  it('13. read → edit → bash 체인 → NORM -0.05 + chain_risk_detected 신호', async () => {
    const { hookHandlers } = setupToolHooks({ dataSharing: true });
    createSession(SESSION_KEY, 'chain-agent');

    // read (LOW) → 신호 없음
    await hookHandlers['before_tool_call'](
      { toolName: 'read', callId: 'c1', sessionKey: SESSION_KEY },
      { sessionKey: SESSION_KEY }
    );

    // edit (WRITE) → 신호 없음
    await hookHandlers['before_tool_call'](
      { toolName: 'edit', callId: 'c2', sessionKey: SESSION_KEY },
      { sessionKey: SESSION_KEY }
    );

    const stateBefore = sessions.get(SESSION_KEY)!;
    const normBefore = stateBefore.axes.norm;

    // bash (EXEC) → read_write_exec 체인 매칭 → NORM -0.05
    await hookHandlers['before_tool_call'](
      { toolName: 'bash', callId: 'c3', sessionKey: SESSION_KEY },
      { sessionKey: SESSION_KEY }
    );

    const state = sessions.get(SESSION_KEY)!;
    expect(state.axes.norm).toBeCloseTo(normBefore + CHAIN_RISK_NORM_DELTA, 4);

    // chain_risk_detected 신호 확인
    const chainSignals = state.signalBuffer.filter(
      (s: any) => s.metadata.event_type === 'chain_risk_detected'
    );
    expect(chainSignals.length).toBeGreaterThanOrEqual(1);
    const sig = chainSignals[0]!;
    expect(sig.metadata.chain_pattern).toBe('read_write_exec');
    expect(sig.metadata.norm_delta).toBe(CHAIN_RISK_NORM_DELTA);
  });

  it('14. 패턴 미매칭 → NORM 변화 없음', async () => {
    const { hookHandlers } = setupToolHooks({ dataSharing: true });
    createSession(SESSION_KEY, 'chain-agent');

    // read → read → read (체인 패턴 없음)
    await hookHandlers['before_tool_call'](
      { toolName: 'read', callId: 'c1', sessionKey: SESSION_KEY },
      { sessionKey: SESSION_KEY }
    );
    await hookHandlers['before_tool_call'](
      { toolName: 'grep', callId: 'c2', sessionKey: SESSION_KEY },
      { sessionKey: SESSION_KEY }
    );
    await hookHandlers['before_tool_call'](
      { toolName: 'glob', callId: 'c3', sessionKey: SESSION_KEY },
      { sessionKey: SESSION_KEY }
    );

    const state = sessions.get(SESSION_KEY)!;
    expect(state.axes.norm).toBe(1.0); // 변화 없음

    const chainSignals = state.signalBuffer.filter(
      (s: any) => s.metadata.event_type === 'chain_risk_detected'
    );
    expect(chainSignals).toHaveLength(0);
  });

  it('15. dataSharing=false → NORM 감점 적용, 신호 없음', async () => {
    const { hookHandlers } = setupToolHooks({ dataSharing: false });
    createSession(SESSION_KEY, 'chain-agent');

    await hookHandlers['before_tool_call'](
      { toolName: 'read', callId: 'c1', sessionKey: SESSION_KEY },
      { sessionKey: SESSION_KEY }
    );
    await hookHandlers['before_tool_call'](
      { toolName: 'edit', callId: 'c2', sessionKey: SESSION_KEY },
      { sessionKey: SESSION_KEY }
    );
    await hookHandlers['before_tool_call'](
      { toolName: 'bash', callId: 'c3', sessionKey: SESSION_KEY },
      { sessionKey: SESSION_KEY }
    );

    const state = sessions.get(SESSION_KEY)!;
    // NORM 감점은 적용됨 (로컬 계산)
    expect(state.axes.norm).toBeLessThan(1.0);
    // 신호 없음 (dataSharing=false)
    expect(state.signalBuffer).toHaveLength(0);
  });

  it('16. 턴 리셋 후 체인 초기화 확인', () => {
    createSession(SESSION_KEY, 'chain-agent');

    // 체인 구축
    pushToolChain(SESSION_KEY, 'read');
    pushToolChain(SESSION_KEY, 'edit');

    const state = sessions.get(SESSION_KEY)!;
    expect(state.recentToolChain).toHaveLength(2);

    // 턴 리셋
    resetTurnAutonomy(SESSION_KEY);

    expect(state.recentToolChain).toHaveLength(0);
    expect(state.detectedChainPatterns.size).toBe(0);

    // 리셋 후 같은 패턴 다시 감지 가능
    pushToolChain(SESSION_KEY, 'read');
    pushToolChain(SESSION_KEY, 'edit');
    const result = pushToolChain(SESSION_KEY, 'bash');
    expect(result).not.toBeNull();
    expect(result!.name).toBe('read_write_exec');
  });
});
