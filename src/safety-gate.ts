// =============================================================================
// @pmatrix/openclaw-monitor — safety-gate.ts
// Safety Gate 판정 순수 로직:
//   - Tool Risk Tier 분류 (§3-1)
//   - Safety Gate 판정 매트릭스 (§3-1)
//   - meta_control 특별 규칙 R(t) 무관 즉시 차단 (§3-1)
//   - R(t) → SafetyMode 변환 (Server constants.py 경계값 기준 §14-4)
//
// 이 모듈은 순수 함수만 포함 — 외부 상태·I/O 없음
// =============================================================================

import { ToolRiskTier, GateAction, SafetyMode } from './types';

// ─── R(t) → Mode 경계값 (Server constants.py 기준, §14-4) ─────────────────────

/**
 * Server 기준 5-Mode 경계값
 * Kernel(risk_phase.rs)과 Server(constants.py)의 경계값이 다름.
 * Plugin은 반드시 Server 기준 사용.
 */
export const MODE_BOUNDARIES: Readonly<Record<SafetyMode, readonly [number, number]>> = {
  'A+1': [0.00, 0.15],  // Normal
  'A+0': [0.15, 0.30],  // Caution
  'A-1': [0.30, 0.50],  // Alert
  'A-2': [0.50, 0.75],  // Critical
  'A-0': [0.75, 1.00],  // Halt
} as const;

/**
 * R(t) → SafetyMode 변환
 * @param rt 위험도 [0, 1]
 */
export function rtToMode(rt: number): SafetyMode {
  if (rt < 0.15) return 'A+1';
  if (rt < 0.30) return 'A+0';
  if (rt < 0.50) return 'A-1';
  if (rt < 0.75) return 'A-2';
  return 'A-0';
}

// ─── Tool Risk Tier 분류 (§3-1) ───────────────────────────────────────────────

/** HIGH 위험 도구명 세트 (소문자 정확 일치) */
const HIGH_RISK_TOOLS = new Set([
  'exec',
  'bash',
  'shell',
  'run',
  'apply_patch',     // 쓰기 포함 판단 — 기본 HIGH (보수적 기본값)
  'browser',         // 양식 제출, 클릭 포함
  'computer',        // 커서 제어 + 클릭
  'terminal',
  'code_interpreter',
]);

/** MEDIUM 위험 도구명 세트 (소문자 정확 일치) */
const MEDIUM_RISK_TOOLS = new Set([
  'web_fetch',
  'http_request',
  'fetch',
  'request',
  'curl',
  'wget',
]);

/** LOW 위험 도구명 접두사 (소문자 startsWith) */
const LOW_TOOL_PREFIXES = [
  'pmatrix_',   // P-MATRIX 내부 도구
  'file_read',
  'list_files',
  'search',
  'read',
  'glob',
  'grep',
  'ls',
  'find',
  'cat',
  'head',
  'tail',
];

/**
 * 도구 위험 등급 분류
 *
 * 우선순위: customToolRisk > LOW_PREFIXES > HIGH_SET > MEDIUM_SET > 기본값(MEDIUM)
 */
export function classifyToolRisk(
  toolName: string,
  customToolRisk?: Record<string, ToolRiskTier>
): ToolRiskTier {
  // 1. 커스텀 재정의 최우선
  if (customToolRisk) {
    const custom = customToolRisk[toolName];
    if (custom) return custom;
  }

  const lower = toolName.toLowerCase();

  // 2. LOW prefix 체크
  if (LOW_TOOL_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
    return 'LOW';
  }

  // 3. HIGH 정확 일치
  if (HIGH_RISK_TOOLS.has(lower)) return 'HIGH';

  // 4. MEDIUM 정확 일치
  if (MEDIUM_RISK_TOOLS.has(lower)) return 'MEDIUM';

  // 5. 알 수 없는 도구 → MEDIUM (보수적 기본값)
  return 'MEDIUM';
}

// ─── Safety Gate 판정 ─────────────────────────────────────────────────────────

export interface GateResult {
  action: GateAction;
  /** 차단/확인 사유 (ALLOW이면 '') */
  reason: string;
}

/**
 * Safety Gate 판정 매트릭스 (§3-1)
 *
 * | R(t)       | Mode     | HIGH    | MEDIUM  | LOW   |
 * |------------|----------|---------|---------|-------|
 * | < 0.15     | Normal   | ALLOW   | ALLOW   | ALLOW |
 * | 0.15~0.30  | Caution  | CONFIRM | ALLOW   | ALLOW | ← [A-1] HIGH=CONFIRM (자동허용 아님)
 * | 0.30~0.50  | Alert    | CONFIRM | ALLOW   | ALLOW |
 * | 0.50~0.75  | Critical | BLOCK   | CONFIRM | ALLOW |
 * | ≥ 0.75     | Halt     | BLOCK   | BLOCK   | BLOCK |
 *
 * 주의: Halt(≥0.75)는 isHalted 플래그로 별도 처리하지만 여기서도 방어적으로 처리.
 */
export function evaluateSafetyGate(
  rt: number,
  toolRisk: ToolRiskTier
): GateResult {
  const mode = rtToMode(rt);
  const rtStr = rt.toFixed(2);

  // Halt (≥0.75) → 모두 차단 (§14-2: 반드시 block:true, throw 금지)
  if (mode === 'A-0') {
    return {
      action: 'BLOCK',
      reason: `Halt 상태 (R(t) ${rtStr} ≥ 0.75) — 모든 도구 차단`,
    };
  }

  // Critical (0.50~0.75)
  if (mode === 'A-2') {
    if (toolRisk === 'HIGH') {
      return {
        action: 'BLOCK',
        reason: `Critical 구간 (R(t) ${rtStr})에서 고위험 도구 실행 시도`,
      };
    }
    if (toolRisk === 'MEDIUM') {
      return {
        action: 'CONFIRM',
        reason: `Critical 구간 (R(t) ${rtStr})에서 중위험 도구 실행`,
      };
    }
    return { action: 'ALLOW', reason: '' };
  }

  // Alert (0.30~0.50) [A-1]
  if (mode === 'A-1') {
    if (toolRisk === 'HIGH') {
      return {
        action: 'CONFIRM',
        reason: `Alert 구간 (R(t) ${rtStr})에서 고위험 도구 실행`,
      };
    }
    return { action: 'ALLOW', reason: '' };
  }

  // Caution (0.15~0.30) [A-1 근거: HIGH=CONFIRM, 자동허용 아님]
  if (mode === 'A+0') {
    if (toolRisk === 'HIGH') {
      return {
        action: 'CONFIRM',
        reason: `Caution 구간 (R(t) ${rtStr})에서 고위험 도구 실행`,
      };
    }
    return { action: 'ALLOW', reason: '' };
  }

  // Normal (< 0.15) → 모두 허용
  return { action: 'ALLOW', reason: '' };
}

// ─── meta_control 특별 규칙 (R(t) 무관 즉시 차단, §3-1) ─────────────────────

export interface MetaControlBlockResult {
  reason: string;
  /** meta_control 감점값 (음수) */
  metaControlDelta: number;
}

interface MetaControlRule {
  /** 도구명 + 파라미터 직렬화 문자열에 적용 */
  pattern: RegExp;
  reason: string;
  metaControlDelta: number;
}

const META_CONTROL_RULES: readonly MetaControlRule[] = [
  {
    // sudo 또는 chmod 777 → meta_control -0.25
    pattern: /\bsudo\b|chmod\s+777/i,
    reason: '권한 상승 시도 감지 (sudo / chmod 777)',
    metaControlDelta: -0.25,
  },
  {
    // rm -rf 위험 경로 → meta_control -0.30
    pattern: /rm\s+-rf\s+(\/(?!tmp|var\/tmp)[^\s]*|~)/i,
    reason: '시스템 파괴적 삭제 명령 감지 (rm -rf)',
    metaControlDelta: -0.30,
  },
  {
    // curl/wget | sh → meta_control -0.20
    pattern: /(?:curl|wget)\s+[^\|]+\|\s*(?:ba)?sh\b/i,
    reason: '원격 코드 실행 패턴 감지 (curl/wget | sh)',
    metaControlDelta: -0.20,
  },
] as const;

/**
 * meta_control 특별 규칙 검사 — R(t) 무관 즉시 차단
 *
 * @param toolName 도구명
 * @param params 파라미터 (객체/문자열/null)
 * @returns 차단 정보, 해당 없으면 null
 */
export function checkMetaControlRules(
  toolName: string,
  params: unknown
): MetaControlBlockResult | null {
  const paramsStr = serializeParams(params);
  const combined = `${toolName} ${paramsStr}`;

  for (const rule of META_CONTROL_RULES) {
    if (rule.pattern.test(combined)) {
      return {
        reason: rule.reason,
        metaControlDelta: rule.metaControlDelta,
      };
    }
  }

  return null;
}

// ─── 유틸 ─────────────────────────────────────────────────────────────────────

/**
 * Hook params를 평탄 문자열로 직렬화 (meta_control 패턴 검색용)
 */
export function serializeParams(params: unknown): string {
  if (params == null) return '';
  if (typeof params === 'string') return params;
  try {
    return JSON.stringify(params);
  } catch {
    return String(params);
  }
}

/**
 * 표시용 params 요약 (최대 maxLen자, 초과 시 '...' 처리)
 */
export function summarizeParams(params: unknown, maxLen = 80): string {
  const str = serializeParams(params);
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}
