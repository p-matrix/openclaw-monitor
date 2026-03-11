// =============================================================================
// @pmatrix/openclaw-monitor — credential-scanner.ts
// 크레덴셜 탐지 스캐너 (§3-2, §8)
//
// 탐지 패턴 11종 + 코드블록 제외(MVP 필수 §8-3) + TEST_EXCLUSIONS
// 순수 함수 — 외부 상태·I/O 없음
// =============================================================================

// ─── 탐지 패턴 (§8-1, §3-2) ─────────────────────────────────────────────────

interface CredentialPattern {
  name: string;
  /** 단일 패턴 — g 플래그 없이 정의 (scan 시 동적 적용) */
  pattern: RegExp;
}

/**
 * 크레덴셜 패턴 11종 (§8-1)
 *
 * [A-3] 결정사항:
 *   - sk- 아닌 sk-proj- 사용 (Stripe sk_ 충돌 방지)
 *   - DB URL: postgresql + mysql 통합 단일 패턴
 *   - Google AI Key, Stripe Secret Key 신규 추가
 */
const CREDENTIAL_PATTERNS: readonly CredentialPattern[] = [
  {
    name: 'OpenAI Project Key',
    pattern: /sk-proj-[A-Za-z0-9\-_]{20,}/,
  },
  {
    name: 'Anthropic Key',
    pattern: /sk-ant-[A-Za-z0-9\-]{40,}/,
  },
  {
    name: 'AWS Access Key',
    pattern: /AKIA[0-9A-Z]{16}/,
  },
  {
    name: 'GitHub Token',
    pattern: /ghp_[A-Za-z0-9]{36}/,
  },
  {
    name: 'GitHub Fine-grained Token',
    pattern: /github_pat_[A-Za-z0-9_]{82}/,
  },
  {
    name: 'Private Key (PEM)',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  },
  {
    name: 'Database URL',
    pattern: /(?:postgresql|mysql):\/\/[^:\s]+:[^@\s]+@/,
  },
  {
    name: 'Password in Context',
    pattern: /password\s*[:=]\s*["']?[^\s"']{8,}/i,
  },
  {
    name: 'Bearer Token',
    pattern: /Bearer\s+[A-Za-z0-9\-_]{20,}/,
  },
  {
    name: 'Google AI Key',
    pattern: /AIza[0-9A-Za-z\-_]{35}/,
  },
  {
    name: 'Stripe Secret Key',
    pattern: /sk_(?:live|test)_[A-Za-z0-9]{24,}/,
  },
] as const;

/**
 * 거짓 양성 제외 접두사/부분문자열 (§8-3)
 * 테스트·예시 값에 해당하면 매칭 무시
 */
const TEST_EXCLUSIONS = [
  'sk-test-',
  'sk-fake-',
  'example',
  'your-api-key-here',
  'EXAMPLE',
  'placeholder',
  '<YOUR_',
  'INSERT_',
  'REPLACE_',
] as const;

// ─── 공개 API ────────────────────────────────────────────────────────────────

export interface ScanResult {
  /** 감지된 패턴명 (예: "OpenAI Project Key") */
  name: string;
  /** 해당 패턴 매칭 횟수 */
  count: number;
}

/**
 * 텍스트에서 크레덴셜 패턴 스캔
 *
 * 처리 순서:
 *   1. 코드블록(``` ```) 제거 — MVP 필수 §8-3
 *   2. 커스텀 패턴 추가 (config.credentialProtection.customPatterns)
 *   3. 각 패턴 매칭 후 TEST_EXCLUSIONS 필터링
 *
 * @param text 스캔할 텍스트
 * @param customPatterns 추가 정규식 패턴 문자열 목록
 * @returns 감지된 크레덴셜 목록 (없으면 빈 배열)
 */
export function scanCredentials(
  text: string,
  customPatterns: readonly string[] = []
): ScanResult[] {
  if (!text) return [];

  // FIX #11: isLikelyTestContent 전체 스킵 로직 제거.
  // 텍스트 어디에든 "# example" 한 줄만 포함하면 실제 크레덴셜까지 스캔을 통째로 우회
  // (Payload Injection)하는 보안 취약점 차단.
  // 거짓 양성 방지는 개별 매칭값 단위의 isTestValue 필터로 처리 (하단 Step 3 유지).

  // Step 1: 코드블록 제거 (스캔 전 필수 §8-3)
  const stripped = removeCodeBlocks(text);

  // Step 2: 스캔할 패턴 목록 구성 (내장 + 커스텀)
  const patterns: CredentialPattern[] = [...CREDENTIAL_PATTERNS];
  for (const rawPattern of customPatterns) {
    try {
      patterns.push({ name: 'Custom Pattern', pattern: new RegExp(rawPattern) });
    } catch (err) {
      // FIX #47: 유효하지 않은 커스텀 패턴 — 무시하되 경고 출력 (디버그 가시성 확보)
      console.warn(
        `[P-MATRIX] credential-scanner: invalid custom pattern skipped — ${(err as Error).message}`
      );
    }
  }

  // Step 3: 패턴별 매칭 + TEST_EXCLUSIONS 필터
  const results: ScanResult[] = [];

  for (const { name, pattern } of patterns) {
    try {
      const globalPattern = new RegExp(pattern.source, 'g');
      const matches = stripped.match(globalPattern);
      if (!matches) continue;

      const realMatches = matches.filter((m) => !isTestValue(m));
      if (realMatches.length > 0) {
        results.push({ name, count: realMatches.length });
      }
    } catch (err) {
      // FIX #55: 패턴 실행 오류 — 해당 패턴 건너뛰고 나머지 스캔 계속 (부분 실패 격리)
      console.warn(
        `[P-MATRIX] credential-scanner: pattern execution failed for "${name}" — ${(err as Error).message}`
      );
    }
  }

  return results;
}

/**
 * 빠른 사전 체크 — 스캔 전 명백한 거짓 양성 전체 텍스트 판단
 * "your-api-key-here" 등이 포함된 문서 전체 스킵 (선택적 최적화)
 */
export function isLikelyTestContent(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes('your-api-key-here') ||
    lower.includes('insert_key') ||
    lower.includes('replace_with') ||
    lower.includes('<your_') ||
    // 마크다운 예시 섹션
    lower.includes('## example') ||
    lower.includes('# example')
  );
}

// ─── 내부 헬퍼 ────────────────────────────────────────────────────────────────

/**
 * 펜스드 코드블록 제거 (§8-3 MVP 필수)
 * ``` ... ``` 내부 패턴은 스캔 제외
 *
 * 예: ```python\nsk-proj-abc123\n``` → [CODE_BLOCK_REMOVED]
 */
function removeCodeBlocks(text: string): string {
  // 인라인 코드 (`...`) 제거
  let result = text.replace(/`[^`\n]+`/g, '[INLINE_CODE]');
  // 펜스드 코드블록 (``` or ~~~) 제거
  result = result.replace(/```[\s\S]*?```/g, '[CODE_BLOCK]');
  result = result.replace(/~~~[\s\S]*?~~~/g, '[CODE_BLOCK]');
  return result;
}

/**
 * 개별 매칭값이 테스트/예시 값인지 확인
 */
function isTestValue(match: string): boolean {
  for (const exclusion of TEST_EXCLUSIONS) {
    if (match.includes(exclusion)) return true;
  }
  return false;
}
