// =============================================================================
// compaction-hook.test.ts — registerCompactionHooks 자가 검증 (Tier-2)
// =============================================================================
//
// 검증 범위:
//   1. registerCompactionHooks → before_compaction + after_compaction + before_reset 3개 훅 등록
//
//   before_compaction:
//   2. dataSharing=false → 신호 버퍼 없음
//   3. dataSharing=true → 신호 버퍼에 'before_compaction' 이벤트 추가
//   4. currentMessageCount, estimatedTokens 신호에 포함됨
//   5. sessionKey 없음 → {} 즉시 반환
//
//   after_compaction:
//   6. dataSharing=false → 신호 버퍼 없음
//   7. dataSharing=true → 신호 버퍼에 'after_compaction' 이벤트 추가
//   8. compression_ratio 올바르게 계산됨 (removed / total)
//   9. removed+retained=0 → compression_ratio undefined (0 나누기 방어)
//  10. 세션 미존재 → {} 즉시 반환
//
//   before_reset:
//  11. dataSharing=true → 신호 버퍼에 'before_reset' 이벤트 추가
//  12. reason 필드 신호에 포함됨
//  13. reason 없으면 'unknown' 기본값
//  14. 세션 미존재 → {} 즉시 반환
// =============================================================================

import { sessions, createSession } from '../session-state';
import { registerCompactionHooks } from '../hooks/compaction';
import type { PMatrixConfig, OpenClawPluginAPI } from '../types';

// ─── 헬퍼 ────────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<PMatrixConfig> = {}): PMatrixConfig {
  return {
    serverUrl: 'https://api.pmatrix.io',
    agentId: 'compaction-agent',
    apiKey: 'test-key',
    safetyGate: { enabled: true, confirmTimeoutMs: 20_000, serverTimeoutMs: 2_500 },
    credentialProtection: { enabled: false, blockTranscript: false, customPatterns: [] },
    killSwitch: { autoHaltOnRt: 0.75, safeModel: 'claude-opus-4-6' },
    outboundAllowlist: { enabled: false, allowedChannels: [] },
    dataSharing: true,
    batch: { maxSize: 10, flushIntervalMs: 2_000, retryMax: 0 },
    debug: false,
    ...overrides,
  };
}

function setupCompactionHooks(configOverrides: Partial<PMatrixConfig> = {}) {
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
    sendMessage: jest.fn().mockResolvedValue(undefined),
    logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    },
  };

  const config = makeConfig(configOverrides);
  registerCompactionHooks(api as unknown as OpenClawPluginAPI, config);

  return { api, hookHandlers, config };
}

beforeEach(() => {
  sessions.clear();
  jest.clearAllMocks();
});

// =============================================================================
// 1. 훅 등록 확인
// =============================================================================

describe('registerCompactionHooks — 훅 등록', () => {

  test('before_compaction + after_compaction + before_reset 3개 훅 등록됨', () => {
    const { api } = setupCompactionHooks();
    const names = (api.on as jest.Mock).mock.calls.map((c: any[]) => c[0]);
    expect(names).toContain('before_compaction');
    expect(names).toContain('after_compaction');
    expect(names).toContain('before_reset');
    expect(names).toHaveLength(3);
  });

});

// =============================================================================
// 2~5. before_compaction
// =============================================================================

describe('before_compaction', () => {

  test('dataSharing=false → 신호 버퍼 없음', async () => {
    const { hookHandlers } = setupCompactionHooks({ dataSharing: false });
    const state = createSession('comp-1', 'compaction-agent');

    await hookHandlers['before_compaction'](
      { sessionId: 'comp-1', currentMessageCount: 50, estimatedTokens: 10000 },
      { sessionKey: 'comp-1' }
    );

    expect(state.signalBuffer).toHaveLength(0);
  });

  test('dataSharing=true → 신호 버퍼에 before_compaction 이벤트 추가됨', async () => {
    const { hookHandlers } = setupCompactionHooks({ dataSharing: true });
    const state = createSession('comp-2', 'compaction-agent');

    await hookHandlers['before_compaction'](
      { sessionId: 'comp-2', currentMessageCount: 100, estimatedTokens: 20000 },
      { sessionKey: 'comp-2' }
    );

    expect(state.signalBuffer).toHaveLength(1);
    expect(state.signalBuffer[0]!.metadata.event_type).toBe('before_compaction');
  });

  test('currentMessageCount, estimatedTokens 신호에 포함됨', async () => {
    const { hookHandlers } = setupCompactionHooks({ dataSharing: true });
    const state = createSession('comp-3', 'compaction-agent');

    await hookHandlers['before_compaction'](
      { currentMessageCount: 77, estimatedTokens: 15000 },
      { sessionKey: 'comp-3' }
    );

    const meta = state.signalBuffer[0]!.metadata;
    expect(meta['current_message_count']).toBe(77);
    expect(meta['estimated_tokens']).toBe(15000);
  });

  test('sessionKey 없음 → {} 즉시 반환', async () => {
    const { hookHandlers } = setupCompactionHooks();
    const result = await hookHandlers['before_compaction'](
      { currentMessageCount: 10 },
      {}
    );
    expect(result).toEqual({});
  });

});

// =============================================================================
// 6~10. after_compaction
// =============================================================================

describe('after_compaction', () => {

  test('dataSharing=false → 신호 버퍼 없음', async () => {
    const { hookHandlers } = setupCompactionHooks({ dataSharing: false });
    const state = createSession('comp-ac-1', 'compaction-agent');

    await hookHandlers['after_compaction'](
      { removedCount: 80, retainedCount: 20 },
      { sessionKey: 'comp-ac-1' }
    );

    expect(state.signalBuffer).toHaveLength(0);
  });

  test('dataSharing=true → 신호 버퍼에 after_compaction 이벤트 추가됨', async () => {
    const { hookHandlers } = setupCompactionHooks({ dataSharing: true });
    const state = createSession('comp-ac-2', 'compaction-agent');

    await hookHandlers['after_compaction'](
      { removedCount: 80, retainedCount: 20 },
      { sessionKey: 'comp-ac-2' }
    );

    expect(state.signalBuffer).toHaveLength(1);
    expect(state.signalBuffer[0]!.metadata.event_type).toBe('after_compaction');
  });

  test('compression_ratio = removedCount / (removedCount + retainedCount)', async () => {
    const { hookHandlers } = setupCompactionHooks({ dataSharing: true });
    const state = createSession('comp-ac-3', 'compaction-agent');

    // removed=80, retained=20 → ratio=0.8
    await hookHandlers['after_compaction'](
      { removedCount: 80, retainedCount: 20 },
      { sessionKey: 'comp-ac-3' }
    );

    const meta = state.signalBuffer[0]!.metadata;
    expect(meta['removed_count']).toBe(80);
    expect(meta['retained_count']).toBe(20);
    // 0.8000 (parseFloat + toFixed(4))
    expect(meta['compression_ratio']).toBeCloseTo(0.8, 4);
  });

  test('removed+retained=0 → compression_ratio undefined (0 나누기 방어)', async () => {
    const { hookHandlers } = setupCompactionHooks({ dataSharing: true });
    createSession('comp-ac-4', 'compaction-agent');

    await hookHandlers['after_compaction'](
      { removedCount: 0, retainedCount: 0 },
      { sessionKey: 'comp-ac-4' }
    );

    // compression_ratio: 0이므로 undefined로 처리됨
    const meta = sessions.get('comp-ac-4')!.signalBuffer[0]!.metadata;
    expect(meta['compression_ratio']).toBeUndefined();
  });

  test('세션 미존재(before_compaction 없이 after만 발생) → {} 즉시 반환', async () => {
    const { hookHandlers } = setupCompactionHooks({ dataSharing: true });
    // 세션 생성 안 함

    const result = await hookHandlers['after_compaction'](
      { removedCount: 50, retainedCount: 50 },
      { sessionKey: 'no-session-key' }
    );
    expect(result).toEqual({});
  });

});

// =============================================================================
// 11~14. before_reset
// =============================================================================

describe('before_reset', () => {

  test('dataSharing=true → 신호 버퍼에 before_reset 이벤트 추가됨', async () => {
    const { hookHandlers } = setupCompactionHooks({ dataSharing: true });
    const state = createSession('comp-reset-1', 'compaction-agent');

    await hookHandlers['before_reset'](
      { reason: 'user_request' },
      { sessionKey: 'comp-reset-1' }
    );

    expect(state.signalBuffer).toHaveLength(1);
    expect(state.signalBuffer[0]!.metadata.event_type).toBe('before_reset');
  });

  test('reason 필드 신호에 포함됨', async () => {
    const { hookHandlers } = setupCompactionHooks({ dataSharing: true });
    const state = createSession('comp-reset-2', 'compaction-agent');

    await hookHandlers['before_reset'](
      { reason: 'memory_overflow' },
      { sessionKey: 'comp-reset-2' }
    );

    expect(state.signalBuffer[0]!.metadata['reset_reason']).toBe('memory_overflow');
  });

  test('reason 없으면 "unknown" 기본값 사용', async () => {
    const { hookHandlers } = setupCompactionHooks({ dataSharing: true });
    const state = createSession('comp-reset-3', 'compaction-agent');

    await hookHandlers['before_reset'](
      {},  // reason 없음
      { sessionKey: 'comp-reset-3' }
    );

    expect(state.signalBuffer[0]!.metadata['reset_reason']).toBe('unknown');
  });

  test('세션 미존재 → {} 즉시 반환', async () => {
    const { hookHandlers } = setupCompactionHooks({ dataSharing: true });
    // 세션 생성 안 함

    const result = await hookHandlers['before_reset'](
      { reason: 'test' },
      { sessionKey: 'ghost-session' }
    );
    expect(result).toEqual({});
  });

});
