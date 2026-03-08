// =============================================================================
// @pmatrix/openclaw-monitor — types.ts
// 전체 타입 정의: OpenClaw Plugin API 인터페이스, SessionState, Config, API 응답
// =============================================================================

// ─── OpenClaw Plugin API 인터페이스 (v2026.3 SDK 기준) ──────────────────────

/**
 * OpenClaw Plugin API — register(api) 파라미터 타입
 * 출처: openclaw/dist/plugin-sdk/plugins/types.d.ts (2026.3.2)
 */
export interface OpenClawPluginAPI {
  /** 플러그인 ID (OpenClaw 할당) */
  id: string;
  /** 플러그인 이름 */
  name: string;
  /** 플러그인 소스 경로 */
  source: string;
  /** OpenClaw 전역 설정 */
  config: Record<string, unknown>;
  /** 플러그인별 설정 (configSchema로 파싱) */
  pluginConfig?: Record<string, unknown>;
  /** 런타임 환경 */
  runtime: unknown;

  /** 플러그인 로거 */
  logger: {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
    debug(msg: string): void;
  };

  /** 훅 핸들러 등록 (untyped) */
  registerHook(
    events: string | string[],
    handler: HookHandler,
    opts?: { entry?: unknown; name?: string; description?: string; register?: boolean },
  ): void;

  /** 타입 안전 훅 등록 (on) — typedHooks 디스패치 경로 */
  on(hookName: string, handler: HookHandler, opts?: { priority?: number }): void;

  /** 채팅 커맨드 등록 */
  registerCommand(command: PluginCommandDefinition): void;

  /** Gateway RPC 메서드 등록 */
  registerGatewayMethod(method: string, handler: GatewayMethodHandler): void;

  /** 백그라운드 서비스 등록 */
  registerService(service: PluginServiceDefinition): void;

  /** 에이전트 도구 등록 */
  registerTool?(tool: unknown, opts?: unknown): void;

  /** HTTP 라우트 등록 */
  registerHttpRoute?(params: unknown): void;

  /** 경로 해석 유틸 */
  resolvePath?(input: string): string;
}

export type HookHandler = (
  event: Record<string, unknown>,
  ctx: HookContext
) => Promise<HookResult | void> | HookResult | void;

export type GatewayMethodHandler = (
  params: Record<string, unknown>
) => Promise<unknown>;

/** /pmatrix 같은 채팅 커맨드 정의 */
export interface PluginCommandDefinition {
  /** 커맨드 이름 (슬래시 제외, 예: "pmatrix") */
  name: string;
  /** /help에 표시되는 설명 */
  description: string;
  /** 인자 수용 여부 */
  acceptsArgs?: boolean;
  /** 인증 필요 여부 (기본 true) */
  requireAuth?: boolean;
  /** 핸들러 함수 */
  handler: PluginCommandHandler;
}

/** 커맨드 핸들러 컨텍스트 (OpenClaw 전달) */
export interface PluginCommandContext {
  senderId?: string;
  channel: string;
  channelId?: string;
  isAuthorizedSender: boolean;
  /** 커맨드 이름 뒤의 인자 문자열 */
  args?: string;
  commandBody: string;
  config: Record<string, unknown>;
  from?: string;
  to?: string;
  accountId?: string;
}

/** 커맨드 핸들러 — { text } 반환 */
export type PluginCommandHandler = (
  ctx: PluginCommandContext,
) => PluginCommandResult | Promise<PluginCommandResult>;

/** 커맨드 응답 (ReplyPayload 호환) */
export interface PluginCommandResult {
  text: string;
}

/** 백그라운드 서비스 정의 */
export interface PluginServiceDefinition {
  id: string;
  start: (ctx: PluginServiceContext) => void | Promise<void>;
  stop?: (ctx: PluginServiceContext) => void | Promise<void>;
}

export interface PluginServiceContext {
  config: Record<string, unknown>;
  workspaceDir?: string;
  stateDir: string;
  logger: OpenClawPluginAPI['logger'];
}

export interface HookContext {
  /** 세션 격리 키 — 동일 Gateway 내 멀티 에이전트 구분 */
  sessionKey?: string;
  /** 에이전트 ID */
  agentId?: string;
  /** 세션 ID (ephemeral) */
  sessionId?: string;
  /** 채널 ID */
  channelId?: string;
  /** run ID */
  runId?: string;
  /** 도구 이름 (before_tool_call / after_tool_call) */
  toolName?: string;
}

/**
 * 훅 핸들러 반환값 — 빈 객체({}) 또는 undefined = 허용
 *
 * 주의: OpenClaw는 catchErrors: true 하드코딩 → throw는 무시됨.
 * 차단이 필요한 경우 반드시 { block: true } 명시적 반환 필요. (§14-2)
 */
export interface HookResult {
  /** true = 도구 호출 차단 (before_tool_call에서만 유효) */
  block?: true;
  /** 차단 사유 — 채팅창에 표시 */
  blockReason?: string;
  /** true = 메시지 발신 취소 (message_sending에서만 유효) */
  cancel?: true;
  /** 모델 강제 전환 (before_model_resolve에서만 유효) */
  modelOverride?: string;
  /** 'error' = 하위 에이전트 생성 차단 (subagent_spawning에서만 유효) */
  status?: 'error';
}

// ─── 5-Mode 및 Grade ──────────────────────────────────────────────────────────

/** P-MATRIX 5-Mode (Server constants.py 경계값 기준) */
export type SafetyMode = 'A+1' | 'A+0' | 'A-1' | 'A-2' | 'A-0';

/** Trust Grade */
export type TrustGrade = 'A' | 'B' | 'C' | 'D' | 'E';

/** Tool 위험 등급 */
export type ToolRiskTier = 'HIGH' | 'MEDIUM' | 'LOW';

/** Safety Gate 판정 결과 */
export type GateAction = 'ALLOW' | 'BLOCK' | 'CONFIRM';

// ─── 4축 상태 ─────────────────────────────────────────────────────────────────

export interface AxesState {
  /** BASELINE: 초기 설정 무결성 — 높을수록 안전 */
  baseline: number;
  /** NORM: 행동 정상 범위 — 높을수록 안전 */
  norm: number;
  /** STABILITY: 장기 변화 — 높을수록 위험 */
  stability: number;
  /** META_CONTROL: 자기 통제력 — 높을수록 안전 */
  meta_control: number;
}

// ─── SessionState ─────────────────────────────────────────────────────────────

export interface MovingAverage {
  /** 메시지 길이 최근 10개 */
  messageLengths: number[];
  /** 출력 토큰 수 최근 10개 */
  outputTokens: number[];
  /** 도구별 실행 시간 최근 5개 */
  toolDurations: Map<string, number[]>;
  /** LLM 응답 지연 최근 10개 */
  llmLatencies: number[];
}

/** 턴별 행동 스냅샷 — 턴 간 Drift 비교용 (GA B-6) */
export interface TurnSnapshot {
  /** 턴 내 도구 호출 수 */
  toolCalls: number;
  /** 턴 내 HIGH 위험 도구 호출 수 */
  highRiskCalls: number;
  /** 턴 소요 시간 (ms) */
  durationMs: number;
  /** 평균 출력 토큰 수 (이동 평균 스냅샷) */
  avgOutputTokens: number;
}

export interface PendingConfirmation {
  sessionKey: string;
  toolName: string;
  reason: string;
  resolve: (confirmed: boolean) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

/**
 * pendingChildLinks 전역 Map 값 타입
 * subagent_spawning → session_start 교차 세션 브릿지 (§A-1)
 */
export interface PendingLink {
  /** 부모 에이전트 ID (SessionState.agentId) */
  parentAgentId: string;
  /** 자식 depth = 부모 depth + 1 */
  depth: number;
  /** 생성 시각 (ms) — TTL sweep 기준 */
  createdAt: number;
}

/**
 * 세션 격리 상태 — Map<sessionKey, SessionState>로 관리
 * 동일 Gateway에서 멀티 에이전트 동시 실행 시 상태 혼합 방지 (§14-3)
 */
export interface SessionState {
  sessionId: string;
  agentId: string;
  channel: string;
  startedAt: Date;
  turnNumber: number;

  // ── 턴 경계 추적 (B-4) ─────────────────────────────────────────────────────
  /** before_agent_start 기록 시각 (ms) — agent_end에서 durationMs 계산용 */
  turnStartedAt: number | null;

  // ── Kill Switch ────────────────────────────────────────────────────────────
  isHalted: boolean;
  haltReason?: string;

  // ── 서버 최신 R(t)/Grade (로컬 캐시) ──────────────────────────────────────
  /** 현재 위험도 R(t) — Safety Gate 판정에 사용 */
  currentRt: number;
  currentMode: SafetyMode;
  axes: AxesState;
  grade: TrustGrade | null;
  pScore: number | null;

  // ── 신호 배치 버퍼 ────────────────────────────────────────────────────────
  signalBuffer: SignalPayload[];
  lastFlushAt: Date;

  // ── baseline 기준선 (before_model_resolve 최초 캡처) ────────────────────
  baselineModel: string | null;
  baselineProvider: string | null;
  baselinePromptHash: string | null;
  baselineFiles: string[] | null;

  // ── 로컬 이동 평균 (NORM 계산용) ─────────────────────────────────────────
  movingAvg: MovingAverage;

  // ── 이벤트 카운터 ─────────────────────────────────────────────────────────
  dangerEvents: number;
  credentialBlocks: number;
  safetyGateBlocks: number;

  // ── 캐시 TTL ──────────────────────────────────────────────────────────────
  /**
   * R(t) 캐시 만료 시각 (30초 TTL)
   * §7-1: 캐시 있음 + 서버 다운 → 마지막 값 무한 유지 (리셋 없음)
   */
  rtCacheExpiry: Date;

  // ── LLM runId 추적 (latency 계산) ────────────────────────────────────────
  /** runId → 시작 timestamp (ms) */
  pendingLlmRuns: Map<string, number>;

  // ── 하위 에이전트 생성 추적 ───────────────────────────────────────────────
  subagentTimestamps: number[];

  // ── 사용자 확인 대기 ──────────────────────────────────────────────────────
  pendingConfirmation: PendingConfirmation | null;

  // ── Sub-Agent 트리 (Tier-2, §A-1) ────────────────────────────────────────
  /** 에이전트 트리 깊이 (root = 0, 1차 하위 = 1, ...) */
  agentDepth: number;
  /** 부모 에이전트 ID (root agent = null) */
  parentAgentId: string | null;

  // ── 턴 간 Drift 추적 (GA B-6) ──────────────────────────────────────────────
  /** 이전 턴 행동 스냅샷 — 현재 턴과 비교하여 편차 감지 */
  prevTurnSnapshot: TurnSnapshot | null;

  // ── 자율성 에스컬레이션 추적 (GA B-5) ───────────────────────────────────────
  /** 현재 턴 내 연속 도구 호출 수 (ALLOW된 호출만 카운트) */
  consecutiveToolCalls: number;
  /** 현재 턴 내 전체 도구 호출 수 */
  turnToolCalls: number;
  /** 현재 턴 내 HIGH 위험 도구 호출 수 */
  turnHighRiskCalls: number;

  // ── 도구 체인 위험도 추적 (GA B-7) ──────────────────────────────────────────
  /** 최근 도구 호출 시퀀스 (윈도우=5) — 체인 패턴 매칭용 */
  recentToolChain: string[];
  /** 현재 턴에서 이미 감지된 체인 패턴 (중복 감점 방지) */
  detectedChainPatterns: Set<string>;

  // ── 토큰 누적 (Cost Tracker, Tier-2 §A-2) ────────────────────────────────
  /** 세션 누적 입력 토큰 수 (cost-tracker.ts 갱신, 서버 pricing.py가 cost 계산) */
  totalInputTokens: number;
  /** 세션 누적 출력 토큰 수 (cost-tracker.ts 갱신) */
  totalOutputTokens: number;
}

// ─── 신호 페이로드 ────────────────────────────────────────────────────────────

/**
 * POST /v1/inspect/stream 페이로드
 * DB 저장값 계약 (§6-5): signal_source="adapter_stream", framework="openclaw"
 */
export interface SignalPayload {
  agent_id: string;
  baseline: number;
  norm: number;
  stability: number;
  meta_control: number;
  timestamp: string;
  signal_source: 'adapter_stream';
  framework: 'openclaw';
  framework_tag: 'beta' | 'stable';
  /** ★ Tier-2 신규: 스키마 버전 고정 (Tier-0/1 미포함 이벤트 → 서버 "0.2" fallback) */
  schema_version: '0.3';
  metadata: SignalMetadata;
  state_vector: null;
}

export interface SignalMetadata {
  channel?: string;
  turn_number?: number;
  is_autonomous?: boolean;
  tools_used?: string[];
  llm_model?: string;
  llm_tokens_total?: number;
  subagents_active?: number;
  session_id?: string;

  /** 이벤트 유형 (credential_detected, gate_override, session_summary 등) */
  event_type?: string;

  /** 크레덴셜 감지 패턴명 목록 */
  patterns?: string[];

  /** 긴급 전송 플래그 */
  priority?: 'critical' | 'normal';

  /** gate_override 이벤트 전용 (§12-4 A-5) */
  tool_name?: string;
  rt_at_override?: number;
  mode_at_override?: string;

  /** meta_control 감점값 (음수) */
  meta_control_delta?: number;

  /** baseline 감점값 (음수) */
  baseline_delta?: number;

  /** 세션 요약 전용 */
  total_turns?: number;
  danger_events?: number;
  credential_blocks?: number;
  safety_gate_blocks?: number;
  end_reason?: string;

  // ── Tier-2 Sub-Agent 트리 (§A-1) ──────────────────────────────────────────
  /** 부모 에이전트 ID (root agent = null). pendingChildLinks 경유 설정 — event 직접 추출 금지 */
  parent_agent_id?: string | null;
  /** 에이전트 트리 깊이 (root = 0) */
  agent_depth?: number;
  /** 하위 에이전트 여부 */
  is_sub_agent?: boolean;

  // ── Tier-2 Cost (§A-2) ────────────────────────────────────────────────────
  /**
   * LLM 입력 토큰 수 — 서버 pricing.py가 cost_usd 계산에 사용
   * hooks/llm.ts에서 항상 세팅 (없으면 서버 Cost D축 기여분 = 0)
   */
  input_tokens?: number;
  /**
   * LLM 출력 토큰 수
   * hooks/llm.ts에서 항상 세팅
   */
  output_tokens?: number;
  /**
   * 프롬프트 문자 수 (또는 토큰 기반 추정치)
   * hooks/llm.ts에서 항상 세팅 — 없으면 서버 Drift prompt_score = 0.0
   */
  prompt_len?: number;

  [key: string]: unknown;
}

// ─── API 응답 타입 ────────────────────────────────────────────────────────────

/**
 * GET /v1/agents/{agent_id}/public 응답
 * Cache TTL: 30초 (§6-3)
 */
export interface GradeResponse {
  agent_id: string;
  grade: TrustGrade;
  p_score: number;
  /** R(t) 위험도 */
  risk: number;
  mode: SafetyMode;
  axes: {
    baseline: number;
    norm: number;
    stability: number;
    meta_control: number;
  };
  last_updated: string;
}

/**
 * POST /v1/inspect/stream 응답
 * 서버가 배치 수신 후 최신 Grade를 함께 반환 → R(t) 캐시 갱신에 사용
 */
export interface BatchSendResponse {
  received: number;
  risk?: number;
  grade?: TrustGrade;
  mode?: SafetyMode;
  axes?: {
    baseline: number;
    norm: number;
    stability: number;
    meta_control: number;
  };
}

// ─── Config 스키마 (openclaw.json §10) ───────────────────────────────────────

export interface SafetyGateConfig {
  enabled: boolean;
  /**
   * 사용자 확인 대기 시간 (ms)
   * 유효 범위: 10,000~30,000ms — 위반 시 validateConfig()에서 throw (§14-6)
   * fail-closed: 타임아웃 시 자동 차단
   */
  confirmTimeoutMs: number;
  /**
   * 서버 R(t) 조회 타임아웃 (ms)
   * fail-open: 2,500ms 초과 → 허용 (에이전트 전체 무한 대기 방지 §14-1)
   */
  serverTimeoutMs: number;
  /** 커스텀 도구 위험 등급 재정의 */
  customToolRisk?: Record<string, ToolRiskTier>;
}

export interface CredentialProtectionConfig {
  enabled: boolean;
  /** transcript 기록도 차단 (before_message_write Hook) */
  blockTranscript: boolean;
  /** 추가 커스텀 정규식 패턴 */
  customPatterns: string[];
}

export interface KillSwitchConfig {
  /** R(t) ≥ 이 값이면 자동 Halt (기본 0.75) */
  autoHaltOnRt: number;
  /** Halt 시 강제 전환 모델 (기본 claude-opus-4-6) */
  safeModel: string;
}

export interface OutboundAllowlistConfig {
  /** allowlist 활성화 여부 (기본 false — 비활성 시 전체 허용) */
  enabled: boolean;
  /**
   * 허용된 아웃바운드 채널/수신자 목록.
   * 빈 배열 = 전체 허용.
   * 형식 예시: "whatsapp:+1234567890", "telegram:@mybot", "discord:#general"
   */
  allowedChannels: string[];
}

export interface BatchConfig {
  /** 버퍼 크기 임계값 — 이상이면 플러시 (기본 10) */
  maxSize: number;
  /** 자동 플러시 주기 (ms, 기본 2000) */
  flushIntervalMs: number;
  /** 최대 재시도 횟수 (기본 3) */
  retryMax: number;
}

export interface PMatrixConfig {
  serverUrl: string;
  agentId: string;
  /** 환경변수 참조 "${PMATRIX_API_KEY}" 또는 직접값 — 하드코딩 금지 (§14-7) */
  apiKey: string;
  safetyGate: SafetyGateConfig;
  credentialProtection: CredentialProtectionConfig;
  killSwitch: KillSwitchConfig;
  outboundAllowlist: OutboundAllowlistConfig;
  /** 프라이버시 동의 여부 — false이면 서버 전송 안 함 (§11) */
  dataSharing: boolean;
  /** 동의 일시 (ISO 8601) */
  agreedAt?: string;
  batch: BatchConfig;
  /** 프레임워크 태그 — 서버 signal의 framework_tag 필드 (기본 'beta') */
  frameworkTag?: 'beta' | 'stable';
  debug: boolean;
}
