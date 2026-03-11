// =============================================================================
// credential-scanner.test.ts — scanCredentials / isLikelyTestContent 자가 검증
// =============================================================================
//
// 검증 범위:
//   1. isLikelyTestContent — 6가지 조건, 대소문자 무시
//   2. 기본 동작 — 빈 문자열, 크레덴셜 없음, isLikelyTestContent 조기 반환
//   3. 내장 패턴 11종 — 각 패턴별 탐지, 복수 패턴, count 누적
//   4. TEST_EXCLUSIONS 필터 — 개별 매칭값 필터 vs 전체 텍스트 필터 구분
//   5. 코드블록 제거 — 펜스드(```/~~~), 인라인(`), 코드블록 밖 탐지
//   6. 커스텀 패턴 — 유효/무효 정규식, TEST_EXCLUSIONS 적용, 내장 패턴 공존
// =============================================================================

import { scanCredentials, isLikelyTestContent } from '../credential-scanner';

// =============================================================================
// isLikelyTestContent — 빠른 전체 텍스트 사전 체크
// =============================================================================

describe('isLikelyTestContent', () => {

  test('빈 문자열 → false', () => {
    expect(isLikelyTestContent('')).toBe(false);
  });

  test('"your-api-key-here" 포함 → true', () => {
    expect(isLikelyTestContent('OPENAI_KEY=your-api-key-here')).toBe(true);
  });

  test('"YOUR-API-KEY-HERE" (대문자) → true (toLowerCase 처리)', () => {
    // lower.includes('your-api-key-here') — 소문자 변환 후 비교
    expect(isLikelyTestContent('export KEY=YOUR-API-KEY-HERE')).toBe(true);
  });

  test('"insert_key" 포함 → true', () => {
    expect(isLikelyTestContent('Please insert_key in config')).toBe(true);
  });

  test('"replace_with" 포함 → true', () => {
    expect(isLikelyTestContent('replace_with your actual key')).toBe(true);
  });

  test('"<your_" 포함 → true (대소문자 무시)', () => {
    // "<YOUR_ANTHROPIC_KEY>" → lower = "<your_anthropic_key>" → includes '<your_')
    expect(isLikelyTestContent('API_KEY=<YOUR_ANTHROPIC_KEY>')).toBe(true);
  });

  test('"## example" 포함 → true', () => {
    // ## Example → lower includes '## example'
    expect(isLikelyTestContent('## Example\nSome content here')).toBe(true);
  });

  test('"# example" 포함 → true', () => {
    expect(isLikelyTestContent('# Example Usage\nCode here')).toBe(true);
  });

  test('일반 텍스트 (아무 조건 미해당) → false', () => {
    expect(isLikelyTestContent('Hello world. This is production code.')).toBe(false);
  });

  test('실제 크레덴셜 형식 텍스트 → false (패턴 스캔 아님)', () => {
    // isLikelyTestContent는 템플릿 텍스트 감지용 — 실제 크레덴셜은 true 반환 안 함
    expect(isLikelyTestContent('sk-proj-abcdefghijklmnopqrstu is the key')).toBe(false);
  });

});

// =============================================================================
// scanCredentials — 기본 동작
// =============================================================================

describe('scanCredentials — 기본 동작', () => {

  test('빈 문자열 → []', () => {
    expect(scanCredentials('')).toEqual([]);
  });

  test('크레덴셜 없는 일반 텍스트 → []', () => {
    const text = 'Hello world. This is a regular message with no secrets at all.';
    expect(scanCredentials(text)).toEqual([]);
  });

  test('FIX #11: isLikelyTestContent 전역 스킵 제거 — 실제 형식 크레덴셜은 탐지됨', () => {
    // FIX #11: "your-api-key-here" 컨텍스트가 있어도 실제 형식이면 탐지됨.
    // 전역 스킵은 Payload Injection 우회 취약점이므로 제거됨.
    // 개별 매칭값 단위의 isTestValue 필터는 하단 Step 3에서 유지.
    const text = 'your-api-key-here: sk-proj-abcdefghijklmnopqrstu';
    expect(scanCredentials(text)).toEqual([{ name: 'OpenAI Project Key', count: 1 }]);
  });

  test('customPatterns 기본값(빈 배열) 정상 동작', () => {
    const text = 'No credentials here';
    expect(() => scanCredentials(text)).not.toThrow();
    expect(scanCredentials(text)).toEqual([]);
  });

});

// =============================================================================
// scanCredentials — 내장 패턴 11종
// =============================================================================

describe('scanCredentials — 내장 패턴 11종', () => {

  // ── 1. OpenAI Project Key ──────────────────────────────────────────────────

  test('[1] OpenAI Project Key (sk-proj-) 탐지', () => {
    // sk-proj-[A-Za-z0-9\-_]{20,}  — suffix 21자
    const text = 'My key is sk-proj-abcdefghijklmnopqrstu here.';
    const results = scanCredentials(text);
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe('OpenAI Project Key');
    expect(results[0]!.count).toBe(1);
  });

  // ── 2. Anthropic Key ──────────────────────────────────────────────────────

  test('[2] Anthropic Key (sk-ant-) 탐지', () => {
    // sk-ant-[A-Za-z0-9\-]{40,}  — suffix 40자 (a×26 + A-N×14)
    const text = 'key: sk-ant-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN';
    const results = scanCredentials(text);
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe('Anthropic Key');
    expect(results[0]!.count).toBe(1);
  });

  // ── 3. AWS Access Key ─────────────────────────────────────────────────────

  test('[3] AWS Access Key (AKIA...) 탐지', () => {
    // AKIA[0-9A-Z]{16}  — 총 20자
    const text = 'AWS_ACCESS_KEY_ID=AKIAIAAAABBBBBBBBBBB';
    const results = scanCredentials(text);
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe('AWS Access Key');
    expect(results[0]!.count).toBe(1);
  });

  // ── 4. GitHub Token ───────────────────────────────────────────────────────

  test('[4] GitHub Token (ghp_) 탐지', () => {
    // ghp_[A-Za-z0-9]{36}  — suffix 36자 (a-z×26 + A-J×10)
    const text = 'token: ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ';
    const results = scanCredentials(text);
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe('GitHub Token');
    expect(results[0]!.count).toBe(1);
  });

  // ── 5. GitHub Fine-grained Token ─────────────────────────────────────────

  test('[5] GitHub Fine-grained Token (github_pat_) 탐지', () => {
    // github_pat_[A-Za-z0-9_]{82}
    const pat = 'github_pat_' + 'a'.repeat(82);
    const results = scanCredentials(pat);
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe('GitHub Fine-grained Token');
    expect(results[0]!.count).toBe(1);
  });

  // ── 6. Private Key (PEM) ──────────────────────────────────────────────────

  test('[6] Private Key PEM (BEGIN RSA PRIVATE KEY) 탐지', () => {
    const text = '-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----';
    const results = scanCredentials(text);
    expect(results.some((r) => r.name === 'Private Key (PEM)')).toBe(true);
  });

  test('[6] Private Key PEM — EC 변형 탐지', () => {
    const text = '-----BEGIN EC PRIVATE KEY-----\nabc\n-----END EC PRIVATE KEY-----';
    const results = scanCredentials(text);
    expect(results.some((r) => r.name === 'Private Key (PEM)')).toBe(true);
  });

  test('[6] Private Key PEM — OPENSSH 변형 탐지', () => {
    const text = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3Bl\n-----END OPENSSH PRIVATE KEY-----';
    const results = scanCredentials(text);
    expect(results.some((r) => r.name === 'Private Key (PEM)')).toBe(true);
  });

  test('[6] Private Key PEM — prefix 없는 변형(PRIVATE KEY) 탐지', () => {
    const text = '-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----';
    const results = scanCredentials(text);
    expect(results.some((r) => r.name === 'Private Key (PEM)')).toBe(true);
  });

  // ── 7. Database URL ───────────────────────────────────────────────────────

  test('[7] Database URL (postgresql://) 탐지', () => {
    const text = 'DATABASE_URL=postgresql://dbuser:supersecret@hostname/mydb';
    const results = scanCredentials(text);
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe('Database URL');
  });

  test('[7] Database URL (mysql://) 탐지', () => {
    const text = 'DB=mysql://root:admin123@localhost/app';
    const results = scanCredentials(text);
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe('Database URL');
  });

  // ── 8. Password in Context ────────────────────────────────────────────────

  test('[8] Password in Context (password:) 탐지', () => {
    // password\s*[:=]\s*["']?[^\s"']{8,}
    const text = 'password: mysecretpw';
    const results = scanCredentials(text);
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe('Password in Context');
  });

  test('[8] Password in Context (password=) 탐지', () => {
    const text = 'password=secretpass123';
    const results = scanCredentials(text);
    expect(results.some((r) => r.name === 'Password in Context')).toBe(true);
  });

  // ── 9. Bearer Token ───────────────────────────────────────────────────────

  test('[9] Bearer Token 탐지', () => {
    // Bearer\s+[A-Za-z0-9\-_]{20,}  — token 21자
    const text = 'Authorization: Bearer abcdefghijklmnopqrstu';
    const results = scanCredentials(text);
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe('Bearer Token');
  });

  // ── 10. Google AI Key ─────────────────────────────────────────────────────

  test('[10] Google AI Key (AIza...) 탐지', () => {
    // AIza[0-9A-Za-z\-_]{35}  — suffix 35자
    const text = 'GOOGLE_API_KEY=AIza' + 'a'.repeat(35);
    const results = scanCredentials(text);
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe('Google AI Key');
  });

  // ── 11. Stripe Secret Key ─────────────────────────────────────────────────

  test('[11] Stripe Secret Key (sk_live_) 탐지', () => {
    // sk_(?:live|test)_[A-Za-z0-9]{24,}
    const text = 'STRIPE_KEY=sk_live_abcdefghijklmnopqrstuvwx';
    const results = scanCredentials(text);
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe('Stripe Secret Key');
  });

  test('[11] Stripe sk_test_ (언더스코어) — TEST_EXCLUSIONS "sk-test-"(대시)와 달라 탐지됨', () => {
    // 중요: sk_test_ (언더스코어) ≠ sk-test- (대시) → isTestValue 미필터 → 탐지
    const text = 'STRIPE_KEY=sk_test_abcdefghijklmnopqrstuvwx';
    const results = scanCredentials(text);
    expect(results.some((r) => r.name === 'Stripe Secret Key')).toBe(true);
  });

  // ── 복합 케이스 ───────────────────────────────────────────────────────────

  test('복수 패턴 동시 존재 → 각각 독립 탐지', () => {
    const text = [
      'token: ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ',
      'AWS_ACCESS_KEY_ID=AKIAIAAAABBBBBBBBBBB',
    ].join('\n');
    const results = scanCredentials(text);
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results.some((r) => r.name === 'GitHub Token')).toBe(true);
    expect(results.some((r) => r.name === 'AWS Access Key')).toBe(true);
  });

  test('동일 패턴 두 번 → count: 2', () => {
    // AKIA + 16자 uppercase alphanumeric 두 개
    const text = 'key1: AKIAIAAAABBBBBBBBBBB, key2: AKIABBBBAAAAAAAAAAAA';
    const results = scanCredentials(text);
    const awsResult = results.find((r) => r.name === 'AWS Access Key');
    expect(awsResult).toBeDefined();
    expect(awsResult!.count).toBe(2);
  });

});

// =============================================================================
// TEST_EXCLUSIONS 필터링
// =============================================================================

describe('scanCredentials — TEST_EXCLUSIONS 필터링', () => {

  test('"example" 포함 매칭 → 개별 필터 → []', () => {
    // sk-proj-example... suffix 28자 ≥ 20 → 패턴 매칭, isTestValue에서 필터
    const text = 'config: sk-proj-exampleabcdefghijklmnopqrstu';
    expect(scanCredentials(text)).toEqual([]);
  });

  test('"EXAMPLE" (대문자) 포함 매칭 → 개별 필터 → []', () => {
    // TEST_EXCLUSIONS에 'example'(소문자)와 'EXAMPLE'(대문자) 모두 포함
    const text = 'config: sk-proj-EXAMPLEABCDEFGHIJKLM1234';
    expect(scanCredentials(text)).toEqual([]);
  });

  test('"placeholder" 포함 매칭 → 개별 필터 → []', () => {
    // Bearer pattern: Bearer + 'placeholder-token-here-now' = 26자 ≥ 20
    const text = 'auth: Bearer placeholder-token-here-now-extra';
    expect(scanCredentials(text)).toEqual([]);
  });

  test('"INSERT_" 포함 매칭 → 개별 필터 → []', () => {
    // Bearer pattern: Bearer + 'INSERT_YOUR_TOKEN_HERE_NOW' = 26자 ≥ 20
    const text = 'auth: Bearer INSERT_YOUR_TOKEN_HERE_NOW';
    expect(scanCredentials(text)).toEqual([]);
  });

  test('"REPLACE_" 포함 매칭 → 개별 필터 → []', () => {
    const text = 'auth: Bearer REPLACE_YOUR_TOKEN_HERE_NOW';
    expect(scanCredentials(text)).toEqual([]);
  });

  test('"<YOUR_" → isLikelyTestContent 선행 필터 → []', () => {
    // isLikelyTestContent: lower.includes('<your_') → true → 전체 스킵
    const text = 'Set API_KEY=<YOUR_OPENAI_KEY> in production';
    expect(scanCredentials(text)).toEqual([]);
  });

  test('필터 해당 없는 실제 키 → 탐지됨 (필터 과적용 없음)', () => {
    // 제외 접두사/부분문자열 없는 정상 키 → 탐지
    const text = 'key: AKIAIAAAABBBBBBBBBBB';
    const results = scanCredentials(text);
    expect(results.some((r) => r.name === 'AWS Access Key')).toBe(true);
  });

});

// =============================================================================
// 코드블록 제거 (§8-3)
// =============================================================================

describe('scanCredentials — 코드블록 내 크레덴셜 제외', () => {

  test('펜스드 코드블록(```) 내 크레덴셜 → 탐지 안 됨', () => {
    const text = '예시:\n```\nsk-proj-abcdefghijklmnopqrstu\n```\n실제 키 아님';
    expect(scanCredentials(text)).toEqual([]);
  });

  test('언어 지정 펜스드 코드블록(```python) 내 크레덴셜 → 탐지 안 됨', () => {
    const lines = [
      '```python',
      'API_KEY = "sk-proj-abcdefghijklmnopqrstu"',
      '```',
    ].join('\n');
    expect(scanCredentials(lines)).toEqual([]);
  });

  test('인라인 코드(`) 내 크레덴셜 → 탐지 안 됨', () => {
    const text = '이 `sk-proj-abcdefghijklmnopqrstu` 키는 예시입니다.';
    expect(scanCredentials(text)).toEqual([]);
  });

  test('틸드(~~~) 코드블록 내 크레덴셜 → 탐지 안 됨', () => {
    const text = '~~~\nghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ\n~~~';
    expect(scanCredentials(text)).toEqual([]);
  });

  test('코드블록 내/외 혼재 — 코드블록 밖 크레덴셜만 탐지, count 정확', () => {
    // 코드블록 안: AKIAIAAAABBBBBBBBBBB (제거됨)
    // 코드블록 밖: AKIAIAAAABBBBBBBBBBB (탐지됨)
    const lines = [
      '```python',
      'FAKE_KEY = "AKIAIAAAABBBBBBBBBBB"',
      '```',
      'Real: AKIAIAAAABBBBBBBBBBB',
    ].join('\n');
    const results = scanCredentials(lines);
    const awsResult = results.find((r) => r.name === 'AWS Access Key');
    expect(awsResult).toBeDefined();
    expect(awsResult!.count).toBe(1);  // 코드블록 밖 1개만
  });

});

// =============================================================================
// 커스텀 패턴
// =============================================================================

describe('scanCredentials — 커스텀 패턴', () => {

  test('유효한 커스텀 패턴 → 탐지', () => {
    const text = 'My secret: MYCOMPANY-SECRET-abc123xyz';
    const results = scanCredentials(text, ['MYCOMPANY-SECRET-[a-z0-9]+']);
    expect(results.some((r) => r.name === 'Custom Pattern')).toBe(true);
  });

  test('유효하지 않은 정규식 → 조용히 무시, 크래시 없음', () => {
    const text = 'test content';
    expect(() => scanCredentials(text, ['[invalid(regex'])).not.toThrow();
    expect(scanCredentials(text, ['[invalid(regex'])).toEqual([]);
  });

  test('커스텀 패턴도 TEST_EXCLUSIONS 적용 → 필터됨', () => {
    // MYCOMPANY-SECRET-example123 → isTestValue 'example' → 필터
    const text = 'MYCOMPANY-SECRET-example123';
    const results = scanCredentials(text, ['MYCOMPANY-SECRET-[a-z0-9]+']);
    expect(results).toEqual([]);
  });

  test('커스텀 패턴 + 내장 패턴 동시 탐지', () => {
    const text = [
      'AWS_ACCESS_KEY_ID=AKIAIAAAABBBBBBBBBBB',
      'MYCOMPANY-SECRET-abc123xyz',
    ].join('\n');
    const results = scanCredentials(text, ['MYCOMPANY-SECRET-[a-z0-9]+']);
    expect(results.some((r) => r.name === 'AWS Access Key')).toBe(true);
    expect(results.some((r) => r.name === 'Custom Pattern')).toBe(true);
  });

  test('복수 커스텀 패턴 (유효/무효 혼합)', () => {
    const text = 'MYTOKEN-abc123';
    const patterns = ['[bad(regex', 'MYTOKEN-[a-z0-9]+'];
    const results = scanCredentials(text, patterns);
    // 무효 패턴 무시, 유효 패턴은 탐지
    expect(results.some((r) => r.name === 'Custom Pattern')).toBe(true);
  });

});
