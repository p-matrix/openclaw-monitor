// =============================================================================
// session-state.test.ts — 세션 상태 관리 자가 검증
// =============================================================================
//
// 검증 범위:
//   1. computeLocalRt — 공식 정확도, 클램프 [0,1]
//   2. createSession / getSession / getOrCreateSession / deleteSession — CRUD
//   3. bufferSignal / popBuffer / getBufferSize — 원자적 버퍼 조작
//   4. haltSession / resumeSession — Kill Switch
//   5. applyMetaControlDelta — meta_control 클램프, R(t)/Mode 낙관적 업데이트
//   6. updateRtCache / isRtCacheValid / getLocalRt — TTL 캐시
//   7. startLlmRun / completeLlmRun — latency 추적, 이동 평균 갱신
//   8. 이벤트 카운터 — credential/safetyGate/danger 중복 방지
//   9. recordSubagentSpawn / getRecentSubagentCount — 시간 윈도우 필터
//  10. buildSignalPayload — 4축 클램프, axesOverride, metadata 스프레드
//  11. pushMovingAvg / average — 유틸
//  12. captureBaseline — 최초 1회만 기록
//  13. getSessionCount
// =============================================================================

import {
  sessions,
  createSession,
  getSession,
  getOrCreateSession,
  deleteSession,
  bufferSignal,
  popBuffer,
  getBufferSize,
  haltSession,
  resumeSession,
  updateRtCache,
  isRtCacheValid,
  getLocalRt,
  applyMetaControlDelta,
  computeLocalRt,
  startLlmRun,
  completeLlmRun,
  incrementDangerEvents,
  incrementCredentialBlocks,
  incrementSafetyGateBlocks,
  recordSubagentSpawn,
  getRecentSubagentCount,
  buildSignalPayload,
  pushMovingAvg,
  average,
  getSessionCount,
  captureBaseline,
  pendingChildLinks,
  sweepStalePendingLinks,
} from '../session-state';
import type { AxesState, SignalPayload } from '../types';

// 각 테스트 전 sessions Map + pendingChildLinks 초기화 (테스트 격리)
beforeEach(() => {
  sessions.clear();
  pendingChildLinks.clear();
});

afterEach(() => {
  jest.useRealTimers();
});

// =============================================================================
// 1. computeLocalRt — 4축 기반 R(t) 계산
// =============================================================================

describe('computeLocalRt — 공식 및 클램프', () => {

  test('건강한 기본 축 → R(t) = 0.0', () => {
    // baseline=1, norm=1, stability=0, meta_control=1
    // = 1 - (1+1+1+1)/4 = 1 - 1.0 = 0.0
    const axes: AxesState = { baseline: 1, norm: 1, stability: 0, meta_control: 1 };
    expect(computeLocalRt(axes)).toBeCloseTo(0.0, 6);
  });

  test('최대 위험 축 → R(t) = 1.0', () => {
    // baseline=0, norm=0, stability=1, meta_control=0
    // = 1 - (0+0+0+0)/4 = 1.0
    const axes: AxesState = { baseline: 0, norm: 0, stability: 1, meta_control: 0 };
    expect(computeLocalRt(axes)).toBeCloseTo(1.0, 6);
  });

  test('혼합 축 → 공식 계산값 정확', () => {
    // baseline=0.8, norm=0.8, stability=0.3, meta_control=0.8
    // (1-stability)=0.7
    // = 1 - (0.8+0.8+0.7+0.8)/4 = 1 - 3.1/4 = 1 - 0.775 = 0.225
    const axes: AxesState = { baseline: 0.8, norm: 0.8, stability: 0.3, meta_control: 0.8 };
    expect(computeLocalRt(axes)).toBeCloseTo(0.225, 6);
  });

  test('META_CONTROL -0.30 적용 후 R(t) = 0.075', () => {
    // meta_control: 1.0 → 0.70 → (1+1+1+0.70)/4 = 3.70/4 = 0.925 → 1-0.925=0.075
    const axes: AxesState = { baseline: 1, norm: 1, stability: 0, meta_control: 0.7 };
    expect(computeLocalRt(axes)).toBeCloseTo(0.075, 6);
  });

  test('범위 초과 입력 → clamp01 적용, R(t) < 0 없음', () => {
    // baseline=2처럼 범위 초과 입력 시 음수 R(t) → clamp01 → 0.0
    const axes: AxesState = { baseline: 2, norm: 2, stability: 0, meta_control: 2 };
    const rt = computeLocalRt(axes);
    expect(rt).toBeGreaterThanOrEqual(0);
    expect(rt).toBeLessThanOrEqual(1);
  });

});

// =============================================================================
// 2. 세션 CRUD
// =============================================================================

describe('세션 CRUD — createSession / getSession / getOrCreateSession / deleteSession', () => {

  test('createSession → 올바른 초기 상태로 생성', () => {
    const state = createSession('sess-1', 'agent-1', 'test-channel');
    expect(state.sessionId).toBe('sess-1');
    expect(state.agentId).toBe('agent-1');
    expect(state.channel).toBe('test-channel');
    expect(state.turnNumber).toBe(0);
    expect(state.isHalted).toBe(false);
    expect(state.currentRt).toBeCloseTo(0.0);
    expect(state.currentMode).toBe('A+1');
    expect(state.signalBuffer).toHaveLength(0);
    expect(state.dangerEvents).toBe(0);
    expect(state.credentialBlocks).toBe(0);
    expect(state.safetyGateBlocks).toBe(0);
  });

  test('createSession — channel 기본값은 "unknown"', () => {
    const state = createSession('sess-2', 'agent-1');
    expect(state.channel).toBe('unknown');
  });

  test('createSession → sessions Map에 등록됨', () => {
    createSession('sess-3', 'agent-1');
    expect(sessions.has('sess-3')).toBe(true);
  });

  test('getSession — 존재하는 키 → 세션 반환', () => {
    createSession('sess-1', 'agent-1');
    const state = getSession('sess-1');
    expect(state).toBeDefined();
    expect(state!.sessionId).toBe('sess-1');
  });

  test('getSession — 존재하지 않는 키 → undefined', () => {
    expect(getSession('nonexistent')).toBeUndefined();
  });

  test('getOrCreateSession — 없으면 새로 생성', () => {
    const state = getOrCreateSession('sess-new', 'agent-1');
    expect(state.sessionId).toBe('sess-new');
    expect(sessions.has('sess-new')).toBe(true);
  });

  test('getOrCreateSession — 이미 있으면 기존 세션 반환 (중복 생성 없음)', () => {
    const first = createSession('sess-exist', 'agent-1');
    first.turnNumber = 99;  // 변형 후 재조회

    const second = getOrCreateSession('sess-exist', 'agent-1');
    expect(second.turnNumber).toBe(99);  // 동일 객체 참조
    expect(sessions.size).toBe(1);       // 중복 없음
  });

  test('deleteSession → 세션 제거', () => {
    createSession('sess-del', 'agent-1');
    deleteSession('sess-del');
    expect(sessions.has('sess-del')).toBe(false);
  });

  test('deleteSession — 존재하지 않는 키 → 에러 없이 무시', () => {
    expect(() => deleteSession('ghost')).not.toThrow();
  });

  test('getSessionCount — 활성 세션 수 정확', () => {
    expect(getSessionCount()).toBe(0);
    createSession('s1', 'a1');
    createSession('s2', 'a2');
    expect(getSessionCount()).toBe(2);
    deleteSession('s1');
    expect(getSessionCount()).toBe(1);
  });

});

// =============================================================================
// 3. 신호 버퍼 — bufferSignal / popBuffer / getBufferSize
// =============================================================================

describe('신호 버퍼 — bufferSignal / popBuffer / getBufferSize', () => {

  function makeSignal(eventType = 'test'): SignalPayload {
    const state = createSession('_sig-maker', 'a');
    const s = buildSignalPayload(state, { event_type: eventType });
    sessions.delete('_sig-maker');
    return s;
  }

  test('초기 버퍼 크기 = 0', () => {
    createSession('s', 'a');
    expect(getBufferSize('s')).toBe(0);
  });

  test('bufferSignal → 크기 증가', () => {
    createSession('s', 'a');
    bufferSignal('s', makeSignal());
    bufferSignal('s', makeSignal());
    expect(getBufferSize('s')).toBe(2);
  });

  test('popBuffer → 신호 전체 반환 후 버퍼 초기화', () => {
    createSession('s', 'a');
    const sig1 = makeSignal('event-a');
    const sig2 = makeSignal('event-b');
    bufferSignal('s', sig1);
    bufferSignal('s', sig2);

    const popped = popBuffer('s');
    expect(popped).toHaveLength(2);
    expect(popped[0]!.metadata['event_type']).toBe('event-a');
    expect(popped[1]!.metadata['event_type']).toBe('event-b');

    // 버퍼 초기화 확인
    expect(getBufferSize('s')).toBe(0);
    expect(popBuffer('s')).toHaveLength(0);
  });

  test('popBuffer — 존재하지 않는 세션 → 빈 배열 반환 (크래시 없음)', () => {
    const result = popBuffer('ghost');
    expect(result).toEqual([]);
  });

  test('bufferSignal — 존재하지 않는 세션 → 조용히 무시', () => {
    expect(() => bufferSignal('ghost', makeSignal())).not.toThrow();
  });

  test('popBuffer 후 추가 버퍼링 → 새 배열 독립', () => {
    createSession('s', 'a');
    bufferSignal('s', makeSignal('first'));
    popBuffer('s');  // 비움

    bufferSignal('s', makeSignal('second'));
    const popped = popBuffer('s');
    expect(popped).toHaveLength(1);
    expect(popped[0]!.metadata['event_type']).toBe('second');
  });

});

// =============================================================================
// 4. Kill Switch — haltSession / resumeSession
// =============================================================================

describe('Kill Switch — haltSession / resumeSession', () => {

  test('haltSession → isHalted=true, haltReason 설정, dangerEvents 증가', () => {
    createSession('s', 'a');
    haltSession('s', 'R(t) threshold exceeded');

    const state = getSession('s')!;
    expect(state.isHalted).toBe(true);
    expect(state.haltReason).toBe('R(t) threshold exceeded');
    expect(state.dangerEvents).toBe(1);
  });

  test('resumeSession → isHalted=false, haltReason 초기화', () => {
    createSession('s', 'a');
    haltSession('s', 'test halt');
    resumeSession('s');

    const state = getSession('s')!;
    expect(state.isHalted).toBe(false);
    expect(state.haltReason).toBeUndefined();
  });

  test('haltSession — 존재하지 않는 세션 → 크래시 없음', () => {
    expect(() => haltSession('ghost', 'reason')).not.toThrow();
  });

  test('resumeSession — 존재하지 않는 세션 → 크래시 없음', () => {
    expect(() => resumeSession('ghost')).not.toThrow();
  });

});

// =============================================================================
// 5. META_CONTROL 델타 — applyMetaControlDelta
// =============================================================================

describe('applyMetaControlDelta — meta_control 업데이트 및 클램프', () => {

  test('-0.30 적용 → meta_control: 1.0 → 0.70, R(t) → 0.075', () => {
    createSession('s', 'a');
    const snapshot = applyMetaControlDelta('s', -0.30);

    expect(snapshot).not.toBeNull();
    expect(snapshot!.meta_control).toBeCloseTo(0.70, 6);

    // R(t) 낙관적 업데이트 확인
    const rt = getLocalRt('s');
    expect(rt).toBeCloseTo(0.075, 6);
  });

  test('연속 적용 → 누적 감소', () => {
    createSession('s', 'a');
    applyMetaControlDelta('s', -0.30);  // meta_control → 0.70
    const snap = applyMetaControlDelta('s', -0.30);  // → 0.40

    expect(snap!.meta_control).toBeCloseTo(0.40, 6);
  });

  test('클램프 하한 — 0.0 미만 → 0.0으로 고정', () => {
    createSession('s', 'a');
    const snap = applyMetaControlDelta('s', -1.50);  // 1.0 + (-1.5) = -0.5 → 0.0
    expect(snap!.meta_control).toBeCloseTo(0.0, 6);
  });

  test('클램프 상한 — 1.0 초과 → 1.0으로 고정', () => {
    createSession('s', 'a');
    const snap = applyMetaControlDelta('s', +0.50);  // 1.0 + 0.5 = 1.5 → 1.0
    expect(snap!.meta_control).toBeCloseTo(1.0, 6);
  });

  test('반환값은 AxesState 스냅샷 (원본 변형 추적용)', () => {
    createSession('s', 'a');
    const snap = applyMetaControlDelta('s', -0.30);
    // 스냅샷이므로 값 존재 + 원본 axes와 독립
    expect(snap).toHaveProperty('baseline');
    expect(snap).toHaveProperty('norm');
    expect(snap).toHaveProperty('stability');
    expect(snap).toHaveProperty('meta_control');
  });

  test('존재하지 않는 세션 → null 반환', () => {
    expect(applyMetaControlDelta('ghost', -0.30)).toBeNull();
  });

  test('applyMetaControlDelta → currentMode도 갱신됨', () => {
    createSession('s', 'a');
    // 초기: R(t)=0.0 → mode='A+1'
    // -0.30×6 = meta_control→0.0→R(t)=0.25→'A-1'
    for (let i = 0; i < 6; i++) applyMetaControlDelta('s', -0.30);
    const state = getSession('s')!;
    // meta_control clamped at 0.0, R(t)=0.25 → 0.15≤0.25<0.30 → 'A-1'
    expect(['A+0', 'A-1', 'A-2']).toContain(state.currentMode);
  });

});

// =============================================================================
// 6. R(t) 캐시 — updateRtCache / isRtCacheValid / getLocalRt
// =============================================================================

describe('R(t) 캐시 — updateRtCache / isRtCacheValid / getLocalRt', () => {

  test('초기 rtCacheExpiry = new Date(0) → isRtCacheValid = false', () => {
    createSession('s', 'a');
    expect(isRtCacheValid('s')).toBe(false);
  });

  test('updateRtCache 후 → isRtCacheValid = true (30초 TTL)', () => {
    createSession('s', 'a');
    updateRtCache('s', 0.25, 'A-1', 'B', null, { baseline: 0.9, norm: 0.9, stability: 0.1, meta_control: 0.9 });
    expect(isRtCacheValid('s')).toBe(true);
  });

  test('updateRtCache 후 → getLocalRt 갱신됨', () => {
    createSession('s', 'a');
    updateRtCache('s', 0.42, 'A-2', null, null, { baseline: 0.8, norm: 0.8, stability: 0.2, meta_control: 0.8 });
    expect(getLocalRt('s')).toBeCloseTo(0.42, 6);
  });

  test('존재하지 않는 세션 → getLocalRt = 0.0 (fail-open)', () => {
    expect(getLocalRt('ghost')).toBeCloseTo(0.0, 6);
  });

  test('존재하지 않는 세션 → isRtCacheValid = false', () => {
    expect(isRtCacheValid('ghost')).toBe(false);
  });

});

// =============================================================================
// 7. LLM latency 추적 — startLlmRun / completeLlmRun
// =============================================================================

describe('LLM latency 추적 — startLlmRun / completeLlmRun', () => {

  test('startLlmRun + completeLlmRun → 비음수 latency 반환', async () => {
    createSession('s', 'a');
    startLlmRun('s', 'run-001');
    const latency = completeLlmRun('s', 'run-001');
    expect(latency).not.toBeNull();
    expect(latency!).toBeGreaterThanOrEqual(0);
  });

  test('fake timer: completeLlmRun → 정확한 latency 반환', () => {
    jest.useFakeTimers();
    const now = 1_000_000;
    jest.setSystemTime(now);

    createSession('s', 'a');
    startLlmRun('s', 'run-002');

    jest.setSystemTime(now + 500);
    const latency = completeLlmRun('s', 'run-002');
    expect(latency).toBe(500);
  });

  test('알 수 없는 runId → null 반환', () => {
    createSession('s', 'a');
    expect(completeLlmRun('s', 'unknown-run')).toBeNull();
  });

  test('completeLlmRun 후 runId 삭제 — 재호출 시 null', () => {
    createSession('s', 'a');
    startLlmRun('s', 'run-003');
    completeLlmRun('s', 'run-003');
    // 두 번째 호출: runId 삭제됨 → null
    expect(completeLlmRun('s', 'run-003')).toBeNull();
  });

  test('completeLlmRun → llmLatencies 이동 평균 갱신', () => {
    createSession('s', 'a');
    startLlmRun('s', 'run-004');
    completeLlmRun('s', 'run-004');

    const state = getSession('s')!;
    expect(state.movingAvg.llmLatencies).toHaveLength(1);
    expect(state.movingAvg.llmLatencies[0]).toBeGreaterThanOrEqual(0);
  });

  test('존재하지 않는 세션 → startLlmRun/completeLlmRun 크래시 없음', () => {
    expect(() => startLlmRun('ghost', 'r1')).not.toThrow();
    expect(completeLlmRun('ghost', 'r1')).toBeNull();
  });

});

// =============================================================================
// 8. 이벤트 카운터
// =============================================================================

describe('이벤트 카운터 — credentialBlocks / safetyGateBlocks / dangerEvents', () => {

  test('incrementCredentialBlocks → credentialBlocks+1, dangerEvents+1', () => {
    createSession('s', 'a');
    incrementCredentialBlocks('s');
    const state = getSession('s')!;
    expect(state.credentialBlocks).toBe(1);
    expect(state.dangerEvents).toBe(1);
  });

  test('incrementSafetyGateBlocks → safetyGateBlocks+1, dangerEvents+1', () => {
    createSession('s', 'a');
    incrementSafetyGateBlocks('s');
    const state = getSession('s')!;
    expect(state.safetyGateBlocks).toBe(1);
    expect(state.dangerEvents).toBe(1);
  });

  test('incrementDangerEvents → dangerEvents만 +1', () => {
    createSession('s', 'a');
    incrementDangerEvents('s');
    const state = getSession('s')!;
    expect(state.dangerEvents).toBe(1);
    expect(state.credentialBlocks).toBe(0);
    expect(state.safetyGateBlocks).toBe(0);
  });

  test('복수 카운터 독립 누적', () => {
    createSession('s', 'a');
    incrementCredentialBlocks('s');
    incrementCredentialBlocks('s');
    incrementSafetyGateBlocks('s');
    const state = getSession('s')!;
    expect(state.credentialBlocks).toBe(2);
    expect(state.safetyGateBlocks).toBe(1);
    expect(state.dangerEvents).toBe(3);  // 2 + 1
  });

});

// =============================================================================
// 9. 하위 에이전트 추적 — recordSubagentSpawn / getRecentSubagentCount
// =============================================================================

describe('하위 에이전트 추적 — recordSubagentSpawn / getRecentSubagentCount', () => {

  test('초기 카운트 = 0', () => {
    createSession('s', 'a');
    expect(getRecentSubagentCount('s')).toBe(0);
  });

  test('spawn 기록 후 → 카운트 증가', () => {
    jest.useFakeTimers();
    jest.setSystemTime(1_000_000);
    createSession('s', 'a');
    recordSubagentSpawn('s');
    recordSubagentSpawn('s');
    expect(getRecentSubagentCount('s', 60_000)).toBe(2);
  });

  test('윈도우 밖 오래된 spawn → 카운트 미포함', () => {
    jest.useFakeTimers();
    const now = 1_000_000;
    jest.setSystemTime(now);
    createSession('s', 'a');
    recordSubagentSpawn('s');  // at t=now

    jest.setSystemTime(now + 10_000);  // 10초 후
    recordSubagentSpawn('s');  // at t=now+10s

    // 5초 윈도우 → now+10s 기준 cutoff=now+5s → 첫 번째 제외
    const count = getRecentSubagentCount('s', 5_000);
    expect(count).toBe(1);
  });

  test('존재하지 않는 세션 → 0 반환', () => {
    expect(getRecentSubagentCount('ghost')).toBe(0);
  });

});

// =============================================================================
// 10. buildSignalPayload — 페이로드 생성
// =============================================================================

describe('buildSignalPayload — 페이로드 구조 및 axesOverride', () => {

  test('기본 페이로드 구조 정확', () => {
    const state = createSession('s', 'agent-42', 'slack:#general');
    state.turnNumber = 7;

    const payload = buildSignalPayload(state, { event_type: 'test_event' });

    expect(payload.agent_id).toBe('agent-42');
    expect(payload.signal_source).toBe('adapter_stream');
    expect(payload.framework).toBe('openclaw');
    expect(payload.framework_tag).toBe('stable');
    expect(payload.state_vector).toBeNull();
    expect(payload.metadata['event_type']).toBe('test_event');
    expect(payload.metadata['channel']).toBe('slack:#general');
    expect(payload.metadata['turn_number']).toBe(7);
    expect(payload.metadata['session_id']).toBe('s');
  });

  test('기본 axes(건강) → 4축 값 정확', () => {
    const state = createSession('s', 'a');
    const payload = buildSignalPayload(state, { event_type: 't' });
    expect(payload.baseline).toBeCloseTo(1.0);
    expect(payload.norm).toBeCloseTo(1.0);
    expect(payload.stability).toBeCloseTo(0.0);
    expect(payload.meta_control).toBeCloseTo(1.0);
  });

  test('axesOverride 적용 → 지정 축만 변경', () => {
    const state = createSession('s', 'a');
    const payload = buildSignalPayload(state, { event_type: 't' }, { meta_control: 0.5 });

    expect(payload.meta_control).toBeCloseTo(0.5);
    expect(payload.baseline).toBeCloseTo(1.0);  // 나머지 축 유지
    expect(payload.norm).toBeCloseTo(1.0);
  });

  test('axesOverride 값도 clamp01 적용 (1.5 → 1.0)', () => {
    const state = createSession('s', 'a');
    const payload = buildSignalPayload(state, { event_type: 't' }, { baseline: 1.5 });
    expect(payload.baseline).toBeCloseTo(1.0);
  });

  test('metadata 추가 필드 스프레드', () => {
    const state = createSession('s', 'a');
    const payload = buildSignalPayload(state, {
      event_type: 'credential_detected',
      patterns: ['OpenAI Project Key'],
      meta_control_delta: -0.30,
      priority: 'critical',
    });
    expect(payload.metadata['patterns']).toEqual(['OpenAI Project Key']);
    expect(payload.metadata['meta_control_delta']).toBe(-0.30);
    expect(payload.metadata['priority']).toBe('critical');
  });

});

// =============================================================================
// 11. 유틸 — pushMovingAvg / average
// =============================================================================

describe('pushMovingAvg / average', () => {

  test('maxLen 미만 추가 → 전체 보존', () => {
    const result = pushMovingAvg([1, 2, 3], 4, 10);
    expect(result).toEqual([1, 2, 3, 4]);
  });

  test('maxLen 초과 시 가장 오래된 항목 제거', () => {
    const result = pushMovingAvg([1, 2, 3, 4, 5], 6, 5);
    expect(result).toEqual([2, 3, 4, 5, 6]);
  });

  test('빈 배열에서 시작', () => {
    const result = pushMovingAvg([], 42, 3);
    expect(result).toEqual([42]);
  });

  test('maxLen=1 → 항상 최신 1개만 유지', () => {
    let arr: number[] = [];
    arr = pushMovingAvg(arr, 10, 1);
    arr = pushMovingAvg(arr, 20, 1);
    expect(arr).toEqual([20]);
  });

  test('average — 빈 배열 → 0', () => {
    expect(average([])).toBe(0);
  });

  test('average — 단일 값 → 그 값 그대로', () => {
    expect(average([42])).toBe(42);
  });

  test('average — 복수 값 → 올바른 평균', () => {
    expect(average([1, 2, 3, 4, 5])).toBeCloseTo(3.0, 6);
  });

});

// =============================================================================
// 12. captureBaseline — 최초 1회만 기록
// =============================================================================

describe('captureBaseline — 최초 1회만 기록', () => {

  test('첫 호출 → baselineModel/Provider 설정', () => {
    createSession('s', 'a');
    captureBaseline('s', 'anthropic', 'claude-sonnet-4-5');
    const state = getSession('s')!;
    expect(state.baselineModel).toBe('claude-sonnet-4-5');
    expect(state.baselineProvider).toBe('anthropic');
  });

  test('두 번째 호출 → 무시 (최초 값 유지)', () => {
    createSession('s', 'a');
    captureBaseline('s', 'anthropic', 'claude-sonnet-4-5');
    captureBaseline('s', 'openai', 'gpt-4o');  // 두 번째 → 무시
    const state = getSession('s')!;
    expect(state.baselineProvider).toBe('anthropic');
    expect(state.baselineModel).toBe('claude-sonnet-4-5');
  });

  test('promptHash, files 선택적 저장', () => {
    createSession('s', 'a');
    captureBaseline('s', 'anthropic', 'claude-sonnet-4-5', 'hash123', ['file1.ts']);
    const state = getSession('s')!;
    expect(state.baselinePromptHash).toBe('hash123');
    expect(state.baselineFiles).toEqual(['file1.ts']);
  });

});

// =============================================================================
// 14. createSession Tier-2 초기값 — agentDepth / parentAgentId
// =============================================================================

describe('createSession — Tier-2 Sub-Agent 초기값', () => {

  test('신규 세션 → agentDepth=0, parentAgentId=null', () => {
    const state = createSession('root-key', 'root-agent');
    expect(state.agentDepth).toBe(0);
    expect(state.parentAgentId).toBeNull();
  });

  test('schema_version은 buildSignalPayload에서 자동 포함', () => {
    const state = createSession('s', 'a');
    const payload = buildSignalPayload(state, { event_type: 'test' });
    expect(payload.schema_version).toBe('0.3');
  });

  test('buildSignalPayload → Sub-Agent 컨텍스트 자동 포함 (root)', () => {
    const state = createSession('s', 'root-agent');
    const payload = buildSignalPayload(state, { event_type: 'test' });
    expect(payload.metadata.parent_agent_id).toBeNull();
    expect(payload.metadata.agent_depth).toBe(0);
    expect(payload.metadata.is_sub_agent).toBe(false);
  });

  test('agentDepth > 0이면 is_sub_agent=true', () => {
    const state = createSession('child-key', 'child-agent');
    state.agentDepth = 1;
    state.parentAgentId = 'parent-agent';
    const payload = buildSignalPayload(state, { event_type: 'test' });
    expect(payload.metadata.is_sub_agent).toBe(true);
    expect(payload.metadata.agent_depth).toBe(1);
    expect(payload.metadata.parent_agent_id).toBe('parent-agent');
  });

});

// =============================================================================
// 15. pendingChildLinks — TTL sweep / set / get / delete / gateway_stop
// =============================================================================

describe('pendingChildLinks — 교차 세션 Sub-Agent 브릿지', () => {

  test('초기 상태 — pendingChildLinks 비어 있음', () => {
    expect(pendingChildLinks.size).toBe(0);
  });

  test('set → get → delete (정상 소비 흐름)', () => {
    pendingChildLinks.set('child-agent-1', {
      parentAgentId: 'parent-agent',
      depth: 1,
      createdAt: Date.now(),
    });

    const link = pendingChildLinks.get('child-agent-1');
    expect(link).toBeDefined();
    expect(link!.parentAgentId).toBe('parent-agent');
    expect(link!.depth).toBe(1);

    pendingChildLinks.delete('child-agent-1');
    expect(pendingChildLinks.has('child-agent-1')).toBe(false);
  });

  test('depth 전파 — root(0) → child(1) → grandchild(2)', () => {
    // root agent session
    const rootState = createSession('root-key', 'root-agent');
    expect(rootState.agentDepth).toBe(0);
    expect(rootState.parentAgentId).toBeNull();

    // root spawns child → pendingChildLinks.set
    pendingChildLinks.set('child-agent', {
      parentAgentId: rootState.agentId,
      depth: rootState.agentDepth + 1,
      createdAt: Date.now(),
    });

    // child session_start → consumes link
    const childState = createSession('child-key', 'child-agent');
    const linkForChild = pendingChildLinks.get('child-agent');
    if (linkForChild) {
      childState.parentAgentId = linkForChild.parentAgentId;
      childState.agentDepth = linkForChild.depth;
      pendingChildLinks.delete('child-agent');
    }
    expect(childState.agentDepth).toBe(1);
    expect(childState.parentAgentId).toBe('root-agent');

    // child spawns grandchild → pendingChildLinks.set
    pendingChildLinks.set('grandchild-agent', {
      parentAgentId: childState.agentId,
      depth: childState.agentDepth + 1,
      createdAt: Date.now(),
    });

    // grandchild session_start → consumes link
    const grandchildState = createSession('grandchild-key', 'grandchild-agent');
    const linkForGrandchild = pendingChildLinks.get('grandchild-agent');
    if (linkForGrandchild) {
      grandchildState.parentAgentId = linkForGrandchild.parentAgentId;
      grandchildState.agentDepth = linkForGrandchild.depth;
      pendingChildLinks.delete('grandchild-agent');
    }
    expect(grandchildState.agentDepth).toBe(2);
    expect(grandchildState.parentAgentId).toBe('child-agent');

    // 소비 후 Map 비어 있음
    expect(pendingChildLinks.size).toBe(0);
  });

  test('session_start 미발화 → link 잔류', () => {
    pendingChildLinks.set('orphan-agent', {
      parentAgentId: 'parent',
      depth: 1,
      createdAt: Date.now(),
    });
    // session_start 없이 link 잔류
    expect(pendingChildLinks.has('orphan-agent')).toBe(true);
  });

  test('TTL sweep — 10분 초과 엔트리 삭제', () => {
    jest.useFakeTimers();

    const OLD_MS = Date.now() - 11 * 60_000;  // 11분 전
    pendingChildLinks.set('stale-child', {
      parentAgentId: 'parent',
      depth: 1,
      createdAt: OLD_MS,
    });
    pendingChildLinks.set('fresh-child', {
      parentAgentId: 'parent',
      depth: 1,
      createdAt: Date.now(),
    });

    sweepStalePendingLinks();

    expect(pendingChildLinks.has('stale-child')).toBe(false);  // 삭제됨
    expect(pendingChildLinks.has('fresh-child')).toBe(true);   // 유지됨

    jest.useRealTimers();
  });

  test('TTL sweep — 9분 57초 경과 엔트리는 유지', () => {
    const ALMOST_TTL = Date.now() - 9 * 60_000 - 57_000;  // 9분 57초 전
    pendingChildLinks.set('almost-stale', {
      parentAgentId: 'parent',
      depth: 1,
      createdAt: ALMOST_TTL,
    });

    sweepStalePendingLinks();

    expect(pendingChildLinks.has('almost-stale')).toBe(true);
  });

  test('gateway_stop 시뮬레이션 → .clear()로 전체 정리', () => {
    pendingChildLinks.set('child-1', { parentAgentId: 'p', depth: 1, createdAt: Date.now() });
    pendingChildLinks.set('child-2', { parentAgentId: 'p', depth: 1, createdAt: Date.now() });
    pendingChildLinks.set('child-3', { parentAgentId: 'p', depth: 2, createdAt: Date.now() });

    expect(pendingChildLinks.size).toBe(3);

    // gateway_stop에서 수행하는 동작
    pendingChildLinks.clear();

    expect(pendingChildLinks.size).toBe(0);
  });

  test('link 없으면 root agent → depth=0, parentAgentId=null 유지', () => {
    const state = createSession('root-key', 'root-agent');
    // pendingChildLinks.get('root-agent') === undefined → link 없음
    const link = pendingChildLinks.get('root-agent');
    expect(link).toBeUndefined();
    // 초기값 유지 확인
    expect(state.agentDepth).toBe(0);
    expect(state.parentAgentId).toBeNull();
  });

  test('복수 동시 spawning → 각각 독립 depth', () => {
    const rootState = createSession('root', 'root-agent');

    // root가 동시에 2명의 child를 spawn
    pendingChildLinks.set('child-a', {
      parentAgentId: rootState.agentId,
      depth: 1,
      createdAt: Date.now(),
    });
    pendingChildLinks.set('child-b', {
      parentAgentId: rootState.agentId,
      depth: 1,
      createdAt: Date.now(),
    });

    // child-a session_start
    const stateA = createSession('key-a', 'child-a');
    const linkA = pendingChildLinks.get('child-a')!;
    stateA.agentDepth = linkA.depth;
    stateA.parentAgentId = linkA.parentAgentId;
    pendingChildLinks.delete('child-a');

    // child-b session_start
    const stateB = createSession('key-b', 'child-b');
    const linkB = pendingChildLinks.get('child-b')!;
    stateB.agentDepth = linkB.depth;
    stateB.parentAgentId = linkB.parentAgentId;
    pendingChildLinks.delete('child-b');

    expect(stateA.agentDepth).toBe(1);
    expect(stateA.parentAgentId).toBe('root-agent');
    expect(stateB.agentDepth).toBe(1);
    expect(stateB.parentAgentId).toBe('root-agent');
    expect(pendingChildLinks.size).toBe(0);
  });

});
