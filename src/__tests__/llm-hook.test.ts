// =============================================================================
// llm-hook.test.ts — registerLlmHooks 자가 검증 (Tier-1 + Tier-2 확장)
// =============================================================================
//
// 검증 범위:
//   1. registerLlmHooks → llm_input + llm_output 2개 훅 등록
//
//   llm_input:
//   2. runId 등록 → state.pendingLlmRuns에 기록
//   3. dataSharing=false → runId 등록만, 신호 버퍼 없음
//   4. dataSharing=true → 신호 버퍼에 'llm_input' 이벤트 추가
//   5. systemPrompt → 해시만 신호에 포함 (전문 아님, §14-5)
//   6. sessionKey 없음 → {} 즉시 반환
//   [Tier-2 TASK-7]
//   14. prompt 있음 → prompt_len 신호에 포함됨 (PART I-1)
//   15. prompt 없음(빈 문자열) → prompt_len undefined (서버 prompt_score=0 처리)
//
//   llm_output:
//   7. runId 매칭 → latency 계산 → movingAvg.llmLatencies 갱신
//   8. outputTokens > 0 → movingAvg.outputTokens 갱신
//   9. lastAssistant 크레덴셜 → META_CONTROL -0.25 + dangerEvents 증가
//  10. 크레덴셜 + dataSharing=true → sendCritical 호출
//  11. 크레덴셜 + dataSharing=false → sendCritical 미호출 (로컬만 처리)
//  12. dataSharing=true → 신호 버퍼에 'llm_output' 이벤트
//  13. runId 없음 → latency null, 크래시 없음
//   [Tier-2 TASK-7 + §A-2]
//  16. accumulateTokens 호출 → totalInputTokens/totalOutputTokens 누적됨 (dataSharing 무관)
//  17. dataSharing=false → accumulateTokens는 여전히 수행됨 (로컬 카운팅)
// =============================================================================

import { sessions, createSession } from '../session-state';
import { registerLlmHooks } from '../hooks/llm';
import type { PMatrixConfig, OpenClawPluginAPI } from '../types';
import { getTokenTotals } from '../cost-tracker';

// ─── 헬퍼 ────────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<PMatrixConfig> = {}): PMatrixConfig {
  return {
    serverUrl: 'https://api.pmatrix.io',
    agentId: 'llm-agent',
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

function setupLlmHooks(configOverrides: Partial<PMatrixConfig> = {}) {
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

  const client = {
    sendCritical: jest.fn().mockResolvedValue(undefined),
    sendBatch: jest.fn().mockResolvedValue({ received: 1 }),
  };

  const config = makeConfig(configOverrides);
  registerLlmHooks(api as unknown as OpenClawPluginAPI, config, client as any);

  return { api, hookHandlers, client, config };
}

// AWS Access Key 형식 — scanCredentials에서 탐지됨 (AKIA + 16 uppercase)
// 주의: 'AKIAIOSFODNN7EXAMPLE'은 TEST_EXCLUSIONS의 'EXAMPLE'에 포함되어 필터링됨
// → 'EXAMPLE', 'example', 'sk-test-', 'sk-fake-' 등 비포함 패턴 사용
const FAKE_AWS_KEY = 'AKIAZZZZZZZZZZZZZZZZ';

beforeEach(() => {
  sessions.clear();
  jest.clearAllMocks();
});

// =============================================================================
// 1. 훅 등록 확인
// =============================================================================

describe('registerLlmHooks — 훅 등록', () => {

  test('llm_input + llm_output 2개 훅 등록됨', () => {
    const { api } = setupLlmHooks();
    const names = (api.on as jest.Mock).mock.calls.map((c: any[]) => c[0]);
    expect(names).toContain('llm_input');
    expect(names).toContain('llm_output');
    expect(names).toHaveLength(2);
  });

});

// =============================================================================
// 2~6. llm_input
// =============================================================================

describe('llm_input — runId 등록 및 신호 버퍼링', () => {

  test('runId 등록 → state.pendingLlmRuns에 타임스탬프 기록됨', async () => {
    const { hookHandlers } = setupLlmHooks();
    const state = createSession('llm-in-1', 'llm-agent');

    await hookHandlers['llm_input'](
      { runId: 'run-abc', model: 'gpt-4', provider: 'openai' },
      { sessionKey: 'llm-in-1' }
    );

    expect(state.pendingLlmRuns.has('run-abc')).toBe(true);
    expect(state.pendingLlmRuns.get('run-abc')).toBeGreaterThan(0);
  });

  test('dataSharing=false → runId 등록되지만 신호 버퍼 없음', async () => {
    const { hookHandlers } = setupLlmHooks({ dataSharing: false });
    const state = createSession('llm-in-2', 'llm-agent');

    await hookHandlers['llm_input'](
      { runId: 'run-xyz', model: 'gpt-4', provider: 'openai' },
      { sessionKey: 'llm-in-2' }
    );

    // runId는 등록됨 (latency 계산용)
    expect(state.pendingLlmRuns.has('run-xyz')).toBe(true);
    // 신호 버퍼 없음 (dataSharing=false)
    expect(state.signalBuffer).toHaveLength(0);
  });

  test('dataSharing=true → 신호 버퍼에 llm_input 이벤트 추가됨', async () => {
    const { hookHandlers } = setupLlmHooks({ dataSharing: true });
    const state = createSession('llm-in-3', 'llm-agent');

    await hookHandlers['llm_input'](
      { runId: 'run-1', model: 'claude-3-5-sonnet', provider: 'anthropic' },
      { sessionKey: 'llm-in-3' }
    );

    expect(state.signalBuffer).toHaveLength(1);
    expect(state.signalBuffer[0]!.metadata.event_type).toBe('llm_input');
  });

  test('systemPrompt → 전문 아닌 해시만 신호에 포함됨 (§14-5)', async () => {
    const { hookHandlers } = setupLlmHooks({ dataSharing: true });
    const state = createSession('llm-in-4', 'llm-agent');
    const rawPrompt = 'You are a helpful assistant with secret: password=12345';

    await hookHandlers['llm_input'](
      { runId: 'run-hash', model: 'gpt-4', systemPrompt: rawPrompt },
      { sessionKey: 'llm-in-4' }
    );

    const signal = state.signalBuffer[0]!;
    const meta = signal.metadata;

    // 해시가 있음 (8자리 hex)
    expect(meta['prompt_hash']).toBeDefined();
    expect(String(meta['prompt_hash'])).toMatch(/^[0-9a-f]{8}$/);

    // 전문이 포함되지 않음
    const serialized = JSON.stringify(signal);
    expect(serialized).not.toContain('password=12345');
    expect(serialized).not.toContain(rawPrompt);
  });

  test('historyMessages, imagesCount 신호에 포함됨', async () => {
    const { hookHandlers } = setupLlmHooks({ dataSharing: true });
    const state = createSession('llm-in-5', 'llm-agent');

    await hookHandlers['llm_input'](
      {
        runId: 'run-2',
        model: 'gpt-4',
        historyMessages: 7,
        imagesCount: 2,
      },
      { sessionKey: 'llm-in-5' }
    );

    const meta = state.signalBuffer[0]!.metadata;
    expect(meta['history_messages']).toBe(7);
    expect(meta['images_count']).toBe(2);
  });

  test('sessionKey 없음 → {} 즉시 반환', async () => {
    const { hookHandlers } = setupLlmHooks();
    const result = await hookHandlers['llm_input'](
      { runId: 'run-nokey', model: 'gpt-4' },
      {}
    );
    expect(result).toEqual({});
  });

});

// =============================================================================
// 14~15. llm_input — Tier-2 TASK-7: prompt_len (PART I-1)
// =============================================================================

describe('llm_input — Tier-2: prompt_len 수집', () => {

  test('prompt 있음 → prompt_len 신호 metadata에 포함됨', async () => {
    const { hookHandlers } = setupLlmHooks({ dataSharing: true });
    const state = createSession('llm-prompt-1', 'llm-agent');
    const promptText = 'Hello, please help me with this task: analyze the data.';

    await hookHandlers['llm_input'](
      { runId: 'run-p1', model: 'claude-3-5', prompt: promptText },
      { sessionKey: 'llm-prompt-1' }
    );

    const meta = state.signalBuffer[0]!.metadata;
    expect(meta['prompt_len']).toBe(promptText.length);
    // prompt 전문은 포함되지 않음 (§14-5)
    expect(JSON.stringify(meta)).not.toContain('analyze the data');
  });

  test('prompt 없음(빈 문자열) → prompt_len undefined (서버 prompt_score=0 처리)', async () => {
    const { hookHandlers } = setupLlmHooks({ dataSharing: true });
    const state = createSession('llm-prompt-2', 'llm-agent');

    await hookHandlers['llm_input'](
      { runId: 'run-p2', model: 'claude-3-5' },  // prompt 필드 없음
      { sessionKey: 'llm-prompt-2' }
    );

    const meta = state.signalBuffer[0]!.metadata;
    // prompt 없으면 prompt_len = undefined → 서버 Drift prompt_score = 0.0
    expect(meta['prompt_len']).toBeUndefined();
  });

});

// =============================================================================
// 7~13. llm_output
// =============================================================================

describe('llm_output — latency / 토큰 / 크레덴셜 / 버퍼링', () => {

  test('runId 매칭 → latency 계산 → movingAvg.llmLatencies 갱신됨', async () => {
    const { hookHandlers } = setupLlmHooks({ dataSharing: false });
    const state = createSession('llm-out-1', 'llm-agent');

    // input 먼저 (runId 등록)
    await hookHandlers['llm_input'](
      { runId: 'run-lat', model: 'gpt-4' },
      { sessionKey: 'llm-out-1' }
    );

    // output (latency 계산)
    await hookHandlers['llm_output'](
      { runId: 'run-lat', model: 'gpt-4', usage: { output: 150 } },
      { sessionKey: 'llm-out-1' }
    );

    expect(state.movingAvg.llmLatencies).toHaveLength(1);
    expect(state.movingAvg.llmLatencies[0]).toBeGreaterThanOrEqual(0);
  });

  test('outputTokens > 0 → movingAvg.outputTokens 갱신됨', async () => {
    const { hookHandlers } = setupLlmHooks({ dataSharing: false });
    const state = createSession('llm-out-2', 'llm-agent');

    await hookHandlers['llm_output'](
      { model: 'gpt-4', usage: { output: 250, input: 100, total: 350 } },
      { sessionKey: 'llm-out-2' }
    );

    expect(state.movingAvg.outputTokens).toHaveLength(1);
    expect(state.movingAvg.outputTokens[0]).toBe(250);
  });

  test('outputTokens=0 → movingAvg.outputTokens 갱신 없음', async () => {
    const { hookHandlers } = setupLlmHooks({ dataSharing: false });
    const state = createSession('llm-out-3', 'llm-agent');

    await hookHandlers['llm_output'](
      { model: 'gpt-4', usage: { output: 0 } },
      { sessionKey: 'llm-out-3' }
    );

    expect(state.movingAvg.outputTokens).toHaveLength(0);
  });

  test('lastAssistant 크레덴셜 → META_CONTROL -0.25 + dangerEvents 증가', async () => {
    const { hookHandlers } = setupLlmHooks({ dataSharing: false });
    const state = createSession('llm-out-cred', 'llm-agent');
    const beforeDanger = state.dangerEvents;
    const beforeMeta = state.axes.meta_control;

    await hookHandlers['llm_output'](
      {
        model: 'gpt-4',
        lastAssistant: `Here is your key: ${FAKE_AWS_KEY}`,
        usage: {},
      },
      { sessionKey: 'llm-out-cred' }
    );

    expect(state.dangerEvents).toBe(beforeDanger + 1);
    // meta_control 감소 (META_CONTROL -0.25)
    expect(state.axes.meta_control).toBeLessThan(beforeMeta);
  });

  test('크레덴셜 + dataSharing=true → sendCritical 호출됨', async () => {
    const { hookHandlers, client } = setupLlmHooks({ dataSharing: true });
    createSession('llm-out-crit-1', 'llm-agent');

    await hookHandlers['llm_output'](
      {
        model: 'gpt-4',
        lastAssistant: `AWS key: ${FAKE_AWS_KEY}`,
        usage: {},
      },
      { sessionKey: 'llm-out-crit-1' }
    );

    expect(client.sendCritical).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ event_type: 'llm_output_credential' }),
      })
    );
  });

  test('크레덴셜 + dataSharing=false → sendCritical 미호출 (로컬만 처리)', async () => {
    const { hookHandlers, client } = setupLlmHooks({ dataSharing: false });
    createSession('llm-out-crit-2', 'llm-agent');

    await hookHandlers['llm_output'](
      {
        model: 'gpt-4',
        lastAssistant: `AWS key: ${FAKE_AWS_KEY}`,
        usage: {},
      },
      { sessionKey: 'llm-out-crit-2' }
    );

    // sendCritical 미호출 (dataSharing=false)
    expect(client.sendCritical).not.toHaveBeenCalled();
  });

  test('dataSharing=true → 신호 버퍼에 llm_output 이벤트 추가됨', async () => {
    const { hookHandlers } = setupLlmHooks({ dataSharing: true });
    const state = createSession('llm-out-buf', 'llm-agent');

    await hookHandlers['llm_output'](
      {
        runId: 'run-buf',
        model: 'claude-3-5',
        usage: { output: 300, input: 200, total: 500 },
      },
      { sessionKey: 'llm-out-buf' }
    );

    const outputSignal = state.signalBuffer.find(
      (s) => s.metadata.event_type === 'llm_output'
    );
    expect(outputSignal).toBeDefined();
    expect(outputSignal!.metadata['llm_tokens_total']).toBe(500);
    expect(outputSignal!.metadata['output_tokens']).toBe(300);
  });

  test('runId 없음 → latency null, 크래시 없음', async () => {
    const { hookHandlers } = setupLlmHooks({ dataSharing: false });
    createSession('llm-out-norun', 'llm-agent');

    await expect(
      hookHandlers['llm_output'](
        { model: 'gpt-4', usage: { output: 100 } },
        { sessionKey: 'llm-out-norun' }
      )
    ).resolves.not.toThrow();
  });

  test('sessionKey 없음 → {} 즉시 반환', async () => {
    const { hookHandlers } = setupLlmHooks();
    const result = await hookHandlers['llm_output'](
      { runId: 'run-x', model: 'gpt-4', usage: {} },
      {}
    );
    expect(result).toEqual({});
  });

  test('assistantTexts 배열 → 마지막 요소로 크레덴셜 스캔', async () => {
    const { hookHandlers } = setupLlmHooks({ dataSharing: false });
    const state = createSession('llm-out-arr', 'llm-agent');
    const beforeDanger = state.dangerEvents;

    await hookHandlers['llm_output'](
      {
        model: 'gpt-4',
        assistantTexts: ['Normal text', `Key: ${FAKE_AWS_KEY}`],
        usage: {},
      },
      { sessionKey: 'llm-out-arr' }
    );

    expect(state.dangerEvents).toBe(beforeDanger + 1);
  });

});

// =============================================================================
// 16~17. llm_output — Tier-2 §A-2: cost-tracker accumulateTokens 연동
// =============================================================================

describe('llm_output — Tier-2: cost-tracker 연동', () => {

  test('accumulateTokens 호출 → totalInputTokens/totalOutputTokens 누적됨 (dataSharing=true)', async () => {
    const { hookHandlers } = setupLlmHooks({ dataSharing: true });
    createSession('llm-cost-1', 'llm-agent');

    await hookHandlers['llm_output'](
      { model: 'claude-3-5', usage: { input: 800, output: 350, total: 1150 } },
      { sessionKey: 'llm-cost-1' }
    );

    const totals = getTokenTotals('llm-cost-1');
    expect(totals).not.toBeNull();
    expect(totals!.inputTokens).toBe(800);
    expect(totals!.outputTokens).toBe(350);
  });

  test('dataSharing=false → accumulateTokens는 여전히 수행됨 (로컬 카운팅)', async () => {
    const { hookHandlers } = setupLlmHooks({ dataSharing: false });
    createSession('llm-cost-2', 'llm-agent');

    await hookHandlers['llm_output'](
      { model: 'gpt-4', usage: { input: 500, output: 200 } },
      { sessionKey: 'llm-cost-2' }
    );

    // dataSharing=false여도 로컬 카운팅 수행
    const totals = getTokenTotals('llm-cost-2');
    expect(totals!.inputTokens).toBe(500);
    expect(totals!.outputTokens).toBe(200);
  });

});
