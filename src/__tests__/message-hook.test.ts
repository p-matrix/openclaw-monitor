// =============================================================================
// message-hook.test.ts — registerMessageHooks 자가 검증 (Tier-1)
// =============================================================================
//
// 검증 범위:
//   1. registerMessageHooks → 4개 훅 등록 확인
//
//   message_sending:
//   2. Outbound Allowlist disabled → 통과
//   3. Allowlist enabled, channel 없음 → fail-open 통과
//   4. Allowlist enabled, 허용 채널 → 통과
//   5. Allowlist enabled, 불허 채널 → { cancel: true }
//   6. 불허 채널 + dataSharing=true → allowlist_block 신호 버퍼링 (META_CONTROL -0.10)
//   7. 불허 채널 + dataSharing=false → 신호 없음
//   8. 채널 접두사 매칭 → 통과 (startsWith)
//   9. 크레덴셜 감지 → { cancel: true }
//  10. 크레덴셜 + dataSharing=true → sendCritical 호출
//  11. 크레덴셜 + dataSharing=false → sendCritical 미호출
//  12. 크레덴셜 감지 → api.sendMessage 차단 알림 전송
//  13. 크레덴셜 없음 → {} 반환
//  14. credentialProtection disabled → 크레덴셜 있어도 {} 반환
//  15. message_sending sessionKey 없음 → {} 반환
//
//   before_message_write:
//  16. blockTranscript=true + 크레덴셜 → { cancel: true }
//  17. blockTranscript=false → {} (스캔 안 함)
//  18. credentialProtection disabled → {} 반환
//
//   message_received:
//  19. 메시지 수신 → turnNumber 증가
//  20. sessionKey 없음 → turnNumber 변경 없음
//
//   tool_result_persist:
//  21. 크레덴셜 + dataSharing=true → tool_result_credential 신호 버퍼링 (META_CONTROL -0.15)
//  22. 크레덴셜 없음 → {} 반환, 신호 없음
//  23. credentialProtection disabled → {} 반환
//  24. sessionKey 없음 → {} 반환
// =============================================================================

import { sessions, createSession } from '../session-state';
import { registerMessageHooks } from '../hooks/message';
import type { PMatrixConfig, OpenClawPluginAPI } from '../types';

// ─── 헬퍼 ────────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<PMatrixConfig> = {}): PMatrixConfig {
  return {
    serverUrl: 'https://api.pmatrix.io',
    agentId: 'msg-agent',
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function setupMessageHooks(configOverrides: Partial<PMatrixConfig> = {}) {
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
  registerMessageHooks(api as unknown as OpenClawPluginAPI, config, client as any);

  return { api, hookHandlers, client, config };
}

// TEST_EXCLUSIONS 비포함 AWS Key 패턴 (AKIA + 16 uppercase, 'EXAMPLE' 제외)
const FAKE_AWS_KEY = 'AKIAZZZZZZZZZZZZZZZZ';

beforeEach(() => {
  sessions.clear();
  jest.clearAllMocks();
});

// =============================================================================
// 1. 훅 등록 확인
// =============================================================================

describe('registerMessageHooks — 훅 등록', () => {

  test('4개 훅 등록됨: message_received / message_sending / before_message_write / tool_result_persist', () => {
    const { api } = setupMessageHooks();
    const names = (api.on as jest.Mock).mock.calls.map((c: any[]) => c[0]);
    expect(names).toContain('message_received');
    expect(names).toContain('message_sending');
    expect(names).toContain('before_message_write');
    expect(names).toContain('tool_result_persist');
    expect(names).toHaveLength(4);
  });

});

// =============================================================================
// 2~15. message_sending — Outbound Allowlist + 크레덴셜 차단
// =============================================================================

describe('message_sending — Outbound Allowlist (Tier-1 §3)', () => {

  test('allowlist disabled → 크레덴셜 없으면 {} 반환', async () => {
    const { hookHandlers } = setupMessageHooks({
      outboundAllowlist: { enabled: false, allowedChannels: [] },
    });
    createSession('msg-al-1', 'msg-agent');

    const result = await hookHandlers['message_sending'](
      { text: 'Hello world', channel: 'telegram:@somebot' },
      { sessionKey: 'msg-al-1' }
    );

    expect(result).toEqual({});
  });

  test('allowlist enabled, channel 없음 → fail-open 통과 ({})', async () => {
    const { hookHandlers } = setupMessageHooks({
      outboundAllowlist: { enabled: true, allowedChannels: ['telegram:@allowed'] },
    });
    createSession('msg-al-2', 'msg-agent');

    // channel 필드 없는 이벤트 → 빈 문자열 → 허용 (§97: !channel → 통과)
    const result = await hookHandlers['message_sending'](
      { text: 'Hello world' },
      { sessionKey: 'msg-al-2' }
    );

    expect(result).toEqual({});
  });

  test('allowlist enabled, 허용 채널 정확 매칭 → {} 반환', async () => {
    const { hookHandlers } = setupMessageHooks({
      outboundAllowlist: { enabled: true, allowedChannels: ['telegram:@mybot'] },
    });
    createSession('msg-al-3', 'msg-agent');

    const result = await hookHandlers['message_sending'](
      { text: 'Hello', channel: 'telegram:@mybot' },
      { sessionKey: 'msg-al-3' }
    );

    expect(result).toEqual({});
  });

  test('allowlist enabled, 불허 채널 → { cancel: true }', async () => {
    const { hookHandlers } = setupMessageHooks({
      outboundAllowlist: { enabled: true, allowedChannels: ['telegram:@mybot'] },
    });
    createSession('msg-al-4', 'msg-agent');

    const result = await hookHandlers['message_sending'](
      { text: 'Hello', channel: 'discord:#general' },
      { sessionKey: 'msg-al-4' }
    );

    expect(result).toEqual({ cancel: true });
  });

  test('불허 채널 + dataSharing=true → allowlist_block 신호 버퍼링, META_CONTROL -0.10', async () => {
    const { hookHandlers } = setupMessageHooks({
      outboundAllowlist: { enabled: true, allowedChannels: ['telegram:@mybot'] },
      dataSharing: true,
    });
    const state = createSession('msg-al-5', 'msg-agent');

    await hookHandlers['message_sending'](
      { text: 'Hello', channel: 'discord:#general' },
      { sessionKey: 'msg-al-5' }
    );

    const signal = state.signalBuffer.find(
      (s) => s.metadata.event_type === 'allowlist_block'
    );
    expect(signal).toBeDefined();
    expect(signal!.metadata.meta_control_delta).toBe(-0.10);
    expect(signal!.metadata.tool_name).toBe('discord:#general');
  });

  test('불허 채널 + dataSharing=false → 신호 버퍼 없음', async () => {
    const { hookHandlers } = setupMessageHooks({
      outboundAllowlist: { enabled: true, allowedChannels: ['telegram:@mybot'] },
      dataSharing: false,
    });
    const state = createSession('msg-al-6', 'msg-agent');

    await hookHandlers['message_sending'](
      { text: 'Hello', channel: 'discord:#general' },
      { sessionKey: 'msg-al-6' }
    );

    expect(state.signalBuffer).toHaveLength(0);
  });

  test('채널 접두사 매칭 (startsWith) → 허용', async () => {
    const { hookHandlers } = setupMessageHooks({
      outboundAllowlist: { enabled: true, allowedChannels: ['telegram:'] },
    });
    createSession('msg-al-7', 'msg-agent');

    const result = await hookHandlers['message_sending'](
      { text: 'Hello', channel: 'telegram:@anybot' },
      { sessionKey: 'msg-al-7' }
    );

    expect(result).toEqual({});
  });

});

describe('message_sending — 크레덴셜 차단 (§5-3)', () => {

  test('크레덴셜 감지 → { cancel: true }', async () => {
    const { hookHandlers } = setupMessageHooks({ dataSharing: false });
    createSession('msg-cred-1', 'msg-agent');

    const result = await hookHandlers['message_sending'](
      { text: `My key is ${FAKE_AWS_KEY}` },
      { sessionKey: 'msg-cred-1' }
    );

    expect(result).toEqual({ cancel: true });
  });

  test('크레덴셜 + dataSharing=true → sendCritical 호출 (credential_detected 이벤트)', async () => {
    const { hookHandlers, client } = setupMessageHooks({ dataSharing: true });
    createSession('msg-cred-2', 'msg-agent');

    await hookHandlers['message_sending'](
      { text: `Key: ${FAKE_AWS_KEY}` },
      { sessionKey: 'msg-cred-2' }
    );

    expect(client.sendCritical).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ event_type: 'credential_detected' }),
      })
    );
  });

  test('크레덴셜 + dataSharing=false → sendCritical 미호출', async () => {
    const { hookHandlers, client } = setupMessageHooks({ dataSharing: false });
    createSession('msg-cred-3', 'msg-agent');

    await hookHandlers['message_sending'](
      { text: `Key: ${FAKE_AWS_KEY}` },
      { sessionKey: 'msg-cred-3' }
    );

    expect(client.sendCritical).not.toHaveBeenCalled();
  });

  test('크레덴셜 감지 → logger.warn 차단 알림 출력', async () => {
    const { hookHandlers, api } = setupMessageHooks({ dataSharing: false });
    createSession('msg-cred-4', 'msg-agent');

    await hookHandlers['message_sending'](
      { text: `Key: ${FAKE_AWS_KEY}` },
      { sessionKey: 'msg-cred-4' }
    );

    expect(api.logger.warn).toHaveBeenCalled();
  });

  test('크레덴셜 없는 일반 텍스트 → {} 반환', async () => {
    const { hookHandlers } = setupMessageHooks();
    createSession('msg-cred-5', 'msg-agent');

    const result = await hookHandlers['message_sending'](
      { text: 'This is a normal message with no secrets' },
      { sessionKey: 'msg-cred-5' }
    );

    expect(result).toEqual({});
  });

  test('credentialProtection disabled → 크레덴셜 있어도 {} 반환', async () => {
    const { hookHandlers } = setupMessageHooks({
      credentialProtection: { enabled: false, blockTranscript: false, customPatterns: [] },
    });
    createSession('msg-cred-6', 'msg-agent');

    const result = await hookHandlers['message_sending'](
      { text: `Key: ${FAKE_AWS_KEY}` },
      { sessionKey: 'msg-cred-6' }
    );

    expect(result).toEqual({});
  });

  test('sessionKey 없음 → {} 즉시 반환', async () => {
    const { hookHandlers } = setupMessageHooks();

    const result = await hookHandlers['message_sending'](
      { text: 'Hello' },
      {}
    );

    expect(result).toEqual({});
  });

});

// =============================================================================
// 16~18. before_message_write — transcript 보호
// =============================================================================

describe('before_message_write — transcript 보호', () => {

  test('blockTranscript=true + 크레덴셜 → { block: true }', async () => {
    const { hookHandlers } = setupMessageHooks({
      credentialProtection: { enabled: true, blockTranscript: true, customPatterns: [] },
    });

    const result = await hookHandlers['before_message_write'](
      { text: `Key: ${FAKE_AWS_KEY}` },
      {}
    );

    expect(result).toEqual({ block: true });
  });

  test('blockTranscript=false → 크레덴셜 있어도 {} (스캔 안 함)', async () => {
    const { hookHandlers } = setupMessageHooks({
      credentialProtection: { enabled: true, blockTranscript: false, customPatterns: [] },
    });

    const result = await hookHandlers['before_message_write'](
      { text: `Key: ${FAKE_AWS_KEY}` },
      {}
    );

    expect(result).toEqual({});
  });

  test('credentialProtection disabled → {} 반환 (enabled=false)', async () => {
    const { hookHandlers } = setupMessageHooks({
      credentialProtection: { enabled: false, blockTranscript: true, customPatterns: [] },
    });

    const result = await hookHandlers['before_message_write'](
      { text: `Key: ${FAKE_AWS_KEY}` },
      {}
    );

    expect(result).toEqual({});
  });

});

// =============================================================================
// 19~20. message_received — 턴 카운터
// =============================================================================

describe('message_received — 턴 카운터', () => {

  test('메시지 수신 → turnNumber 1 증가', async () => {
    const { hookHandlers } = setupMessageHooks();
    const state = createSession('msg-recv-1', 'msg-agent');
    const before = state.turnNumber;

    await hookHandlers['message_received'](
      {},
      { sessionKey: 'msg-recv-1' }
    );

    expect(state.turnNumber).toBe(before + 1);
  });

  test('sessionKey 없음 → turnNumber 변경 없음', async () => {
    const { hookHandlers } = setupMessageHooks();
    const state = createSession('msg-recv-2', 'msg-agent');
    const before = state.turnNumber;

    await hookHandlers['message_received']({}, {});

    expect(state.turnNumber).toBe(before);
  });

});

// =============================================================================
// 21~24. tool_result_persist — 보조 크레덴셜 스캔 (§3-2)
// =============================================================================

describe('tool_result_persist — 도구 결과 크레덴셜 스캔', () => {

  test('크레덴셜 + dataSharing=true → tool_result_credential 신호 버퍼링 (META_CONTROL -0.15)', async () => {
    const { hookHandlers } = setupMessageHooks({ dataSharing: true });
    const state = createSession('msg-tr-1', 'msg-agent');

    await hookHandlers['tool_result_persist'](
      { result: `AWS key found: ${FAKE_AWS_KEY}` },
      { sessionKey: 'msg-tr-1' }
    );

    const signal = state.signalBuffer.find(
      (s) => s.metadata.event_type === 'tool_result_credential'
    );
    expect(signal).toBeDefined();
    expect(signal!.metadata.meta_control_delta).toBe(-0.15);
  });

  test('크레덴셜 없음 → {} 반환, 신호 버퍼 없음', async () => {
    const { hookHandlers } = setupMessageHooks({ dataSharing: true });
    const state = createSession('msg-tr-2', 'msg-agent');

    const result = await hookHandlers['tool_result_persist'](
      { result: 'Normal tool output, no secrets here' },
      { sessionKey: 'msg-tr-2' }
    );

    expect(result).toEqual({});
    expect(state.signalBuffer).toHaveLength(0);
  });

  test('credentialProtection disabled → 크레덴셜 있어도 {} 반환', async () => {
    const { hookHandlers } = setupMessageHooks({
      credentialProtection: { enabled: false, blockTranscript: false, customPatterns: [] },
    });
    createSession('msg-tr-3', 'msg-agent');

    const result = await hookHandlers['tool_result_persist'](
      { result: `Key: ${FAKE_AWS_KEY}` },
      { sessionKey: 'msg-tr-3' }
    );

    expect(result).toEqual({});
  });

  test('sessionKey 없음 → {} 즉시 반환', async () => {
    const { hookHandlers } = setupMessageHooks();

    const result = await hookHandlers['tool_result_persist'](
      { result: 'Something' },
      {}
    );

    expect(result).toEqual({});
  });

});
