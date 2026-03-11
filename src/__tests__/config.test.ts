// =============================================================================
// config.test.ts — loadConfig / resolveEnvRef / validateConfig 자가 검증
// =============================================================================
//
// 검증 범위:
//   1. resolveEnvRef — "${VAR}" 환경변수 참조 치환 (loadConfig 통해 간접 검증)
//      - 정상 치환 / 미설정 변수 → 기본값 / 리터럴 문자열 / 불완전 문법
//   2. loadConfig — 설정 우선순위: env var > json > DEFAULT_CONFIG
//      - 4개 환경변수(PMATRIX_API_KEY, SERVER_URL, AGENT_ID, DEBUG)
//   3. loadConfig — 파일 처리
//      - 파일 없음 / JSON 파싱 실패 → fail-open, 기본값 유지
//      - 부분 설정 → 기본값과 병합(spread)
//   4. validateConfig — confirmTimeoutMs 경계값 [10_000, 30_000]
//      - 하한/상한 포함 경계 유효, 1ms 초과 시 throw
// =============================================================================

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadConfig, validateConfig } from '../config';
import type { PMatrixConfig } from '../types';

// ─── 테스트 헬퍼 ──────────────────────────────────────────────────────────────

/** 임시 config.json 생성, 경로 반환 */
const tmpFiles: string[] = [];

function createTempConfig(content: object): string {
  const tmpPath = path.join(
    os.tmpdir(),
    `pmatrix-cfg-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  );
  fs.writeFileSync(tmpPath, JSON.stringify(content), 'utf-8');
  tmpFiles.push(tmpPath);
  return tmpPath;
}

/** 환경변수 원본 백업 (첫 호출 시 1회) */
const envBackup: Record<string, string | undefined> = {};

function setEnv(key: string, value: string): void {
  if (!(key in envBackup)) envBackup[key] = process.env[key];
  process.env[key] = value;
}

function unsetEnv(key: string): void {
  if (!(key in envBackup)) envBackup[key] = process.env[key];
  delete process.env[key];
}

afterEach(() => {
  // 환경변수 복원
  for (const [key, orig] of Object.entries(envBackup)) {
    if (orig === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = orig;
    }
  }
  for (const key of Object.keys(envBackup)) delete envBackup[key];

  // 임시 파일 정리
  for (const p of tmpFiles) {
    try { fs.unlinkSync(p); } catch { /* ignore */ }
  }
  tmpFiles.length = 0;
});

// ─── validateConfig용 최소 유효 Config 팩토리 ────────────────────────────────

function baseConfig(overrides: Partial<PMatrixConfig> = {}): PMatrixConfig {
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
    credentialProtection: { enabled: true, blockTranscript: true, customPatterns: [] },
    killSwitch: { autoHaltOnRt: 0.75, safeModel: 'claude-opus-4-6' },
    outboundAllowlist: { enabled: false, allowedChannels: [] },
    dataSharing: false,
    batch: { maxSize: 10, flushIntervalMs: 2_000, retryMax: 3 },
    debug: false,
    ...overrides,
  };
}

// =============================================================================
// 1. resolveEnvRef — "${VAR}" 환경변수 참조 치환
// =============================================================================

describe('resolveEnvRef — 환경변수 참조 치환 (loadConfig 통해 간접 검증)', () => {

  test('"${MY_VAR}" → process.env.MY_VAR 값으로 치환', () => {
    // PMATRIX_API_KEY 직접 환경변수는 우선순위가 더 높으므로 제거
    unsetEnv('PMATRIX_API_KEY');
    setEnv('PMATRIX_TEST_RESOLVE_KEY', 'resolved-api-key-value');

    const tmpPath = createTempConfig({
      apiKey: '${PMATRIX_TEST_RESOLVE_KEY}',
    });

    const config = loadConfig(tmpPath);
    expect(config.apiKey).toBe('resolved-api-key-value');
  });

  test('"${UNSET_VAR}" — 미설정 변수 → undefined → 기본값("")으로 폴백', () => {
    unsetEnv('PMATRIX_API_KEY');
    unsetEnv('PMATRIX_TEST_DEFINITELY_UNSET_XYZ');  // 확실히 없음

    const tmpPath = createTempConfig({
      apiKey: '${PMATRIX_TEST_DEFINITELY_UNSET_XYZ}',
    });

    const config = loadConfig(tmpPath);
    // resolveEnvRef → undefined → DEFAULT_CONFIG.apiKey = ''
    expect(config.apiKey).toBe('');
  });

  test('"plain-string" (참조 없음) → 리터럴 그대로 사용', () => {
    unsetEnv('PMATRIX_API_KEY');

    const tmpPath = createTempConfig({
      apiKey: 'literal-api-key-value',
    });

    const config = loadConfig(tmpPath);
    expect(config.apiKey).toBe('literal-api-key-value');
  });

  test('"${UNCLOSED" (닫는 중괄호 없음) → 정규식 불일치 → 리터럴로 처리', () => {
    // /^\$\{(.+)\}$/ — 완전한 형식이 아니면 매칭 실패 → 원본 반환
    unsetEnv('PMATRIX_API_KEY');

    const tmpPath = createTempConfig({
      apiKey: '${UNCLOSED_BRACKET',
    });

    const config = loadConfig(tmpPath);
    expect(config.apiKey).toBe('${UNCLOSED_BRACKET');
  });

  test('"${VAR}" — 환경변수 참조와 PMATRIX_API_KEY 직접 설정 동시: 직접 env가 우선', () => {
    setEnv('PMATRIX_API_KEY', 'direct-env-wins');
    setEnv('PMATRIX_TEST_JSON_VAR', 'json-ref-value');

    const tmpPath = createTempConfig({
      apiKey: '${PMATRIX_TEST_JSON_VAR}',
    });

    const config = loadConfig(tmpPath);
    // process.env['PMATRIX_API_KEY'] ?? resolveEnvRef(...) → 직접 env 우선
    expect(config.apiKey).toBe('direct-env-wins');
  });

});

// =============================================================================
// 2. loadConfig — 설정 우선순위: 환경변수 > json > 기본값
// =============================================================================

describe('loadConfig — 설정 우선순위 (env > json > default)', () => {

  test('PMATRIX_API_KEY 환경변수 → json apiKey보다 우선', () => {
    setEnv('PMATRIX_API_KEY', 'env-api-key');

    const tmpPath = createTempConfig({
      apiKey: 'json-api-key',
    });

    expect(loadConfig(tmpPath).apiKey).toBe('env-api-key');
  });

  test('PMATRIX_SERVER_URL 환경변수 → json serverUrl보다 우선', () => {
    setEnv('PMATRIX_SERVER_URL', 'https://env.pmatrix.io');

    const tmpPath = createTempConfig({
      serverUrl: 'https://json.pmatrix.io',
    });

    expect(loadConfig(tmpPath).serverUrl).toBe('https://env.pmatrix.io');
  });

  test('PMATRIX_AGENT_ID 환경변수 → json agentId보다 우선', () => {
    setEnv('PMATRIX_AGENT_ID', 'env-agent-id');

    const tmpPath = createTempConfig({
      agentId: 'json-agent-id',
    });

    expect(loadConfig(tmpPath).agentId).toBe('env-agent-id');
  });

  test('PMATRIX_DEBUG=1 → debug=true (json debug=false 무관)', () => {
    setEnv('PMATRIX_DEBUG', '1');

    const tmpPath = createTempConfig({
      debug: false,
    });

    expect(loadConfig(tmpPath).debug).toBe(true);
  });

  test('PMATRIX_DEBUG="0" → env 조건 불충족, json debug=true 반영', () => {
    setEnv('PMATRIX_DEBUG', '0');

    const tmpPath = createTempConfig({
      debug: true,
    });

    expect(loadConfig(tmpPath).debug).toBe(true);
  });

  test('PMATRIX_DEBUG 미설정, json debug=true → debug=true', () => {
    unsetEnv('PMATRIX_DEBUG');

    const tmpPath = createTempConfig({
      debug: true,
    });

    expect(loadConfig(tmpPath).debug).toBe(true);
  });

  test('env 없음 + json 없음 → 전체 DEFAULT_CONFIG 반환', () => {
    unsetEnv('PMATRIX_API_KEY');
    unsetEnv('PMATRIX_SERVER_URL');
    unsetEnv('PMATRIX_AGENT_ID');
    unsetEnv('PMATRIX_DEBUG');

    const tmpPath = createTempConfig({});  // 빈 설정

    const config = loadConfig(tmpPath);
    expect(config.serverUrl).toBe('https://api.pmatrix.io');
    expect(config.apiKey).toBe('');
    expect(config.agentId).toBe('');
    expect(config.debug).toBe(false);
    expect(config.dataSharing).toBe(false);
    expect(config.safetyGate.confirmTimeoutMs).toBe(20_000);
    expect(config.batch.retryMax).toBe(3);
  });

});

// =============================================================================
// 3. loadConfig — 파일 처리 및 기본값 병합
// =============================================================================

describe('loadConfig — 파일 처리 및 부분 설정 병합', () => {

  test('파일 없음 → 기본값 반환, 크래시 없음', () => {
    const nonExistent = path.join(os.tmpdir(), `no-such-file-${Date.now()}.json`);
    const config = loadConfig(nonExistent);

    expect(config.serverUrl).toBe('https://api.pmatrix.io');
    expect(config.safetyGate.enabled).toBe(true);
    expect(config.credentialProtection.blockTranscript).toBe(true);
    expect(config.safetyGate.confirmTimeoutMs).toBe(20_000);
  });

  test('JSON 파싱 실패(깨진 파일) → 기본값 반환, 크래시 없음', () => {
    const brokenPath = path.join(os.tmpdir(), `broken-${Date.now()}.json`);
    fs.writeFileSync(brokenPath, '{ invalid json !!', 'utf-8');
    tmpFiles.push(brokenPath);

    const config = loadConfig(brokenPath);
    expect(config.serverUrl).toBe('https://api.pmatrix.io');
  });

  test('safetyGate 부분 설정 → 나머지는 기본값과 병합', () => {
    const tmpPath = createTempConfig({
      safetyGate: { confirmTimeoutMs: 15_000 },  // serverTimeoutMs 미지정
    });

    const config = loadConfig(tmpPath);
    expect(config.safetyGate.confirmTimeoutMs).toBe(15_000);  // json 값
    expect(config.safetyGate.serverTimeoutMs).toBe(2_500);    // 기본값 유지
    expect(config.safetyGate.enabled).toBe(true);             // 기본값 유지
  });

  test('credentialProtection 부분 설정 → 나머지 기본값 유지', () => {
    const tmpPath = createTempConfig({
      credentialProtection: { blockTranscript: false },
    });

    const config = loadConfig(tmpPath);
    expect(config.credentialProtection.blockTranscript).toBe(false);  // json 값
    expect(config.credentialProtection.enabled).toBe(true);            // 기본값 유지
    expect(config.credentialProtection.customPatterns).toEqual([]);    // 기본값 유지
  });

  test('batch 부분 설정 → 나머지 기본값 유지', () => {
    const tmpPath = createTempConfig({
      batch: { retryMax: 5 },
    });

    const config = loadConfig(tmpPath);
    expect(config.batch.retryMax).toBe(5);          // json 값
    expect(config.batch.maxSize).toBe(10);           // 기본값 유지
    expect(config.batch.flushIntervalMs).toBe(2_000); // 기본값 유지
  });

  test('killSwitch 전체 재정의', () => {
    const tmpPath = createTempConfig({
      killSwitch: { autoHaltOnRt: 0.60, safeModel: 'claude-haiku-4-5' },
    });

    const config = loadConfig(tmpPath);
    expect(config.killSwitch.autoHaltOnRt).toBe(0.60);
    expect(config.killSwitch.safeModel).toBe('claude-haiku-4-5');
  });

  test('dataSharing + agreedAt 설정', () => {
    const tmpPath = createTempConfig({
      dataSharing: true,
      agreedAt: '2026-01-15T09:00:00Z',
    });

    const config = loadConfig(tmpPath);
    expect(config.dataSharing).toBe(true);
    expect(config.agreedAt).toBe('2026-01-15T09:00:00Z');
  });

});

// =============================================================================
// 4. validateConfig — confirmTimeoutMs 경계값 검증
// =============================================================================

describe('validateConfig — confirmTimeoutMs 범위 [10_000, 30_000]', () => {

  test('10_000 (하한 포함) → 유효', () => {
    const config = baseConfig();
    config.safetyGate.confirmTimeoutMs = 10_000;
    expect(() => validateConfig(config)).not.toThrow();
  });

  test('30_000 (상한 포함) → 유효', () => {
    const config = baseConfig();
    config.safetyGate.confirmTimeoutMs = 30_000;
    expect(() => validateConfig(config)).not.toThrow();
  });

  test('20_000 (기본값, 중간값) → 유효', () => {
    const config = baseConfig();
    expect(() => validateConfig(config)).not.toThrow();
  });

  test('9_999 (하한 미만 1ms) → throw (confirmTimeoutMs 메시지 포함)', () => {
    const config = baseConfig();
    config.safetyGate.confirmTimeoutMs = 9_999;
    expect(() => validateConfig(config)).toThrow('confirmTimeoutMs');
  });

  test('30_001 (상한 초과 1ms) → throw', () => {
    const config = baseConfig();
    config.safetyGate.confirmTimeoutMs = 30_001;
    expect(() => validateConfig(config)).toThrow('confirmTimeoutMs');
  });

  test('0 (극단값) → throw', () => {
    const config = baseConfig();
    config.safetyGate.confirmTimeoutMs = 0;
    expect(() => validateConfig(config)).toThrow('confirmTimeoutMs');
  });

});
