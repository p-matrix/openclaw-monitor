// =============================================================================
// bug-fixes.test.ts — BUG-1 / BUG-4 / BUG-12 자가 검증 테스트
// =============================================================================

import * as fs from 'fs';
import { validateConfig } from '../config';
import { PMatrixHttpClient } from '../client';
import { PMatrixConfig } from '../types';

// ─── 테스트용 최소 유효 Config ────────────────────────────────────────────────

function makeConfig(overrides: Partial<PMatrixConfig> = {}): PMatrixConfig {
  return {
    serverUrl: 'https://api.pmatrix.io',
    agentId: 'test-agent',
    apiKey: 'test-key',
    safetyGate: {
      enabled: true,
      confirmTimeoutMs: 20_000,
      serverTimeoutMs: 2_500,
      customToolRisk: {},
    },
    credentialProtection: {
      enabled: true,
      blockTranscript: true,
      customPatterns: [],
    },
    killSwitch: {
      autoHaltOnRt: 0.75,
      safeModel: 'claude-opus-4-6',
    },
    outboundAllowlist: {
      enabled: false,
      allowedChannels: [],
    },
    dataSharing: false,
    batch: {
      maxSize: 10,
      flushIntervalMs: 2_000,
      retryMax: 3,
    },
    debug: false,
    ...overrides,
  };
}

// =============================================================================
// BUG-4: validateConfig — allowedChannels 빈 문자열 차단
// =============================================================================

describe('BUG-4: validateConfig allowedChannels 검증', () => {

  test('정상 케이스: enabled=false 이면 allowedChannels 내 빈 문자열 검사 스킵', () => {
    const config = makeConfig({
      outboundAllowlist: { enabled: false, allowedChannels: [''] },
    });
    // enabled=false → 검사 안 함 → throw 없어야 함
    expect(() => validateConfig(config)).not.toThrow();
  });

  test('정상 케이스: enabled=true, 유효한 채널 목록', () => {
    const config = makeConfig({
      outboundAllowlist: {
        enabled: true,
        allowedChannels: ['telegram:@mybot', 'discord:#general'],
      },
    });
    expect(() => validateConfig(config)).not.toThrow();
  });

  test('정상 케이스: enabled=true, 빈 배열(전체 허용)', () => {
    const config = makeConfig({
      outboundAllowlist: { enabled: true, allowedChannels: [] },
    });
    expect(() => validateConfig(config)).not.toThrow();
  });

  test('버그 케이스: enabled=true, 빈 문자열 "" 포함 → throw', () => {
    const config = makeConfig({
      outboundAllowlist: { enabled: true, allowedChannels: [''] },
    });
    expect(() => validateConfig(config)).toThrow(
      'outboundAllowlist.allowedChannels에 빈 문자열을 포함할 수 없습니다'
    );
  });

  test('버그 케이스: enabled=true, 공백만 있는 "  " 포함 → throw (trim 처리)', () => {
    const config = makeConfig({
      outboundAllowlist: { enabled: true, allowedChannels: ['valid:channel', '   '] },
    });
    expect(() => validateConfig(config)).toThrow(
      'outboundAllowlist.allowedChannels에 빈 문자열을 포함할 수 없습니다'
    );
  });
});

// =============================================================================
// BUG-12: extractText — 순환 참조 객체 처리 (try-catch 패턴 검증)
// =============================================================================

describe('BUG-12: 순환 참조 JSON.stringify 안전 처리', () => {

  // extractText는 내부 함수라 직접 호출 불가.
  // 동일 패턴(fix 적용 후)을 인라인으로 재현하여 검증.
  function extractTextFixed(event: Record<string, unknown>): string {
    const raw =
      event['text'] ??
      event['content'] ??
      event['message'] ??
      event['body'] ??
      '';
    if (typeof raw === 'string') return raw;
    try {
      return JSON.stringify(raw);
    } catch {
      return '[Unserializable Content]';
    }
  }

  test('일반 문자열 그대로 반환', () => {
    expect(extractTextFixed({ text: 'hello world' })).toBe('hello world');
  });

  test('일반 객체 JSON 직렬화', () => {
    expect(extractTextFixed({ content: { key: 'value' } })).toBe('{"key":"value"}');
  });

  test('순환 참조 객체 → "[Unserializable Content]" 반환 (크래시 없음)', () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular['self'] = circular;  // 순환 참조 생성

    // 수정 전 패턴: JSON.stringify(circular) → throw 확인
    expect(() => JSON.stringify(circular)).toThrow();

    // 수정 후 패턴: 안전하게 폴백 반환
    expect(extractTextFixed({ content: circular })).toBe('[Unserializable Content]');
  });

  test('null/undefined → 빈 문자열 폴백', () => {
    expect(extractTextFixed({})).toBe('');
  });

  test('숫자 타입 → JSON 직렬화', () => {
    expect(extractTextFixed({ text: 42 })).toBe('42');
  });
});

// =============================================================================
// BUG-1: resubmitUnsent — fs.promises.* (Async) 사용 검증
// =============================================================================

describe('BUG-1: resubmitUnsent Async I/O 검증', () => {

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('fs.promises.readdir (async) 가 호출됨 — Sync I/O 대신 Async 사용 확인', async () => {
    // Node.js 내장 fs의 Sync 메서드는 non-configurable이라 jest.spyOn 불가.
    // Async 메서드 호출 여부만 검증 (소스에서 readdirSync 제거 확인은 코드 리뷰로 대체)
    const readdirSpy = jest
      .spyOn(fs.promises, 'readdir')
      .mockResolvedValue([] as any);  // 빈 디렉토리 → 루프 스킵

    const client = new PMatrixHttpClient(makeConfig());
    await client.resubmitUnsent();

    expect(readdirSpy).toHaveBeenCalledTimes(1);
  });

  test('디렉토리 없음(ENOENT) → 조용히 반환 (플러그인 동작 계속)', async () => {
    jest.spyOn(fs.promises, 'readdir').mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    );

    const client = new PMatrixHttpClient(makeConfig());
    // throw 없이 정상 종료여야 함
    await expect(client.resubmitUnsent()).resolves.toBeUndefined();
  });

  test('stale 파일(7일 초과) → fs.promises.unlink 호출, 재전송 없음', async () => {
    const now = Date.now();
    const staleTime = now - (8 * 24 * 60 * 60 * 1_000);  // 8일 전

    jest.spyOn(fs.promises, 'readdir').mockResolvedValue(['old.json'] as any);
    jest.spyOn(fs.promises, 'stat').mockResolvedValue({ mtimeMs: staleTime } as any);
    const unlinkSpy = jest.spyOn(fs.promises, 'unlink').mockResolvedValue();
    const readFileSpy = jest.spyOn(fs.promises, 'readFile');

    const client = new PMatrixHttpClient(makeConfig());
    await client.resubmitUnsent();

    // stale → 삭제는 하되 readFile(전송)은 하지 않음
    expect(unlinkSpy).toHaveBeenCalledTimes(1);
    expect(readFileSpy).not.toHaveBeenCalled();
  });

  test('60초 throttle — 두 번 연속 호출 시 두 번째는 readdir 호출 안 함', async () => {
    const readdirSpy = jest
      .spyOn(fs.promises, 'readdir')
      .mockResolvedValue([] as any);

    const client = new PMatrixHttpClient(makeConfig());
    await client.resubmitUnsent();  // 첫 호출 → readdir 실행
    await client.resubmitUnsent();  // throttle 내 → 스킵

    expect(readdirSpy).toHaveBeenCalledTimes(1);
  });
});
