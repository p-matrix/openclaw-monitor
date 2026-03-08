// =============================================================================
// @pmatrix/openclaw-monitor — session-state.ts
// 세션 격리 상태 관리: Map<sessionKey, SessionState>
//
// 핵심 원칙 (§14-3):
//   동일 Gateway에서 멀티 에이전트 동시 실행 시 상태가 섞이지 않도록
//   모든 상태를 sessionKey 기반 Map으로 관리.
//   sessionKey = ctx.sessionKey ?? event.sessionId (일관된 키 사용 필수)
// =============================================================================

import {
  SessionState,
  SignalPayload,
  SignalMetadata,
  SafetyMode,
  TrustGrade,
  AxesState,
  MovingAverage,
  PendingLink,
  TurnSnapshot,
} from './types';

// ─── 전역 세션 맵 ─────────────────────────────────────────────────────────────

/** 모든 활성 세션의 상태 저장소 */
export const sessions = new Map<string, SessionState>();

/** 플러그인 초기화 시 설정되는 framework_tag (기본 'beta') */
let _frameworkTag: 'beta' | 'stable' = 'beta';
export function setFrameworkTag(tag: 'beta' | 'stable'): void { _frameworkTag = tag; }

// ─── pendingChildLinks — 교차 세션 Sub-Agent 브릿지 (§A-1) ──────────────────
//
// 설계 근거:
//   subagent_spawning = 부모 세션 컨텍스트에서 발화
//   session_start     = 자식 세션 컨텍스트에서 발화
//   → 서로 다른 sessionKey이므로 SessionState 내부 Map으로는 교차 조회 불가
//   → 전역 Map을 공유 브릿지로 사용 (O(1) 조회)
//
// 누수 방지 (2중 안전장치):
//   1. sweepStalePendingLinks() — TTL 10분 초과 엔트리 삭제
//      (subagent_spawning + session_start 발화마다 수행)
//   2. pendingChildLinks.clear() — gateway_stop (플러그인 레벨 종료) 시 전체 정리

/** key = child agentId (subagent_spawning event.agentId) */
export const pendingChildLinks = new Map<string, PendingLink>();

/** TTL sweep 상수 (10분) */
const PENDING_LINK_TTL_MS = 10 * 60_000;

/**
 * TTL 10분 초과 pendingChildLinks 엔트리 삭제.
 * subagent_spawning + session_start 발화마다 호출 (상시 정리).
 */
export function sweepStalePendingLinks(): void {
  const now = Date.now();
  for (const [childAgentId, link] of pendingChildLinks) {
    if (now - link.createdAt > PENDING_LINK_TTL_MS) {
      pendingChildLinks.delete(childAgentId);
    }
  }
}

// ─── 초기값 ───────────────────────────────────────────────────────────────────

/** R(t) 캐시 TTL (ms) */
const RT_CACHE_TTL_MS = 30_000;

/** 이동 평균 유지 크기 */
const MA_MESSAGE_LENGTH_SIZE = 10;
const MA_OUTPUT_TOKENS_SIZE = 10;
const MA_TOOL_DURATION_SIZE = 5;
const MA_LLM_LATENCY_SIZE = 10;

/** 하위 에이전트 폭발 감지 윈도우 (ms) */
const SUBAGENT_EXPLOSION_WINDOW_MS = 5 * 60 * 1_000;  // 5분

function makeDefaultAxes(): AxesState {
  return { baseline: 1.0, norm: 1.0, stability: 0.0, meta_control: 1.0 };
}

function makeMovingAverage(): MovingAverage {
  return {
    messageLengths: [],
    outputTokens: [],
    toolDurations: new Map(),
    llmLatencies: [],
  };
}

// ─── 세션 CRUD ────────────────────────────────────────────────────────────────

/**
 * 새 세션 생성 및 등록
 */
export function createSession(
  sessionKey: string,
  agentId: string,
  channel = 'unknown'
): SessionState {
  const now = new Date();
  const state: SessionState = {
    sessionId: sessionKey,
    agentId,
    channel,
    startedAt: now,
    turnNumber: 0,
    turnStartedAt: null,

    isHalted: false,
    haltReason: undefined,

    // 초기 R(t) = 0.0 (캐시 없음, fail-open §7-1)
    currentRt: 0.0,
    currentMode: 'A+1',
    axes: makeDefaultAxes(),
    grade: null,
    pScore: null,

    signalBuffer: [],
    lastFlushAt: now,

    baselineModel: null,
    baselineProvider: null,
    baselinePromptHash: null,
    baselineFiles: null,

    movingAvg: makeMovingAverage(),

    dangerEvents: 0,
    credentialBlocks: 0,
    safetyGateBlocks: 0,

    // rtCacheExpiry = 과거 → 즉시 만료 → 첫 폴링 시 갱신
    rtCacheExpiry: new Date(0),

    pendingLlmRuns: new Map(),
    subagentTimestamps: [],
    pendingConfirmation: null,

    // ── Sub-Agent 트리 (Tier-2, §A-1) ──────────────────────────────────────
    // pendingChildLinks.get(agentId)가 session_start에서 소비되면 값이 설정됨
    agentDepth: 0,
    parentAgentId: null,

    // ── 턴 간 Drift 추적 (GA B-6) ──────────────────────────────────────────
    prevTurnSnapshot: null,

    // ── 자율성 에스컬레이션 추적 (GA B-5) ────────────────────────────────────
    consecutiveToolCalls: 0,
    turnToolCalls: 0,
    turnHighRiskCalls: 0,

    // ── 도구 체인 위험도 추적 (GA B-7) ────────────────────────────────────────
    recentToolChain: [],
    detectedChainPatterns: new Set(),

    // ── 토큰 누적 (Cost Tracker, Tier-2 §A-2) ──────────────────────────────
    // cost_usd 계산 없음 — 서버 pricing.py 담당
    totalInputTokens: 0,
    totalOutputTokens: 0,
  };

  sessions.set(sessionKey, state);
  return state;
}

/**
 * 세션 조회 (없으면 undefined)
 */
export function getSession(sessionKey: string): SessionState | undefined {
  return sessions.get(sessionKey);
}

/**
 * 세션 조회 또는 새로 생성
 */
export function getOrCreateSession(
  sessionKey: string,
  agentId: string,
  channel = 'unknown'
): SessionState {
  return sessions.get(sessionKey) ?? createSession(sessionKey, agentId, channel);
}

/**
 * 세션 삭제 (session_end에서 호출)
 */
export function deleteSession(sessionKey: string): void {
  const state = sessions.get(sessionKey);
  if (state?.pendingConfirmation) {
    // 대기 중인 확인 요청 강제 취소
    clearTimeout(state.pendingConfirmation.timeoutHandle);
    state.pendingConfirmation.resolve(false);
  }
  sessions.delete(sessionKey);
}

// ─── R(t) 캐시 갱신 ──────────────────────────────────────────────────────────

/**
 * 서버 응답으로 R(t)/Grade/4축 갱신 (TTL 30초 재시작)
 *
 * §7-1 캐시 정책:
 *   - 캐시 없음(초기): R(t) = 0.0, fail-open
 *   - 캐시 있음 + 서버 다운: 마지막 값 무한 유지 (리셋 없음)
 */
export function updateRtCache(
  sessionKey: string,
  rt: number,
  mode: SafetyMode,
  grade: TrustGrade | null,
  pScore: number | null,
  axes: AxesState
): void {
  const state = sessions.get(sessionKey);
  if (!state) return;

  state.currentRt = rt;
  state.currentMode = mode;
  state.grade = grade;
  state.pScore = pScore;
  state.axes = { ...axes };
  state.rtCacheExpiry = new Date(Date.now() + RT_CACHE_TTL_MS);
}

/**
 * R(t) 캐시 유효 여부 — 만료 여부만 체크 (값 유효성은 서버 판단)
 */
export function isRtCacheValid(sessionKey: string): boolean {
  const state = sessions.get(sessionKey);
  if (!state) return false;
  return Date.now() < state.rtCacheExpiry.getTime();
}

/**
 * 현재 로컬 R(t) 조회
 * 캐시 없으면 0.0 반환 (fail-open §7-1)
 * 캐시 있으면 만료 여부 무관하게 마지막 값 반환 (서버 다운 대비)
 */
export function getLocalRt(sessionKey: string): number {
  return sessions.get(sessionKey)?.currentRt ?? 0.0;
}

// ─── 신호 버퍼 ────────────────────────────────────────────────────────────────

/**
 * 신호를 로컬 버퍼에 추가 (배치 전송용)
 * Hook 핸들러는 버퍼에만 적재 → Service Worker가 주기적으로 플러시 (§4-3)
 */
export function bufferSignal(sessionKey: string, signal: SignalPayload): void {
  const state = sessions.get(sessionKey);
  if (!state) return;
  state.signalBuffer.push(signal);
}

/**
 * 버퍼 내용 꺼내고 비우기 (플러시 직전 호출)
 */
export function popBuffer(sessionKey: string): SignalPayload[] {
  const state = sessions.get(sessionKey);
  if (!state) return [];
  const buf = [...state.signalBuffer];
  state.signalBuffer = [];
  state.lastFlushAt = new Date();
  return buf;
}

/**
 * 버퍼 크기 조회
 */
export function getBufferSize(sessionKey: string): number {
  return sessions.get(sessionKey)?.signalBuffer.length ?? 0;
}

// ─── Kill Switch ──────────────────────────────────────────────────────────────

/**
 * 세션 Halt 처리
 * isHalted = true → before_tool_call에서 모든 도구 차단
 */
export function haltSession(sessionKey: string, reason: string): void {
  const state = sessions.get(sessionKey);
  if (!state) return;
  state.isHalted = true;
  state.haltReason = reason;
  state.dangerEvents++;
}

/**
 * Halt 해제 (/pmatrix resume)
 */
export function resumeSession(sessionKey: string): void {
  const state = sessions.get(sessionKey);
  if (!state) return;
  state.isHalted = false;
  state.haltReason = undefined;
}

// ─── baseline 기준선 캡처 ─────────────────────────────────────────────────────

/**
 * before_model_resolve 최초 호출 시 baseline 기준선 저장
 */
export function captureBaseline(
  sessionKey: string,
  provider: string,
  model: string,
  promptHash?: string,
  files?: string[]
): void {
  const state = sessions.get(sessionKey);
  if (!state || state.baselineModel) return;  // 최초 1회만
  state.baselineModel = model;
  state.baselineProvider = provider;
  state.baselinePromptHash = promptHash ?? null;
  state.baselineFiles = files ?? null;
}

// ─── 이벤트 카운터 ────────────────────────────────────────────────────────────

export function incrementDangerEvents(sessionKey: string): void {
  const state = sessions.get(sessionKey);
  if (state) state.dangerEvents++;
}

export function incrementCredentialBlocks(sessionKey: string): void {
  const state = sessions.get(sessionKey);
  if (state) {
    state.credentialBlocks++;
    state.dangerEvents++;
  }
}

export function incrementSafetyGateBlocks(sessionKey: string): void {
  const state = sessions.get(sessionKey);
  if (state) {
    state.safetyGateBlocks++;
    state.dangerEvents++;
  }
}

export function incrementTurnNumber(sessionKey: string): void {
  const state = sessions.get(sessionKey);
  if (state) state.turnNumber++;
}

// ─── LLM latency 추적 ────────────────────────────────────────────────────────

/** FIX #50: pendingLlmRuns TTL — llm_output 미발화 시 장기 누수 방지 (5분) */
const LLM_RUN_TTL_MS = 5 * 60_000;

/** pendingLlmRuns 중 TTL 초과 엔트리 정리 */
function sweepStaleLlmRuns(state: SessionState): void {
  const now = Date.now();
  for (const [runId, startedAt] of state.pendingLlmRuns) {
    if (now - startedAt > LLM_RUN_TTL_MS) {
      state.pendingLlmRuns.delete(runId);
    }
  }
}

/**
 * llm_input Hook에서 runId 등록
 */
export function startLlmRun(sessionKey: string, runId: string): void {
  const state = sessions.get(sessionKey);
  if (!state) return;
  // FIX #50: TTL sweep — 미완료 runId 정리 후 신규 등록 (메모리 누수 방지)
  sweepStaleLlmRuns(state);
  state.pendingLlmRuns.set(runId, Date.now());
}

/**
 * llm_output Hook에서 latency 계산 후 이동 평균 갱신
 * @returns latency ms, 또는 runId 없으면 null
 */
export function completeLlmRun(
  sessionKey: string,
  runId: string
): number | null {
  const state = sessions.get(sessionKey);
  if (!state) return null;

  const startedAt = state.pendingLlmRuns.get(runId);
  if (startedAt == null) return null;

  const latency = Date.now() - startedAt;
  state.pendingLlmRuns.delete(runId);

  // 이동 평균 갱신
  state.movingAvg.llmLatencies = pushMovingAvg(
    state.movingAvg.llmLatencies,
    latency,
    MA_LLM_LATENCY_SIZE
  );

  return latency;
}

// ─── 이동 평균 갱신 ───────────────────────────────────────────────────────────

/**
 * 출력 토큰 수 이동 평균 갱신
 */
export function pushOutputTokens(sessionKey: string, tokens: number): void {
  const state = sessions.get(sessionKey);
  if (!state) return;
  state.movingAvg.outputTokens = pushMovingAvg(
    state.movingAvg.outputTokens,
    tokens,
    MA_OUTPUT_TOKENS_SIZE
  );
}

/**
 * 메시지 길이 이동 평균 갱신
 */
export function pushMessageLength(sessionKey: string, length: number): void {
  const state = sessions.get(sessionKey);
  if (!state) return;
  state.movingAvg.messageLengths = pushMovingAvg(
    state.movingAvg.messageLengths,
    length,
    MA_MESSAGE_LENGTH_SIZE
  );
}

/**
 * 도구별 실행 시간 이동 평균 갱신
 */
export function pushToolDuration(
  sessionKey: string,
  toolName: string,
  durationMs: number
): void {
  const state = sessions.get(sessionKey);
  if (!state) return;
  const existing = state.movingAvg.toolDurations.get(toolName) ?? [];
  state.movingAvg.toolDurations.set(
    toolName,
    pushMovingAvg(existing, durationMs, MA_TOOL_DURATION_SIZE)
  );
}

// ─── 하위 에이전트 추적 ───────────────────────────────────────────────────────

/**
 * 하위 에이전트 생성 타임스탬프 기록
 */
export function recordSubagentSpawn(sessionKey: string): void {
  const state = sessions.get(sessionKey);
  if (!state) return;
  state.subagentTimestamps.push(Date.now());
  // 오래된 타임스탬프 정리 (메모리 절약)
  const cutoff = Date.now() - SUBAGENT_EXPLOSION_WINDOW_MS * 2;
  state.subagentTimestamps = state.subagentTimestamps.filter((t) => t >= cutoff);
}

/**
 * 최근 N ms 내 하위 에이전트 생성 횟수
 */
export function getRecentSubagentCount(
  sessionKey: string,
  windowMs: number = SUBAGENT_EXPLOSION_WINDOW_MS
): number {
  const state = sessions.get(sessionKey);
  if (!state) return 0;
  // FIX #51: 음수 windowMs → 0 고정 (음수면 cutoff가 미래 시각 → 의도치 않은 결과)
  const safeWindowMs = Math.max(0, windowMs);
  const cutoff = Date.now() - safeWindowMs;
  return state.subagentTimestamps.filter((t) => t >= cutoff).length;
}

// ─── 신호 페이로드 빌더 ──────────────────────────────────────────────────────

/**
 * 현재 SessionState에서 SignalPayload 생성
 * axesOverride: meta_control 델타 적용 시 override 전달
 */
export function buildSignalPayload(
  state: SessionState,
  metadata: SignalMetadata,
  axesOverride?: Partial<AxesState>
): SignalPayload {
  const axes = axesOverride ? { ...state.axes, ...axesOverride } : state.axes;
  return {
    agent_id: state.agentId,
    baseline: clamp01(axes.baseline),
    norm: clamp01(axes.norm),
    stability: clamp01(axes.stability),
    meta_control: clamp01(axes.meta_control),
    timestamp: new Date().toISOString(),
    signal_source: 'adapter_stream',
    framework: 'openclaw',
    framework_tag: _frameworkTag,
    schema_version: '0.3',
    metadata: {
      // 호출자가 전달한 event별 특화값을 먼저 전개
      ...metadata,
      // FIX #1: 시스템 신뢰 필드는 반드시 spread 이후에 위치.
      // ...metadata 안에 parent_agent_id 등이 포함되더라도 state 값으로 덮어써
      // 외부 입력에 의한 Sub-Agent 트리 컨텍스트 위조(Spoofing)를 차단.
      channel: state.channel,
      turn_number: state.turnNumber,
      session_id: state.sessionId,
      // ── Tier-2: Sub-Agent 트리 컨텍스트 (항상 포함) ─────────────────────
      parent_agent_id: state.parentAgentId,
      agent_depth: state.agentDepth,
      is_sub_agent: state.agentDepth > 0,
    },
    state_vector: null,
  };
}

// ─── meta_control 델타 적용 ──────────────────────────────────────────────────

/**
 * meta_control 축에 델타 적용 후 로컬 R(t) 재계산
 * Safety Gate 우회 공격 방어: 캐시값을 낙관적으로 업데이트 (서버 응답 전에도 판정 반영)
 *
 * @returns 업데이트된 AxesState, sessionKey 없으면 null
 */
export function applyMetaControlDelta(
  sessionKey: string,
  delta: number
): AxesState | null {
  const state = sessions.get(sessionKey);
  if (!state) return null;

  state.axes.meta_control = clamp01(state.axes.meta_control + delta);

  // 로컬 R(t) 낙관적 재계산
  state.currentRt = computeLocalRt(state.axes);
  state.currentMode = rtToModeLocal(state.currentRt);

  return { ...state.axes };
}

// ─── norm 델타 적용 (GA B-5: 자율성 에스컬레이션) ───────────────────────────

/**
 * norm 축에 델타 적용 후 로컬 R(t) 재계산
 * 자율성 에스컬레이션 감지 시 NORM 감점에 사용
 *
 * @returns 업데이트된 AxesState, sessionKey 없으면 null
 */
export function applyNormDelta(
  sessionKey: string,
  delta: number
): AxesState | null {
  const state = sessions.get(sessionKey);
  if (!state) return null;

  state.axes.norm = clamp01(state.axes.norm + delta);

  // 로컬 R(t) 낙관적 재계산
  state.currentRt = computeLocalRt(state.axes);
  state.currentMode = rtToModeLocal(state.currentRt);

  return { ...state.axes };
}

// ─── 자율성 에스컬레이션 카운터 리셋 (GA B-5) ───────────────────────────────

/**
 * 턴 시작 시 자율성 추적 카운터 초기화
 * before_agent_start에서 호출
 */
export function resetTurnAutonomy(sessionKey: string): void {
  const state = sessions.get(sessionKey);
  if (!state) return;
  state.consecutiveToolCalls = 0;
  state.turnToolCalls = 0;
  state.turnHighRiskCalls = 0;
  // B-7: 턴 시작 시 체인 윈도우 + 감지 이력 초기화
  state.recentToolChain = [];
  state.detectedChainPatterns = new Set();
}

// ─── stability 델타 적용 (GA B-6: Plugin-side Drift) ─────────────────────────

/**
 * stability 축에 델타 적용 후 로컬 R(t) 재계산
 * 턴 간 행동 편차 감지 시 STABILITY(DRIFT) 축 조정에 사용
 *
 * 주의: stability는 "높을수록 위험" (다른 축과 반대)
 * @returns 업데이트된 AxesState, sessionKey 없으면 null
 */
export function applyStabilityDelta(
  sessionKey: string,
  delta: number
): AxesState | null {
  const state = sessions.get(sessionKey);
  if (!state) return null;

  state.axes.stability = clamp01(state.axes.stability + delta);

  // 로컬 R(t) 낙관적 재계산
  state.currentRt = computeLocalRt(state.axes);
  state.currentMode = rtToModeLocal(state.currentRt);

  return { ...state.axes };
}

// ─── 턴 스냅샷 캡처 + Drift 계산 (GA B-6) ──────────────────────────────────

/**
 * 현재 턴의 행동 메트릭을 스냅샷으로 캡처
 * agent_end에서 호출하여 다음 턴 비교 기준으로 저장
 */
export function captureTurnSnapshot(
  sessionKey: string,
  durationMs: number
): TurnSnapshot | null {
  const state = sessions.get(sessionKey);
  if (!state) return null;

  const outputTokens = state.movingAvg.outputTokens;
  const avgOutputTokens = outputTokens.length > 0
    ? outputTokens.reduce((a, b) => a + b, 0) / outputTokens.length
    : 0;

  const snapshot: TurnSnapshot = {
    toolCalls: state.turnToolCalls,
    highRiskCalls: state.turnHighRiskCalls,
    durationMs,
    avgOutputTokens,
  };

  // 현재 스냅샷을 prevTurnSnapshot으로 저장 (다음 턴 비교용)
  const prev = state.prevTurnSnapshot;
  state.prevTurnSnapshot = snapshot;

  return prev; // 이전 스냅샷 반환 (비교 대상)
}

/**
 * 현재 턴 vs 이전 턴 행동 편차(drift score) 계산
 *
 * 각 메트릭별 상대 편차를 가중 평균:
 *   deviation = |current - prev| / max(prev, 1)
 *   drift_score = avg(deviations)
 *
 * @returns drift_score [0, +∞) — 0 = 동일, 1.0 = 100% 편차
 */
export function computeTurnDrift(
  current: TurnSnapshot,
  prev: TurnSnapshot
): number {
  const deviations: number[] = [];

  // 도구 호출 수 편차
  deviations.push(
    Math.abs(current.toolCalls - prev.toolCalls) / Math.max(prev.toolCalls, 1)
  );

  // HIGH 위험 도구 비율 편차 (비율 기반)
  const currHighRatio = current.toolCalls > 0
    ? current.highRiskCalls / current.toolCalls
    : 0;
  const prevHighRatio = prev.toolCalls > 0
    ? prev.highRiskCalls / prev.toolCalls
    : 0;
  deviations.push(Math.abs(currHighRatio - prevHighRatio));

  // 소요 시간 편차
  deviations.push(
    Math.abs(current.durationMs - prev.durationMs) / Math.max(prev.durationMs, 1)
  );

  // 평균 출력 토큰 편차
  deviations.push(
    Math.abs(current.avgOutputTokens - prev.avgOutputTokens) /
      Math.max(prev.avgOutputTokens, 1)
  );

  return deviations.reduce((a, b) => a + b, 0) / deviations.length;
}

// ─── 도구 체인 위험도 감지 (GA B-7) ─────────────────────────────────────────

/** 체인 윈도우 크기 */
const CHAIN_WINDOW_SIZE = 5;

/** NORM 감점 폭 (체인 패턴 매칭 시) */
export const CHAIN_RISK_NORM_DELTA = -0.05;

/**
 * 위험 도구 체인 패턴 정의
 *
 * 각 패턴은 도구 카테고리 시퀀스로 정의:
 *   - 'READ'  : 파일/데이터 읽기 도구 (read, grep, glob, cat, find, search, list_files, head, tail, ls)
 *   - 'WRITE' : 파일 수정 도구 (edit, write, apply_patch)
 *   - 'EXEC'  : 명령 실행 도구 (bash, exec, shell, run, terminal, code_interpreter)
 *
 * 개별로는 LOW/MEDIUM이지만, 체인으로 연쇄되면 위험도 상승
 */
export interface ChainPattern {
  /** 패턴 이름 (중복 감지 방지 키) */
  name: string;
  /** 카테고리 시퀀스 */
  sequence: string[];
  /** 위험도 설명 */
  description: string;
}

export const DANGEROUS_CHAIN_PATTERNS: ChainPattern[] = [
  {
    name: 'read_write_exec',
    sequence: ['READ', 'WRITE', 'EXEC'],
    description: 'File read → modify → execute chain',
  },
  {
    name: 'read_exec',
    sequence: ['READ', 'EXEC'],
    description: 'File read → execute chain',
  },
  {
    name: 'write_exec',
    sequence: ['WRITE', 'EXEC'],
    description: 'File modify → execute chain',
  },
];

/**
 * 도구 이름을 체인 카테고리로 분류
 */
export function classifyToolCategory(toolName: string): string {
  const lower = toolName.toLowerCase();

  // READ: 읽기 전용 도구
  const readPrefixes = ['read', 'grep', 'glob', 'cat', 'find', 'search', 'list_files', 'head', 'tail', 'ls', 'file_read'];
  if (readPrefixes.some((p) => lower.startsWith(p))) return 'READ';

  // WRITE: 파일 수정 도구
  const writeTools = ['edit', 'write', 'apply_patch'];
  if (writeTools.some((w) => lower.startsWith(w))) return 'WRITE';

  // EXEC: 실행 도구
  const execTools = ['bash', 'exec', 'shell', 'run', 'terminal', 'code_interpreter'];
  if (execTools.some((e) => lower === e || lower.startsWith(e))) return 'EXEC';

  return 'OTHER';
}

/**
 * 도구 호출을 체인 윈도우에 추가하고, 위험 패턴 매칭 수행
 *
 * @returns 매칭된 패턴 (없으면 null) — 턴당 패턴별 1회만 반환
 */
export function pushToolChain(
  sessionKey: string,
  toolName: string
): ChainPattern | null {
  const state = sessions.get(sessionKey);
  if (!state) return null;

  const category = classifyToolCategory(toolName);

  // OTHER 카테고리는 체인 추적에서 제외 (윈도우 오염 방지)
  if (category === 'OTHER') return null;

  // 윈도우에 추가
  state.recentToolChain.push(category);
  if (state.recentToolChain.length > CHAIN_WINDOW_SIZE) {
    state.recentToolChain = state.recentToolChain.slice(-CHAIN_WINDOW_SIZE);
  }

  // 패턴 매칭: 윈도우 내 서브시퀀스 검색
  for (const pattern of DANGEROUS_CHAIN_PATTERNS) {
    // 이미 이 턴에서 감지된 패턴이면 스킵 (중복 감점 방지)
    if (state.detectedChainPatterns.has(pattern.name)) continue;

    if (matchSubsequence(state.recentToolChain, pattern.sequence)) {
      state.detectedChainPatterns.add(pattern.name);
      return pattern;
    }
  }

  return null;
}

/**
 * 윈도우 배열에서 패턴 서브시퀀스 매칭
 * 연속일 필요는 없지만, 순서는 유지해야 함
 */
function matchSubsequence(window: string[], pattern: string[]): boolean {
  let pi = 0;
  for (let wi = 0; wi < window.length && pi < pattern.length; wi++) {
    if (window[wi] === pattern[pi]) {
      pi++;
    }
  }
  return pi === pattern.length;
}

/**
 * 로컬 R(t) 계산 (Kernel 공식 근사)
 * R(t) = 1.0 - (baseline + norm + (1-stability) + meta_control) / 4.0
 */
export function computeLocalRt(axes: AxesState): number {
  const rt =
    1.0 -
    (axes.baseline + axes.norm + (1.0 - axes.stability) + axes.meta_control) /
      4.0;
  return clamp01(rt);
}

// ─── 유틸 ─────────────────────────────────────────────────────────────────────

/**
 * 이동 평균 배열 유지 헬퍼 — 최신 N개만 보관
 */
export function pushMovingAvg<T>(arr: T[], value: T, maxLen: number): T[] {
  // FIX #53: maxLen <= 0 → 1로 고정 (0이면 전체 드롭, 음수도 방어)
  const safeMaxLen = Math.max(1, maxLen);
  const next = [...arr, value];
  return next.length > safeMaxLen ? next.slice(next.length - safeMaxLen) : next;
}

/**
 * 배열의 평균값
 */
export function average(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/**
 * 전체 세션 수 (디버그용)
 */
export function getSessionCount(): number {
  return sessions.size;
}

// ─── 내부 헬퍼 ────────────────────────────────────────────────────────────────

/** [0, 1] 클램프 */
function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/**
 * R(t) → SafetyMode (safety-gate.ts와 동일 로직, 순환 임포트 방지를 위해 인라인)
 */
function rtToModeLocal(rt: number): SafetyMode {
  if (rt < 0.15) return 'A+1';
  if (rt < 0.30) return 'A+0';
  if (rt < 0.50) return 'A-1';
  if (rt < 0.75) return 'A-2';
  return 'A-0';
}
