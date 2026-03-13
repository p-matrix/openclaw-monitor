// =============================================================================
// service.test.ts — registerBatchService 자가 검증
// =============================================================================
//
// 검증 범위:
//   1. registerBatchService → api.registerService('pmatrix-batch', fn) 등록
//   2. interval 경과 + 비어 있지 않은 버퍼 → client.sendBatch 호출
//   3. 빈 버퍼 세션 → sendBatch 미호출
//   4. 버퍼 ≥ maxSize → 즉시 플러시 조건 충족
//   5. sendBatch 실패 → api.logger.warn 호출, 크래시 없음
//   6. 매 interval마다 client.resubmitUnsent() 호출됨
//
// 주의: flushAllSessions는 미공개 함수 → setInterval 메커니즘으로 간접 검증
//       jest.advanceTimersByTimeAsync: 타이머 진행 + async 체인 처리
// =============================================================================

import {
  sessions,
  createSession,
  bufferSignal,
  buildSignalPayload,
} from '../session-state';
import { registerBatchService } from '../extensions/service';
import type { PMatrixConfig } from '../types';

// ─── 헬퍼 ────────────────────────────────────────────────────────────────────

function makeConfig(batchOverrides: Partial<PMatrixConfig['batch']> = {}): PMatrixConfig {
  return {
    serverUrl: 'https://api.pmatrix.io',
    agentId: 'svc-agent',
    apiKey: 'test-key',
    safetyGate: { enabled: true, confirmTimeoutMs: 20_000, serverTimeoutMs: 2_500 },
    credentialProtection: { enabled: true, blockTranscript: false, customPatterns: [] },
    killSwitch: { autoHaltOnRt: 0.75, safeModel: 'claude-opus-4-6' },
    outboundAllowlist: { enabled: false, allowedChannels: [] },
    dataSharing: true,
    batch: { maxSize: 5, flushIntervalMs: 2_000, retryMax: 0, ...batchOverrides },
    debug: false,
  };
}

function makeMockApi() {
  return {
    registerHook: jest.fn(),
    on: jest.fn(),
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
}

function makeMockClient() {
  return {
    sendBatch: jest.fn().mockResolvedValue({ received: 1 }),
    resubmitUnsent: jest.fn().mockResolvedValue(undefined),
    sendCritical: jest.fn().mockResolvedValue(undefined),
    healthCheck: jest.fn().mockResolvedValue({ healthy: true }),
  };
}

/** 세션에 더미 신호 N개 추가 */
function addSignals(sessionKey: string, count: number): void {
  const state = sessions.get(sessionKey);
  if (!state) throw new Error(`세션 없음: ${sessionKey}`);
  for (let i = 0; i < count; i++) {
    const signal = buildSignalPayload(state, { event_type: 'test_signal' });
    bufferSignal(sessionKey, signal);
  }
}

/** registerService로 캡처된 핸들러를 추출·실행 → setInterval 설정 */
async function startService(api: ReturnType<typeof makeMockApi>): Promise<void> {
  const calls = (api.registerService as jest.Mock).mock.calls;
  const svcDef = calls[0][0] as { id: string; start: () => Promise<void> };
  await svcDef.start();
}

// ─── 테스트 설정 ─────────────────────────────────────────────────────────────

beforeEach(() => {
  sessions.clear();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

// =============================================================================
// 1. 서비스 등록
// =============================================================================

describe('registerBatchService — 서비스 등록', () => {

  test('"pmatrix-batch" id로 registerService 호출됨', () => {
    const api = makeMockApi();
    const client = makeMockClient();
    registerBatchService(api as any, makeConfig(), client as any);

    expect(api.registerService).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'pmatrix-batch', start: expect.any(Function) })
    );
  });

  test('start 함수는 비동기 (async service handler)', () => {
    const api = makeMockApi();
    const client = makeMockClient();
    registerBatchService(api as any, makeConfig(), client as any);

    const svcDef = (api.registerService as jest.Mock).mock.calls[0][0];
    expect(svcDef.start).toBeInstanceOf(Function);
    // async function → 호출 결과가 Promise
    expect(svcDef.start()).toBeInstanceOf(Promise);
  });

});

// =============================================================================
// 2. interval → 신호 있는 세션 → sendBatch 호출
// =============================================================================

describe('flushAllSessions — 버퍼 플러시', () => {

  test('신호 있는 세션 + interval 경과 → sendBatch 호출됨', async () => {
    const api = makeMockApi();
    const client = makeMockClient();
    const config = makeConfig({ flushIntervalMs: 2_000 });

    registerBatchService(api as any, config, client as any);
    await startService(api);

    // 세션 생성 + 신호 추가
    const sessionKey = 'flush-sess-1';
    createSession(sessionKey, 'svc-agent');
    addSignals(sessionKey, 3);

    // interval 경과 → flushAllSessions 실행
    await jest.advanceTimersByTimeAsync(2_000);

    expect(client.sendBatch).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ agent_id: 'svc-agent' }),
      ])
    );
  });

  test('빈 버퍼 세션 → sendBatch 미호출', async () => {
    const api = makeMockApi();
    const client = makeMockClient();

    registerBatchService(api as any, makeConfig(), client as any);
    await startService(api);

    // 세션 있지만 신호 없음 (bufferSize=0 → continue)
    createSession('empty-sess', 'svc-agent');

    await jest.advanceTimersByTimeAsync(2_000);

    expect(client.sendBatch).not.toHaveBeenCalled();
  });

  test('버퍼 ≥ maxSize → shouldFlush=true (interval 내 플러시)', async () => {
    const api = makeMockApi();
    const client = makeMockClient();
    // maxSize=2 — 버퍼에 5개를 넣으면 shouldFlush 조건 충족
    const config = makeConfig({ maxSize: 2, flushIntervalMs: 2_000 });

    registerBatchService(api as any, config, client as any);
    await startService(api);

    const sessionKey = 'big-buf-sess';
    createSession(sessionKey, 'svc-agent');
    addSignals(sessionKey, 5);  // maxSize(2) 초과

    await jest.advanceTimersByTimeAsync(2_000);

    expect(client.sendBatch).toHaveBeenCalled();
  });

  test('여러 세션 — 신호 있는 세션만 플러시됨', async () => {
    const api = makeMockApi();
    const client = makeMockClient();

    registerBatchService(api as any, makeConfig(), client as any);
    await startService(api);

    createSession('sess-a', 'svc-agent');
    addSignals('sess-a', 3);

    createSession('sess-b', 'svc-agent');  // 빈 버퍼

    await jest.advanceTimersByTimeAsync(2_000);

    // sess-a만 플러시, sess-b는 건너뜀
    expect(client.sendBatch).toHaveBeenCalledTimes(1);
  });

});

// =============================================================================
// 3. 전송 실패 → logger.warn
// =============================================================================

describe('flushSession — 전송 실패 처리', () => {

  test('sendBatch 실패 → logger.warn 호출, 크래시 없음', async () => {
    const api = makeMockApi();
    const client = makeMockClient();
    client.sendBatch.mockRejectedValue(new Error('Network timeout'));

    registerBatchService(api as any, makeConfig(), client as any);
    await startService(api);

    const sessionKey = 'fail-sess';
    createSession(sessionKey, 'svc-agent');
    addSignals(sessionKey, 3);

    // 크래시 없이 완료되어야 함
    await expect(jest.advanceTimersByTimeAsync(2_000)).resolves.not.toThrow();

    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Batch send failed')
    );
  });

  test('전송 실패 후 세션 존재 유지 (버퍼만 비워짐)', async () => {
    const api = makeMockApi();
    const client = makeMockClient();
    client.sendBatch.mockRejectedValue(new Error('Server error'));

    registerBatchService(api as any, makeConfig(), client as any);
    await startService(api);

    const sessionKey = 'persist-sess';
    createSession(sessionKey, 'svc-agent');
    addSignals(sessionKey, 2);

    await jest.advanceTimersByTimeAsync(2_000);

    // 세션은 여전히 존재
    expect(sessions.has(sessionKey)).toBe(true);
  });

});

// =============================================================================
// 4. resubmitUnsent — 매 interval마다 호출
// =============================================================================

describe('resubmitUnsent — 주기적 호출', () => {

  test('interval마다 client.resubmitUnsent() 1회씩 호출', async () => {
    const api = makeMockApi();
    const client = makeMockClient();
    const config = makeConfig({ flushIntervalMs: 1_000 });

    registerBatchService(api as any, config, client as any);
    await startService(api);

    await jest.advanceTimersByTimeAsync(1_000);
    expect(client.resubmitUnsent).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(1_000);
    expect(client.resubmitUnsent).toHaveBeenCalledTimes(2);
  });

});
