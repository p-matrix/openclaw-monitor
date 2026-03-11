// =============================================================================
// model-hook.test.ts — registerModelHooks 자가 검증 (Tier-1)
// =============================================================================
//
// 검증 범위:
//   before_model_resolve:
//   1. 첫 호출 → baseline 기준선 캡처 (baselineModel 저장, 오버라이드 없음)
//   2. Halt 상태 → modelOverride: safeModel 반환
//   3. Critical(R≥0.50) + 다른 모델 → modelOverride: safeModel (Tier-1 §4-2)
//   4. Critical(R≥0.50) + 이미 safeModel → {} (중복 전환 없음)
//   5. Normal(R<0.50) → {} (오버라이드 없음)
//   6. 기준선 이후 모델 변경 + dataSharing=true → model_changed 신호 버퍼링
//   7. 기준선 이후 모델 변경 + dataSharing=false → 신호 없음
//   8. sessionKey 없음 → {} 즉시 반환
//
//   before_prompt_build:
//   9.  systemPrompt → state.baselinePromptHash 저장됨 (8자리 hex)
//  10. 두 번째 호출 → 이미 해시 있으면 건너뜀 (최초 1회만)
//  11. systemPrompt 없음 → baselinePromptHash = null
// =============================================================================

import { sessions, createSession, haltSession } from '../session-state';
import { registerModelHooks } from '../hooks/model';
import type { PMatrixConfig, OpenClawPluginAPI } from '../types';

// ─── 헬퍼 ────────────────────────────────────────────────────────────────────

const SAFE_MODEL = 'claude-opus-4-6';
const OTHER_MODEL = 'claude-3-5-sonnet-20241022';

function makeConfig(overrides: Partial<PMatrixConfig> = {}): PMatrixConfig {
  return {
    serverUrl: 'https://api.pmatrix.io',
    agentId: 'model-agent',
    apiKey: 'test-key',
    safetyGate: { enabled: true, confirmTimeoutMs: 20_000, serverTimeoutMs: 2_500 },
    credentialProtection: { enabled: true, blockTranscript: false, customPatterns: [] },
    killSwitch: { autoHaltOnRt: 0.75, safeModel: SAFE_MODEL },
    outboundAllowlist: { enabled: false, allowedChannels: [] },
    dataSharing: true,
    batch: { maxSize: 10, flushIntervalMs: 2_000, retryMax: 0 },
    debug: false,
    ...overrides,
  };
}

function setupModelHooks(configOverrides: Partial<PMatrixConfig> = {}) {
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
  registerModelHooks(api as unknown as OpenClawPluginAPI, config, client as any);

  return { api, hookHandlers, client, config };
}

beforeEach(() => {
  sessions.clear();
  jest.clearAllMocks();
});

// =============================================================================
// 1. 훅 등록 확인
// =============================================================================

describe('registerModelHooks — 훅 등록', () => {

  test('before_model_resolve + before_prompt_build 2개 등록됨', () => {
    const { api } = setupModelHooks();
    const names = (api.on as jest.Mock).mock.calls.map((c: any[]) => c[0]);
    expect(names).toContain('before_model_resolve');
    expect(names).toContain('before_prompt_build');
    expect(names).toHaveLength(2);
  });

});

// =============================================================================
// 2~8. before_model_resolve
// =============================================================================

describe('before_model_resolve — baseline 기준선 + 모델 전환', () => {

  // ── 기준선 캡처 ──────────────────────────────────────────────────────────

  test('첫 호출 → baselineModel 저장, {} 반환 (오버라이드 없음)', async () => {
    const { hookHandlers } = setupModelHooks();
    const state = createSession('mod-1', 'model-agent');

    const result = await hookHandlers['before_model_resolve'](
      { model: OTHER_MODEL, provider: 'anthropic' },
      { sessionKey: 'mod-1' }
    );

    expect(result).toEqual({});
    expect(state.baselineModel).toBe(OTHER_MODEL);
  });

  test('두 번째 호출에서 기준선 덮어쓰기 없음 (baselineModel 불변)', async () => {
    const { hookHandlers } = setupModelHooks();
    const state = createSession('mod-1b', 'model-agent');

    // 첫 호출 → 기준선
    await hookHandlers['before_model_resolve'](
      { model: OTHER_MODEL, provider: 'anthropic' },
      { sessionKey: 'mod-1b' }
    );
    const captured = state.baselineModel;

    // 두 번째 호출 (다른 모델)
    await hookHandlers['before_model_resolve'](
      { model: SAFE_MODEL, provider: 'anthropic' },
      { sessionKey: 'mod-1b' }
    );

    // baselineModel은 첫 번째 값 유지
    expect(state.baselineModel).toBe(captured);
  });

  // ── Halt → 강제 전환 ─────────────────────────────────────────────────────

  test('Halt 상태 + 다른 모델 → modelOverride: safeModel 반환', async () => {
    const { hookHandlers } = setupModelHooks();
    const state = createSession('mod-2', 'model-agent');
    state.baselineModel = OTHER_MODEL;  // 기준선 설정 완료 상태
    haltSession('mod-2', 'Halt 테스트');

    const result = await hookHandlers['before_model_resolve'](
      { model: OTHER_MODEL, provider: 'anthropic' },
      { sessionKey: 'mod-2' }
    );

    expect(result.modelOverride).toBe(SAFE_MODEL);
  });

  test('Halt + 이미 safeModel → {} (중복 전환 없음)', async () => {
    const { hookHandlers } = setupModelHooks();
    const state = createSession('mod-2b', 'model-agent');
    state.baselineModel = SAFE_MODEL;
    haltSession('mod-2b', 'Halt');

    const result = await hookHandlers['before_model_resolve'](
      { model: SAFE_MODEL, provider: 'anthropic' },
      { sessionKey: 'mod-2b' }
    );

    expect(result.modelOverride).toBeUndefined();
  });

  // ── Critical 다운그레이드 (Tier-1 §4-2) ──────────────────────────────────

  test('Critical(R=0.60) + 다른 모델 → modelOverride: safeModel (Tier-1)', async () => {
    const { hookHandlers } = setupModelHooks();
    const state = createSession('mod-3', 'model-agent');
    state.baselineModel = OTHER_MODEL;
    state.currentRt = 0.60;  // Critical

    const result = await hookHandlers['before_model_resolve'](
      { model: OTHER_MODEL, provider: 'anthropic' },
      { sessionKey: 'mod-3' }
    );

    expect(result.modelOverride).toBe(SAFE_MODEL);
  });

  test('Critical(R=0.50 정확히) → 경계값 포함 → modelOverride 반환', async () => {
    const { hookHandlers } = setupModelHooks();
    const state = createSession('mod-3b', 'model-agent');
    state.baselineModel = OTHER_MODEL;
    state.currentRt = 0.50;  // Critical 하한 경계

    const result = await hookHandlers['before_model_resolve'](
      { model: OTHER_MODEL, provider: 'anthropic' },
      { sessionKey: 'mod-3b' }
    );

    expect(result.modelOverride).toBe(SAFE_MODEL);
  });

  test('Critical(R=0.60) + 이미 safeModel → {} (중복 전환 없음)', async () => {
    const { hookHandlers } = setupModelHooks();
    const state = createSession('mod-3c', 'model-agent');
    state.baselineModel = SAFE_MODEL;
    state.currentRt = 0.60;

    const result = await hookHandlers['before_model_resolve'](
      { model: SAFE_MODEL, provider: 'anthropic' },
      { sessionKey: 'mod-3c' }
    );

    expect(result.modelOverride).toBeUndefined();
  });

  test('Normal(R=0.10) + 다른 모델 → {} (오버라이드 없음)', async () => {
    const { hookHandlers } = setupModelHooks();
    const state = createSession('mod-4', 'model-agent');
    state.baselineModel = OTHER_MODEL;
    state.currentRt = 0.10;  // Normal

    const result = await hookHandlers['before_model_resolve'](
      { model: OTHER_MODEL, provider: 'anthropic' },
      { sessionKey: 'mod-4' }
    );

    expect(result.modelOverride).toBeUndefined();
  });

  test('Alert(R=0.49) → Critical 아님 → {} (Tier-1 임계값은 0.50)', async () => {
    const { hookHandlers } = setupModelHooks();
    const state = createSession('mod-4b', 'model-agent');
    state.baselineModel = OTHER_MODEL;
    state.currentRt = 0.49;  // Alert 최댓값 (Critical 미만)

    const result = await hookHandlers['before_model_resolve'](
      { model: OTHER_MODEL, provider: 'anthropic' },
      { sessionKey: 'mod-4b' }
    );

    expect(result.modelOverride).toBeUndefined();
  });

  // ── 모델 변경 감지 → baseline 신호 버퍼링 ───────────────────────────────────

  test('기준선 이후 다른 모델 + dataSharing=true → model_changed 신호 버퍼링', async () => {
    const { hookHandlers } = setupModelHooks({ dataSharing: true });
    const state = createSession('mod-5', 'model-agent');
    state.baselineModel = OTHER_MODEL;
    state.currentRt = 0.10;  // Normal (오버라이드 없음)

    await hookHandlers['before_model_resolve'](
      { model: SAFE_MODEL, provider: 'anthropic' },  // 기준선과 다른 모델
      { sessionKey: 'mod-5' }
    );

    const modelChangedSignal = state.signalBuffer.find(
      (s) => s.metadata.event_type === 'model_changed'
    );
    expect(modelChangedSignal).toBeDefined();
    expect(String(modelChangedSignal!.metadata['tool_name'])).toContain('→');
  });

  test('기준선 이후 다른 모델 + dataSharing=false → 신호 버퍼링 없음', async () => {
    const { hookHandlers } = setupModelHooks({ dataSharing: false });
    const state = createSession('mod-5b', 'model-agent');
    state.baselineModel = OTHER_MODEL;
    state.currentRt = 0.10;

    await hookHandlers['before_model_resolve'](
      { model: SAFE_MODEL, provider: 'anthropic' },
      { sessionKey: 'mod-5b' }
    );

    expect(state.signalBuffer).toHaveLength(0);
  });

  test('Critical + dataSharing=true → model_downgrade 신호 버퍼링', async () => {
    const { hookHandlers } = setupModelHooks({ dataSharing: true });
    const state = createSession('mod-5c', 'model-agent');
    state.baselineModel = OTHER_MODEL;
    state.currentRt = 0.60;  // Critical

    await hookHandlers['before_model_resolve'](
      { model: OTHER_MODEL, provider: 'anthropic' },
      { sessionKey: 'mod-5c' }
    );

    const downgradeSignal = state.signalBuffer.find(
      (s) => s.metadata.event_type === 'model_downgrade'
    );
    expect(downgradeSignal).toBeDefined();
  });

  // ── sessionKey 없음 ───────────────────────────────────────────────────────

  test('sessionKey 없음 → {} 즉시 반환', async () => {
    const { hookHandlers } = setupModelHooks();
    const result = await hookHandlers['before_model_resolve'](
      { model: OTHER_MODEL, provider: 'anthropic' },
      {}
    );
    expect(result).toEqual({});
  });

});

// =============================================================================
// 9~11. before_prompt_build
// =============================================================================

describe('before_prompt_build — 시스템 프롬프트 해시', () => {

  test('systemPrompt → state.baselinePromptHash 저장됨 (8자리 hex)', async () => {
    const { hookHandlers } = setupModelHooks();
    const state = createSession('prompt-1', 'model-agent');

    await hookHandlers['before_prompt_build'](
      { systemPrompt: 'You are a helpful assistant.' },
      { sessionKey: 'prompt-1' }
    );

    expect(state.baselinePromptHash).toBeDefined();
    expect(state.baselinePromptHash).toMatch(/^[0-9a-f]{8}$/);
  });

  test('두 번째 호출 → 해시 변경 없음 (최초 1회만 캡처)', async () => {
    const { hookHandlers } = setupModelHooks();
    const state = createSession('prompt-2', 'model-agent');

    await hookHandlers['before_prompt_build'](
      { systemPrompt: 'First prompt.' },
      { sessionKey: 'prompt-2' }
    );
    const firstHash = state.baselinePromptHash;

    // 두 번째 호출 (다른 프롬프트)
    await hookHandlers['before_prompt_build'](
      { systemPrompt: 'Different prompt.' },
      { sessionKey: 'prompt-2' }
    );

    // 해시 불변
    expect(state.baselinePromptHash).toBe(firstHash);
  });

  test('systemPrompt 없음 → baselinePromptHash = null', async () => {
    const { hookHandlers } = setupModelHooks();
    const state = createSession('prompt-3', 'model-agent');

    await hookHandlers['before_prompt_build'](
      {},  // systemPrompt 없음
      { sessionKey: 'prompt-3' }
    );

    expect(state.baselinePromptHash).toBeNull();
  });

  test('sessionKey 없음 → {} 즉시 반환', async () => {
    const { hookHandlers } = setupModelHooks();
    const result = await hookHandlers['before_prompt_build'](
      { systemPrompt: 'Hello' },
      {}
    );
    expect(result).toEqual({});
  });

});
