// =============================================================================
// formatter.test.ts — UI 출력 포맷터 자가 검증
// =============================================================================
//
// 검증 범위:
//   1. formatGateBlock — Safety Gate 차단 메시지
//   2. formatGateConfirm — Safety Gate 확인 요청 메시지
//   3. formatHaltAuto — 자동 Halt (R(t) ≥ 0.75) 메시지
//   4. formatHaltManual — 수동 Kill Switch 메시지
//   5. formatResumeMessage — Halt 해제 메시지
//   6. formatCredentialAlert — 크레덴셜 차단 알림
//   7. formatStatusMessage — /pmatrix status 전체 상태
//   8. formatConnected / formatConnecting — Gateway 연결 메시지
//   9. formatMetaControlBlock — META_CONTROL 즉시 차단 메시지
// =============================================================================

import {
  formatGateBlock,
  formatGateConfirm,
  formatHaltAuto,
  formatHaltManual,
  formatResumeMessage,
  formatCredentialAlert,
  formatStatusMessage,
  formatConnected,
  formatConnecting,
  formatMetaControlBlock,
} from '../ui/formatter';
import { createSession } from '../session-state';
import { sessions } from '../session-state';

beforeEach(() => {
  sessions.clear();
});

// =============================================================================
// 1. formatGateBlock
// =============================================================================

describe('formatGateBlock — Safety Gate 차단 메시지', () => {

  test('필수 요소: 차단 키워드, 도구명, R(t), 모드, 사유', () => {
    const msg = formatGateBlock('bash', 'rm -rf /', 0.60, 'A-2', 'Critical 구간 고위험 도구');
    expect(msg).toContain('차단됨');
    expect(msg).toContain('bash');
    expect(msg).toContain('0.60');
    expect(msg).toContain('Critical');
    expect(msg).toContain('Critical 구간 고위험 도구');
  });

  test('paramsSummary 비어 있으면 해당 줄 제외 (null 필터)', () => {
    const withParams = formatGateBlock('bash', 'some params', 0.60, 'A-2', 'reason');
    const withoutParams = formatGateBlock('bash', '', 0.60, 'A-2', 'reason');
    // 빈 문자열은 falsy → null로 처리 → joinLines에서 제거
    expect(withoutParams).not.toContain('some params');
    // params 줄이 빠졌으므로 줄 수가 더 적음
    expect(withoutParams.split('\n').length).toBeLessThan(withParams.split('\n').length);
  });

  test('R(t) 소수점 2자리 포맷', () => {
    const msg = formatGateBlock('bash', '', 0.6, 'A-2', 'reason');
    expect(msg).toContain('0.60');  // toFixed(2)
  });

  test('Halt 모드(A-0) 아이콘/레이블 포함', () => {
    const msg = formatGateBlock('exec', '', 0.80, 'A-0', 'Halt 상태');
    expect(msg).toContain('Halt');
    expect(msg).toContain('🛑');
  });

});

// =============================================================================
// 2. formatGateConfirm
// =============================================================================

describe('formatGateConfirm — Safety Gate 확인 요청 메시지', () => {

  test('필수 요소: 확인 필요, 도구명, R(t), 모드, /pmatrix allow once, 타임아웃', () => {
    const msg = formatGateConfirm('browser', 'submit form', 0.35, 'A-1', 'Alert 구간 고위험', 20);
    expect(msg).toContain('확인 필요');
    expect(msg).toContain('browser');
    expect(msg).toContain('0.35');
    expect(msg).toContain('Alert');
    expect(msg).toContain('/pmatrix allow once');
    expect(msg).toContain('20초');
  });

  test('타임아웃 값이 메시지에 반영됨', () => {
    const msg = formatGateConfirm('bash', '', 0.20, 'A+0', 'Caution', 15);
    expect(msg).toContain('15초');
  });

  test('fail-closed 설명 포함', () => {
    const msg = formatGateConfirm('bash', '', 0.20, 'A+0', 'reason', 20);
    expect(msg).toContain('fail-closed');
  });

});

// =============================================================================
// 3. formatHaltAuto
// =============================================================================

describe('formatHaltAuto — 자동 Halt 메시지', () => {

  test('R(t) 값, Halt 키워드, resume 명령 포함', () => {
    const msg = formatHaltAuto(0.82, ['위험 동작 감지', '크레덴셜 유출 시도']);
    expect(msg).toContain('Halt');
    expect(msg).toContain('0.82');
    expect(msg).toContain('/pmatrix resume');
  });

  test('reasons 목록 모두 포함', () => {
    const msg = formatHaltAuto(0.80, ['사유1', '사유2', '사유3']);
    expect(msg).toContain('사유1');
    expect(msg).toContain('사유2');
    expect(msg).toContain('사유3');
    expect(msg).toContain('원인 분석');
  });

  test('reasons 빈 배열 → 원인 분석 섹션 없음, 크래시 없음', () => {
    const msg = formatHaltAuto(0.80, []);
    expect(msg).toContain('Halt');
    expect(msg).not.toContain('원인 분석');
  });

  test('report 명령 포함', () => {
    const msg = formatHaltAuto(0.75, []);
    expect(msg).toContain('/pmatrix report');
  });

});

// =============================================================================
// 4. formatHaltManual
// =============================================================================

describe('formatHaltManual — 수동 Kill Switch 메시지', () => {

  test('Kill Switch 키워드 및 resume 명령 포함', () => {
    const msg = formatHaltManual();
    expect(msg).toContain('Kill Switch');
    expect(msg).toContain('/pmatrix resume');
  });

  test('동일 호출 → 동일 결과 (순수 함수)', () => {
    expect(formatHaltManual()).toBe(formatHaltManual());
  });

});

// =============================================================================
// 5. formatResumeMessage
// =============================================================================

describe('formatResumeMessage — Halt 해제 메시지', () => {

  test('Halt 해제 키워드 및 ✅ 포함', () => {
    const msg = formatResumeMessage();
    expect(msg).toContain('Halt가 해제');
    expect(msg).toContain('✅');
  });

  test('동일 호출 → 동일 결과 (순수 함수)', () => {
    expect(formatResumeMessage()).toBe(formatResumeMessage());
  });

});

// =============================================================================
// 6. formatCredentialAlert
// =============================================================================

describe('formatCredentialAlert — 크레덴셜 차단 알림', () => {

  test('감지 패턴명, 건수, P-Score 변동 포함', () => {
    const msg = formatCredentialAlert(['OpenAI Project Key', 'AWS Access Key'], -0.30);
    expect(msg).toContain('크레덴셜 보호');
    expect(msg).toContain('OpenAI Project Key');
    expect(msg).toContain('AWS Access Key');
    expect(msg).toContain('2건');
  });

  test('metaControlDelta → 절댓값 % 변환 (-0.30 → -30)', () => {
    const msg = formatCredentialAlert(['Token'], -0.30);
    expect(msg).toContain('-30');
  });

  test('metaControlDelta -0.15 → -15', () => {
    const msg = formatCredentialAlert(['Bearer Token'], -0.15);
    expect(msg).toContain('-15');
  });

  test('단일 패턴 → 1건', () => {
    const msg = formatCredentialAlert(['GitHub Token'], -0.30);
    expect(msg).toContain('1건');
  });

  test('메시지 차단 안내 포함', () => {
    const msg = formatCredentialAlert(['Token'], -0.30);
    expect(msg).toContain('메시지 전송이 취소');
  });

});

// =============================================================================
// 7. formatStatusMessage — /pmatrix status
// =============================================================================

describe('formatStatusMessage — 전체 상태 표시', () => {

  test('에이전트ID, Grade, P-Score, 턴수, 이벤트 카운터 포함', () => {
    const state = createSession('s', 'agent-42', 'slack:#general');
    state.grade = 'B';
    state.pScore = 85;
    state.turnNumber = 7;
    state.dangerEvents = 2;
    state.credentialBlocks = 1;
    state.safetyGateBlocks = 1;

    const msg = formatStatusMessage(state);
    expect(msg).toContain('agent-42');
    expect(msg).toContain('B');
    expect(msg).toContain('85');
    expect(msg).toContain('7턴');
    expect(msg).toContain('2건');  // dangerEvents
  });

  test('grade=null → "─" 표시', () => {
    const state = createSession('s', 'agent-1');
    const msg = formatStatusMessage(state);
    expect(msg).toContain('─');
  });

  test('캐시 만료 시 "(캐시 만료 — 서버 재연결 대기)" 포함', () => {
    // 초기 rtCacheExpiry = new Date(0) → 이미 만료
    const state = createSession('s', 'agent-1');
    const msg = formatStatusMessage(state);
    expect(msg).toContain('캐시 만료');
  });

  test('4축 레이블 모두 포함 (Baseline, Norm, Stability, Meta Control)', () => {
    const state = createSession('s', 'agent-1');
    const msg = formatStatusMessage(state);
    expect(msg).toContain('Baseline');
    expect(msg).toContain('Norm');
    expect(msg).toContain('Stability');
    expect(msg).toContain('Meta Control');
  });

  test('R(t) 값 소수점 2자리 표시', () => {
    const state = createSession('s', 'agent-1');
    state.currentRt = 0.25;
    const msg = formatStatusMessage(state);
    expect(msg).toContain('0.25');
  });

  test('도움말 명령어 포함', () => {
    const state = createSession('s', 'agent-1');
    const msg = formatStatusMessage(state);
    expect(msg).toContain('/pmatrix report');
    expect(msg).toContain('/pmatrix help');
  });

  // ── [Tier-2] Sub-agent 표시 ─────────────────────────────────────────────

  test('[Tier-2] agentDepth=0 (root) → 하위 에이전트 행 없음', () => {
    const state = createSession('s', 'agent-root');
    // agentDepth 초기값 = 0 (root)
    const msg = formatStatusMessage(state);
    expect(msg).not.toContain('하위 에이전트');
    expect(msg).not.toContain('depth=');
  });

  test('[Tier-2] agentDepth>0 → 하위 에이전트 depth, 부모 ID 표시', () => {
    const state = createSession('s', 'child-agent');
    state.agentDepth = 2;
    state.parentAgentId = 'parent-agent-007';
    const msg = formatStatusMessage(state);
    expect(msg).toContain('하위 에이전트');
    expect(msg).toContain('depth=2');
    expect(msg).toContain('parent-agent-007');
  });

  // ── [Tier-2] Cost 표시 ──────────────────────────────────────────────────

  test('[Tier-2] 토큰 0 → 세션 토큰 행 없음', () => {
    const state = createSession('s', 'agent-1');
    // totalInputTokens=0, totalOutputTokens=0 (초기값)
    const msg = formatStatusMessage(state);
    expect(msg).not.toContain('세션 토큰');
  });

  test('[Tier-2] 토큰 > 0 → 세션 토큰 행 표시 (입력/출력/합계)', () => {
    const state = createSession('s', 'agent-1');
    state.totalInputTokens = 1200;
    state.totalOutputTokens = 480;
    const msg = formatStatusMessage(state);
    expect(msg).toContain('세션 토큰');
    expect(msg).toContain('1,200');   // toLocaleString
    expect(msg).toContain('480');
    expect(msg).toContain('1,680');   // 합계
  });

});

// =============================================================================
// 8. formatConnected / formatConnecting
// =============================================================================

describe('formatConnected — Gateway 연결 성공 메시지', () => {

  test('connected 키워드, Grade, R(t) 포함', () => {
    const msg = formatConnected('my-agent', 'B', 0.25);
    expect(msg).toContain('connected');
    expect(msg).toContain('Grade B');
    expect(msg).toContain('0.25');
  });

  test('모든 Grade(A~E) 처리 가능', () => {
    for (const grade of ['A', 'B', 'C', 'D', 'E'] as const) {
      const msg = formatConnected('agent', grade, 0.10);
      expect(msg).toContain(`Grade ${grade}`);
    }
  });

});

describe('formatConnecting — Gateway 연결 중 메시지', () => {

  test('agentId 및 connecting 키워드 포함', () => {
    const msg = formatConnecting('my-agent-id');
    expect(msg).toContain('my-agent-id');
    expect(msg).toContain('connecting');
  });

});

// =============================================================================
// 9. formatMetaControlBlock — META_CONTROL 즉시 차단
// =============================================================================

describe('formatMetaControlBlock — META_CONTROL 즉시 차단 메시지', () => {

  test('META_CONTROL 차단 키워드, 도구명, 감지 사유, 감점값 포함', () => {
    const msg = formatMetaControlBlock('bash', 'sudo 권한 상승 시도 감지', -0.25);
    expect(msg).toContain('META_CONTROL 차단');
    expect(msg).toContain('bash');
    expect(msg).toContain('sudo 권한 상승 시도 감지');
    expect(msg).toContain('-25');  // abs(-0.25)*100 = 25
  });

  test('-0.30 → "-30" 감점 표시', () => {
    const msg = formatMetaControlBlock('exec', 'rm -rf 감지', -0.30);
    expect(msg).toContain('-30');
  });

  test('-0.20 → "-20" 감점 표시', () => {
    const msg = formatMetaControlBlock('bash', 'curl|sh 감지', -0.20);
    expect(msg).toContain('-20');
  });

});
