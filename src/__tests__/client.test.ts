// =============================================================================
// client.test.ts — PMatrixHttpClient 자가 검증
// =============================================================================
//
// 검증 범위:
//   1. extractRtFromResponse — 정적 메서드: 완전/부분 응답 처리
//   2. healthCheck — fail-open: 성공/실패/네트워크 에러/agentId 없음
//   3. sendBatch — 빈 배열 즉시 반환, 전송 성공, 전송 실패 → backupToLocal
// =============================================================================

import * as fs from 'fs';
import { PMatrixHttpClient } from '../client';
import type { PMatrixConfig, BatchSendResponse, SignalPayload } from '../types';

// fs I/O 모킹 — backupToLocal 검증용
// FIX #8: backupToLocal이 비동기(fs.promises) 로 변경됨 → mkdir/writeFile 추가
jest.mock('fs', () => ({
  ...jest.requireActual<typeof import('fs')>('fs'),
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
  promises: {
    readdir: jest.fn().mockRejectedValue({ code: 'ENOENT' }),
    stat: jest.fn(),
    readFile: jest.fn(),
    unlink: jest.fn(),
    mkdir: jest.fn().mockResolvedValue(undefined),
    writeFile: jest.fn().mockResolvedValue(undefined),
  },
}));

// ─── 헬퍼 ────────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<PMatrixConfig> = {}): PMatrixConfig {
  return {
    serverUrl: 'https://api.pmatrix.io',
    agentId: 'test-agent',
    apiKey: 'test-key',
    safetyGate: { enabled: true, confirmTimeoutMs: 20_000, serverTimeoutMs: 2_500 },
    credentialProtection: { enabled: true, blockTranscript: false, customPatterns: [] },
    killSwitch: { autoHaltOnRt: 0.75, safeModel: 'claude-opus-4-6' },
    outboundAllowlist: { enabled: false, allowedChannels: [] },
    dataSharing: true,
    // retryMax: 0 → 재시도 없음, 테스트 빠르게 완료
    batch: { maxSize: 10, flushIntervalMs: 2_000, retryMax: 0 },
    debug: false,
    ...overrides,
  };
}

function makeSignal(): SignalPayload {
  return {
    agent_id: 'test-agent',
    baseline: 1.0,
    norm: 1.0,
    stability: 0.0,
    meta_control: 1.0,
    timestamp: new Date().toISOString(),
    signal_source: 'adapter_stream',
    framework: 'openclaw',
    framework_tag: 'beta',
    schema_version: '0.3',
    metadata: { event_type: 'unit_test' },
    state_vector: null,
  };
}

/** HTTP 200 OK fetch 모킹 — bun-types 호환을 위해 반환 타입 생략 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function mockFetchOk(body: unknown) {
  return jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: jest.fn().mockResolvedValue(JSON.stringify(body)),
  } as unknown as Response);
}

/** HTTP 에러 fetch 모킹 — bun-types 호환을 위해 반환 타입 생략 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function mockFetchFail(status = 500, text = 'Internal Server Error') {
  return jest.fn().mockResolvedValue({
    ok: false,
    status,
    text: jest.fn().mockResolvedValue(text),
  } as unknown as Response);
}

beforeEach(() => {
  jest.clearAllMocks();
});

// =============================================================================
// 1. extractRtFromResponse — 정적 메서드
// =============================================================================

describe('extractRtFromResponse — 완전/부분 응답 처리', () => {

  test('완전한 응답 → rt/grade/mode/axes 모두 반환', () => {
    const res: BatchSendResponse = {
      received: 1,
      risk: 0.25,
      grade: 'B',
      mode: 'A+0',
      axes: { baseline: 0.9, norm: 0.8, stability: 0.1, meta_control: 0.95 },
    };
    const result = PMatrixHttpClient.extractRtFromResponse(res);
    expect(result).not.toBeNull();
    expect(result!.rt).toBe(0.25);
    expect(result!.grade).toBe('B');
    expect(result!.mode).toBe('A+0');
    expect(result!.axes.baseline).toBe(0.9);
    expect(result!.axes.meta_control).toBe(0.95);
  });

  test('risk 없음 → null', () => {
    const res: BatchSendResponse = {
      received: 1,
      grade: 'B',
      mode: 'A+0',
      axes: { baseline: 0.9, norm: 0.8, stability: 0.1, meta_control: 0.95 },
    };
    expect(PMatrixHttpClient.extractRtFromResponse(res)).toBeNull();
  });

  test('grade 없음 → null', () => {
    const res: BatchSendResponse = {
      received: 1,
      risk: 0.25,
      mode: 'A+0',
      axes: { baseline: 0.9, norm: 0.8, stability: 0.1, meta_control: 0.95 },
    };
    expect(PMatrixHttpClient.extractRtFromResponse(res)).toBeNull();
  });

  test('mode 없음 → null', () => {
    const res: BatchSendResponse = {
      received: 1,
      risk: 0.25,
      grade: 'A',
      axes: { baseline: 0.9, norm: 0.8, stability: 0.1, meta_control: 0.95 },
    };
    expect(PMatrixHttpClient.extractRtFromResponse(res)).toBeNull();
  });

  test('axes 없음 → null', () => {
    const res: BatchSendResponse = { received: 1, risk: 0.25, grade: 'B', mode: 'A+0' };
    expect(PMatrixHttpClient.extractRtFromResponse(res)).toBeNull();
  });

  test('received만 있는 최소 응답 → null', () => {
    expect(PMatrixHttpClient.extractRtFromResponse({ received: 0 })).toBeNull();
  });

});

// =============================================================================
// 2. healthCheck — fail-open 설계 (§5-1)
// =============================================================================

describe('healthCheck — fail-open 설계', () => {

  const gradeData = {
    agent_id: 'test-agent',
    grade: 'B' as const,
    p_score: 80,
    risk: 0.20,
    mode: 'A+0' as const,
    axes: { baseline: 0.9, norm: 0.8, stability: 0.1, meta_control: 0.95 },
    last_updated: new Date().toISOString(),
  };

  test('fetch 성공 → { healthy: true, grade } 반환', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(mockFetchOk(gradeData));

    const client = new PMatrixHttpClient(makeConfig());
    const result = await client.healthCheck();

    expect(result.healthy).toBe(true);
    expect(result.grade).toBeDefined();
    expect(result.grade!.grade).toBe('B');
    expect(result.grade!.risk).toBe(0.20);
  });

  test('HTTP 503 → { healthy: false } (fail-open)', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(mockFetchFail(503));

    const client = new PMatrixHttpClient(makeConfig());
    const result = await client.healthCheck();

    expect(result.healthy).toBe(false);
    expect(result.grade).toBeUndefined();
  });

  test('네트워크 에러 (ECONNREFUSED) → { healthy: false } (fail-open)', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

    const client = new PMatrixHttpClient(makeConfig());
    const result = await client.healthCheck();

    expect(result.healthy).toBe(false);
  });

  test('agentId 빈 문자열 → 즉시 { healthy: false }, fetch 미호출', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    const client = new PMatrixHttpClient(makeConfig({ agentId: '' }));
    const result = await client.healthCheck();

    expect(result.healthy).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

});

// =============================================================================
// 3. sendBatch — 빈 배열 / 성공 / 실패 → backupToLocal
// =============================================================================

describe('sendBatch — 전송 로직', () => {

  test('빈 배열 → { received: 0 } 즉시 반환, fetch 미호출', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    const client = new PMatrixHttpClient(makeConfig());

    const result = await client.sendBatch([]);

    expect(result).toEqual({ received: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('신호 1개 → fetch 1회 호출, BatchSendResponse 반환', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(mockFetchOk({ received: 1 }));

    const client = new PMatrixHttpClient(makeConfig());
    const result = await client.sendBatch([makeSignal()]);

    expect(result.received).toBe(1);
  });

  test('신호 복수 → fetch 1회 (배열로 단일 POST)', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(
      mockFetchOk({ received: 3 })
    );

    const client = new PMatrixHttpClient(makeConfig());
    await client.sendBatch([makeSignal(), makeSignal(), makeSignal()]);

    // sendBatchDirect: 여러 신호는 배열로 묶어 단일 요청
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test('HTTP 500 → backupToLocal (fs.promises.mkdir + writeFile) 호출 후 에러 재throw', async () => {
    // FIX #8: backupToLocal이 비동기로 변경 → fs.promises.mkdir / writeFile 검증
    jest.spyOn(global, 'fetch').mockImplementation(mockFetchFail(500));

    const client = new PMatrixHttpClient(makeConfig());

    await expect(client.sendBatch([makeSignal()])).rejects.toThrow('HTTP 500');

    // backupToLocal: ~/.pmatrix/unsent/{timestamp}.json 비동기 생성
    expect((fs.promises as jest.Mocked<typeof fs.promises>).mkdir).toHaveBeenCalledWith(
      expect.stringContaining('.pmatrix'),
      expect.objectContaining({ recursive: true })
    );
    expect((fs.promises as jest.Mocked<typeof fs.promises>).writeFile).toHaveBeenCalledWith(
      expect.stringContaining('.json'),
      expect.any(String),
      'utf-8'
    );
  });

  test('retryMax=0 → 1회 시도 후 즉시 throw (재시도 없음)', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(mockFetchFail(503));

    const client = new PMatrixHttpClient(
      makeConfig({ batch: { maxSize: 10, flushIntervalMs: 2_000, retryMax: 0 } })
    );

    await expect(client.sendBatch([makeSignal()])).rejects.toThrow();

    // retryMax=0 → attempt 0만 실행 (총 1회)
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test('전송 성공 시 backupToLocal 미호출', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(mockFetchOk({ received: 1 }));

    const client = new PMatrixHttpClient(makeConfig());
    await client.sendBatch([makeSignal()]);

    expect(fs.mkdirSync).not.toHaveBeenCalled();
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

});

// =============================================================================
// 4. resubmitUnsent — BUG-5 unsent 파일 재전송 (60초 throttle + stale 삭제)
// =============================================================================

describe('resubmitUnsent — BUG-5 unsent 백업 재전송', () => {

  const readdir = () => fs.promises.readdir as jest.Mock;
  const stat    = () => fs.promises.stat as jest.Mock;
  const readFile = () => fs.promises.readFile as jest.Mock;
  const unlink  = () => fs.promises.unlink as jest.Mock;

  test('readdir ENOENT → 즉시 반환, 다른 fs 호출 없음', async () => {
    // 기본 mock: readdir는 ENOENT로 reject (상단 jest.mock에서 설정)
    const client = new PMatrixHttpClient(makeConfig());
    await expect(client.resubmitUnsent()).resolves.toBeUndefined();
    expect(stat()).not.toHaveBeenCalled();
    expect(unlink()).not.toHaveBeenCalled();
  });

  test('60초 throttle — 연속 호출 시 2번째는 readdir 미호출', async () => {
    readdir().mockResolvedValue([]); // 빈 디렉토리

    const client = new PMatrixHttpClient(makeConfig());
    await client.resubmitUnsent();  // 1번: lastResubmitAt 설정
    await client.resubmitUnsent();  // 2번: throttle → 즉시 반환

    // readdir는 1번만 호출됨 (2번째는 throttle로 스킵)
    expect(readdir()).toHaveBeenCalledTimes(1);
  });

  test('stale 파일 (7일 초과) → readFile 없이 unlink만 호출', async () => {
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1_000;
    readdir().mockResolvedValueOnce(['old-signal.json']);
    stat().mockResolvedValueOnce({ mtimeMs: eightDaysAgo });
    unlink().mockResolvedValueOnce(undefined);

    const client = new PMatrixHttpClient(makeConfig());
    await client.resubmitUnsent();

    // 전송 없이 삭제만
    expect(readFile()).not.toHaveBeenCalled();
    expect(unlink()).toHaveBeenCalledWith(
      expect.stringContaining('old-signal.json')
    );
  });

  test('정상 파일 → readFile + sendBatchDirect + unlink', async () => {
    readdir().mockResolvedValueOnce(['fresh.json']);
    stat().mockResolvedValueOnce({ mtimeMs: Date.now() - 1_000 }); // 1초 전
    readFile().mockResolvedValueOnce(JSON.stringify([makeSignal()]));
    unlink().mockResolvedValueOnce(undefined);
    jest.spyOn(global, 'fetch').mockImplementation(mockFetchOk({ received: 1 }));

    const client = new PMatrixHttpClient(makeConfig());
    await client.resubmitUnsent();

    expect(readFile()).toHaveBeenCalled();
    expect(unlink()).toHaveBeenCalledWith(
      expect.stringContaining('fresh.json')
    );
  });

  test('sendBatchDirect 실패 → 파일 유지 (unlink 미호출)', async () => {
    readdir().mockResolvedValueOnce(['fail.json']);
    stat().mockResolvedValueOnce({ mtimeMs: Date.now() - 1_000 });
    readFile().mockResolvedValueOnce(JSON.stringify([makeSignal()]));
    jest.spyOn(global, 'fetch').mockImplementation(mockFetchFail(500));

    const client = new PMatrixHttpClient(makeConfig());
    await client.resubmitUnsent(); // silent fail — 예외 전파 없음

    // 전송 실패 → unlink 미호출 (파일 유지)
    expect(unlink()).not.toHaveBeenCalled();
  });

  test('MAX_RESUBMIT_FILES=5 → json 파일만 최대 5개 처리', async () => {
    // 6개 json + 1개 txt → .json만 6개지만 slice(0,5)로 5개 처리
    readdir().mockResolvedValueOnce([
      '1.json', '2.json', '3.json', '4.json', '5.json', '6.json', 'notes.txt',
    ]);
    stat().mockResolvedValue({ mtimeMs: Date.now() - 1_000 });
    readFile().mockResolvedValue(JSON.stringify([makeSignal()]));
    unlink().mockResolvedValue(undefined);
    jest.spyOn(global, 'fetch').mockImplementation(mockFetchOk({ received: 1 }));

    const client = new PMatrixHttpClient(makeConfig());
    await client.resubmitUnsent();

    // stat은 정확히 5번 호출 (slice(0, MAX_RESUBMIT_FILES=5))
    expect(stat()).toHaveBeenCalledTimes(5);
  });

});
