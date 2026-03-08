// =============================================================================
// @pmatrix/openclaw-monitor — ui/formatter.ts
// 채팅창 출력 포맷터 — 순수 함수, 외부 I/O 없음
//
// 형식 기준: 기획서 §9 (UX 설계 — 사용자 표시 형식)
// =============================================================================

import { SafetyMode, TrustGrade, SessionState } from '../types';

// ─── 상수 ─────────────────────────────────────────────────────────────────────

const SEP = '─────────────────────────────────────────';

const MODE_ICON: Readonly<Record<SafetyMode, string>> = {
  'A+1': '✅',
  'A+0': '💛',
  'A-1': '🟠',
  'A-2': '🔴',
  'A-0': '🛑',
};

const MODE_LABEL: Readonly<Record<SafetyMode, string>> = {
  'A+1': 'Normal',
  'A+0': 'Caution',
  'A-1': 'Alert',
  'A-2': 'Critical',
  'A-0': 'Halt',
};

const GRADE_ICON: Readonly<Record<TrustGrade, string>> = {
  A: '✅',
  B: '💛',
  C: '🟠',
  D: '🔴',
  E: '🛑',
};

// ─── Safety Gate 메시지 (§9-2) ────────────────────────────────────────────────

/**
 * Safety Gate 차단 메시지
 */
export function formatGateBlock(
  toolName: string,
  paramsSummary: string,
  rt: number,
  mode: SafetyMode,
  reason: string
): string {
  return joinLines([
    `🚫 P-MATRIX Safety Gate — 차단됨`,
    SEP,
    `도구: ${toolName}`,
    paramsSummary || null,
    `현재 위험도: R(t) ${rt.toFixed(2)} (${MODE_LABEL[mode]} ${MODE_ICON[mode]})`,
    `차단 사유: ${reason}`,
    SEP,
  ]);
}

/**
 * Safety Gate 확인 요청 메시지 (CONFIRM 액션)
 * fail-closed: confirmTimeoutSec 후 자동 차단
 */
export function formatGateConfirm(
  toolName: string,
  paramsSummary: string,
  rt: number,
  mode: SafetyMode,
  reason: string,
  confirmTimeoutSec: number
): string {
  return joinLines([
    `⚠️ P-MATRIX Safety Gate — 확인 필요`,
    SEP,
    `도구: ${toolName}`,
    paramsSummary || null,
    `현재 위험도: R(t) ${rt.toFixed(2)} (${MODE_LABEL[mode]} ${MODE_ICON[mode]})`,
    `사유: ${reason}`,
    ``,
    `👉 허용하려면: /pmatrix allow once`,
    `타임아웃: ${confirmTimeoutSec}초 후 자동 차단 (fail-closed)`,
    SEP,
  ]);
}

// ─── Kill Switch 메시지 (§9, §2-5) ───────────────────────────────────────────

/**
 * R(t) ≥ 0.75 자동 Halt 발동 메시지
 */
export function formatHaltAuto(rt: number, reasons: string[]): string {
  const lines: Array<string | null> = [
    `🛑 P-MATRIX — 에이전트 Halt`,
    SEP,
    `위험도 R(t) = ${rt.toFixed(2)} ≥ 0.75`,
    `에이전트의 모든 외부 도구 실행이 차단됩니다.`,
  ];

  if (reasons.length > 0) {
    lines.push(``, `원인 분석:`);
    reasons.forEach((r) => lines.push(`  • ${r}`));
  }

  lines.push(
    ``,
    `👉 에이전트 재시작: /pmatrix resume (관리자 확인 후)`,
    `👉 상세 리포트: /pmatrix report`,
    SEP
  );

  return joinLines(lines);
}

/**
 * 수동 Kill Switch (/pmatrix halt) 메시지
 */
export function formatHaltManual(): string {
  return joinLines([
    `🛑 Kill Switch 발동 — 에이전트 즉시 정지`,
    `현재 실행 중인 도구 호출이 있다면 차단됩니다.`,
    `/pmatrix resume 으로 재개할 수 있습니다.`,
  ]);
}

/**
 * Halt 해제 (/pmatrix resume) 메시지
 */
export function formatResumeMessage(): string {
  return `✅ P-MATRIX — 에이전트 Halt가 해제되었습니다. 정상 동작을 재개합니다.`;
}

// ─── 크레덴셜 차단 메시지 (§9-3) ─────────────────────────────────────────────

/**
 * 크레덴셜 감지 차단 알림
 * @param patterns 감지된 패턴명 목록
 * @param metaControlDelta 음수값 (예: -0.30)
 */
export function formatCredentialAlert(
  patterns: string[],
  metaControlDelta: number
): string {
  const deltaStr = Math.round(Math.abs(metaControlDelta) * 100);
  return joinLines([
    `⚠️ P-MATRIX 크레덴셜 보호 — 메시지 차단`,
    SEP,
    `감지된 민감 정보: ${patterns.join(', ')} (${patterns.length}건)`,
    `메시지 전송이 취소되었습니다.`,
    ``,
    `에이전트에게 직접 값을 공유하지 않도록 안내하세요.`,
    `P-Score 변동: -${deltaStr} (크레덴셜 유출 시도)`,
    SEP,
  ]);
}

// ─── /pmatrix status 메시지 (§9, §2-4) ───────────────────────────────────────

/**
 * /pmatrix status 전체 상태 표시
 *
 * Tier-2 추가 표시:
 *   - 하위 에이전트 depth / 부모 에이전트 ID (agentDepth > 0 시만)
 *   - 세션 누적 토큰 (totalInputTokens / totalOutputTokens, 0 이상 시만)
 */
export function formatStatusMessage(state: SessionState): string {
  const grade = state.grade ?? '─';
  const pScore = state.pScore != null ? String(state.pScore) : '─';
  const rt = state.currentRt;
  const mode = state.currentMode;
  const axes = state.axes;

  const gradeIcon =
    state.grade ? (GRADE_ICON[state.grade] ?? '') : '';

  const cacheNote = state.rtCacheExpiry.getTime() < Date.now()
    ? ' (캐시 만료 — 서버 재연결 대기)'
    : '';

  // ── [Tier-2] 하위 에이전트 정보 (depth > 0 시에만 표시) ───────────────────
  const subAgentLine = state.agentDepth > 0
    ? `하위 에이전트: depth=${state.agentDepth}, 부모=${state.parentAgentId ?? '─'}`
    : null;

  // ── [Tier-2] 세션 누적 토큰 (cost-tracker, 0 초과 시에만 표시) ────────────
  const totalTokens = state.totalInputTokens + state.totalOutputTokens;
  const costLine = totalTokens > 0
    ? `세션 토큰: 입력 ${state.totalInputTokens.toLocaleString()} / 출력 ${state.totalOutputTokens.toLocaleString()} (합계 ${totalTokens.toLocaleString()})`
    : null;

  return joinLines([
    `🛡️ P-MATRIX 현재 상태`,
    SEP,
    `에이전트: ${state.agentId}`,
    subAgentLine,
    `Grade: ${gradeIcon} ${grade}  |  P-Score: ${pScore}`,
    `위험도: R(t) ${rt.toFixed(2)}  ${bar(1 - rt)}  ${MODE_LABEL[mode]} ${MODE_ICON[mode]}${cacheNote}`,
    ``,
    `4축 분해:`,
    `  Baseline:     ${axes.baseline.toFixed(2)} ${bar(axes.baseline)} ${axisLabel(axes.baseline, false)}`,
    `  Norm:         ${axes.norm.toFixed(2)} ${bar(axes.norm)} ${axisLabel(axes.norm, false)}`,
    `  Stability:    ${axes.stability.toFixed(2)} ${bar(1 - axes.stability)} ${axisLabel(1 - axes.stability, false)}`,
    `  Meta Control: ${axes.meta_control.toFixed(2)} ${bar(axes.meta_control)} ${axisLabel(axes.meta_control, true)}`,
    ``,
    `세션: ${state.turnNumber}턴 | 위험 이벤트: ${state.dangerEvents}건`,
    `최근 크레덴셜 차단: ${state.credentialBlocks}건 | Safety Gate 차단: ${state.safetyGateBlocks}건`,
    costLine,
    SEP,
    `/pmatrix report  |  /pmatrix help`,
  ]);
}

// ─── Gateway 시작 메시지 (§9-5) ───────────────────────────────────────────────

export function formatConnected(
  agentId: string,
  grade: TrustGrade,
  rt: number
): string {
  return (
    `✅ P-MATRIX Monitor connected` +
    ` (Grade ${grade} ${GRADE_ICON[grade]} / R(t): ${rt.toFixed(2)})`
  );
}

export function formatConnecting(agentId: string): string {
  return `🛡️ P-MATRIX Monitor active (Grade: ─ / connecting...) — agent: ${agentId}`;
}

// ─── meta_control 특별 규칙 차단 메시지 ──────────────────────────────────────

export function formatMetaControlBlock(
  toolName: string,
  reason: string,
  metaControlDelta: number
): string {
  const deltaStr = Math.round(Math.abs(metaControlDelta) * 100);
  return joinLines([
    `🚫 P-MATRIX META_CONTROL 차단 — 즉시 실행 중단`,
    SEP,
    `도구: ${toolName}`,
    `감지: ${reason}`,
    `Meta Control 감점: -${deltaStr}`,
    SEP,
  ]);
}

// ─── 내부 헬퍼 ────────────────────────────────────────────────────────────────

/** 10칸 바 차트 (높을수록 더 많이 채워짐) */
function bar(v: number): string {
  const clamped = Math.max(0, Math.min(1, v));
  const filled = Math.round(clamped * 10);
  return '▓'.repeat(filled) + '░'.repeat(10 - filled);
}

/** 축 값 평가 레이블 */
function axisLabel(v: number, isReflex: boolean): string {
  if (v >= 0.8) return isReflex ? '우수' : '안전';
  if (v >= 0.5) return '주의';
  return '위험';
}

/**
 * 줄 배열을 \n으로 합치되 null/undefined는 제거
 */
function joinLines(lines: Array<string | null | undefined>): string {
  return lines.filter((l): l is string => l != null).join('\n');
}
