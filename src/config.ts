// =============================================================================
// @pmatrix/openclaw-monitor — config.ts
// ~/.pmatrix/config.json + 환경변수 → PMatrixConfig 로더
// =============================================================================

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  PMatrixConfig,
  SafetyGateConfig,
  CredentialProtectionConfig,
  KillSwitchConfig,
  OutboundAllowlistConfig,
  BatchConfig,
} from './types';

// ─── 유효성 검증 상수 (§14-6) ────────────────────────────────────────────────

const CONFIRM_TIMEOUT_MIN = 10_000;
const CONFIRM_TIMEOUT_MAX = 30_000;

// ─── 기본값 ───────────────────────────────────────────────────────────────────

const DEFAULT_SAFETY_GATE: SafetyGateConfig = {
  enabled: true,
  confirmTimeoutMs: 20_000,  // 20초 — fail-closed
  serverTimeoutMs: 2_500,    // 2.5초 — fail-open
  customToolRisk: {},
};

const DEFAULT_CREDENTIAL_PROTECTION: CredentialProtectionConfig = {
  enabled: true,
  blockTranscript: true,
  customPatterns: [],
};

const DEFAULT_KILL_SWITCH: KillSwitchConfig = {
  autoHaltOnRt: 0.75,
  safeModel: 'claude-opus-4-6',
};

const DEFAULT_OUTBOUND_ALLOWLIST: OutboundAllowlistConfig = {
  enabled: false,     // 기본 비활성 — 전체 허용
  allowedChannels: [],
};

const DEFAULT_BATCH: BatchConfig = {
  maxSize: 10,
  flushIntervalMs: 2_000,
  retryMax: 3,
};

const DEFAULT_CONFIG: PMatrixConfig = {
  serverUrl: 'https://api.pmatrix.io',
  agentId: '',
  apiKey: '',
  safetyGate: DEFAULT_SAFETY_GATE,
  credentialProtection: DEFAULT_CREDENTIAL_PROTECTION,
  killSwitch: DEFAULT_KILL_SWITCH,
  outboundAllowlist: DEFAULT_OUTBOUND_ALLOWLIST,
  dataSharing: false,  // opt-in — 동의 전까지 서버 전송 안 함 (§11)
  batch: DEFAULT_BATCH,
  frameworkTag: 'beta',
  debug: false,
};

// ─── ~/.pmatrix/config.json 파일 타입 ─────────────────────────────────────────

interface PMatrixFileConfig {
  serverUrl?: string;
  agentId?: string;
  apiKey?: string;
  safetyGate?: Partial<SafetyGateConfig>;
  credentialProtection?: Partial<CredentialProtectionConfig>;
  killSwitch?: Partial<KillSwitchConfig>;
  outboundAllowlist?: Partial<OutboundAllowlistConfig>;
  dataSharing?: boolean;
  agreedAt?: string;
  batch?: Partial<BatchConfig>;
  frameworkTag?: 'beta' | 'stable';
  debug?: boolean;
}

// ─── 공개 API ────────────────────────────────────────────────────────────────

/**
 * P-MATRIX 설정 로드
 *
 * 우선순위: 환경변수 > ~/.pmatrix/config.json > 기본값
 *
 * 파일 탐색 순서:
 *   1. configPath (명시적 지정)
 *   2. ~/.pmatrix/config.json (글로벌 — setup CLI가 작성)
 *
 * 환경변수:
 *   PMATRIX_API_KEY      — API 키 (하드코딩 금지 §14-7)
 *   PMATRIX_SERVER_URL   — 서버 URL 오버라이드
 *   PMATRIX_AGENT_ID     — 에이전트 ID 오버라이드
 *   PMATRIX_DEBUG=1      — 디버그 로그 활성화
 *
 * @param configPath config.json 경로 (지정 시 해당 경로만 사용)
 */
export function loadConfig(configPath?: string): PMatrixConfig {
  const pm = configPath
    ? readJsonFile(configPath)
    : readPMatrixConfig();

  const config: PMatrixConfig = {
    serverUrl:
      process.env['PMATRIX_SERVER_URL'] ??
      pm.serverUrl ??
      DEFAULT_CONFIG.serverUrl,

    agentId:
      process.env['PMATRIX_AGENT_ID'] ??
      pm.agentId ??
      DEFAULT_CONFIG.agentId,

    apiKey:
      process.env['PMATRIX_API_KEY'] ??
      resolveEnvRef(pm.apiKey) ??
      DEFAULT_CONFIG.apiKey,

    debug:
      process.env['PMATRIX_DEBUG'] === '1' ||
      (pm.debug ?? DEFAULT_CONFIG.debug),

    dataSharing: pm.dataSharing ?? DEFAULT_CONFIG.dataSharing,
    agreedAt: pm.agreedAt,
    frameworkTag: pm.frameworkTag ?? DEFAULT_CONFIG.frameworkTag,

    safetyGate: {
      ...DEFAULT_SAFETY_GATE,
      ...pm.safetyGate,
    },

    credentialProtection: {
      ...DEFAULT_CREDENTIAL_PROTECTION,
      ...pm.credentialProtection,
    },

    killSwitch: {
      ...DEFAULT_KILL_SWITCH,
      ...pm.killSwitch,
    },

    outboundAllowlist: {
      ...DEFAULT_OUTBOUND_ALLOWLIST,
      ...pm.outboundAllowlist,
    },

    batch: {
      ...DEFAULT_BATCH,
      ...pm.batch,
    },
  };

  validateConfig(config);
  return config;
}

/**
 * 설정 유효성 검증 — confirmTimeoutMs 범위 강제 (§14-6)
 * @throws Error confirmTimeoutMs가 허용 범위 밖일 때
 * @throws Error allowedChannels에 빈 문자열이 포함된 경우 (BUG-4)
 */
export function validateConfig(config: PMatrixConfig): void {
  const t = config.safetyGate.confirmTimeoutMs;
  if (t < CONFIRM_TIMEOUT_MIN || t > CONFIRM_TIMEOUT_MAX) {
    throw new Error(
      `[P-MATRIX] confirmTimeoutMs는 ${CONFIRM_TIMEOUT_MIN}~${CONFIRM_TIMEOUT_MAX}ms ` +
        `범위여야 합니다. 입력값: ${t}`
    );
  }

  // BUG-4: 빈 문자열 allowedChannel → startsWith("") = 항상 true → Allowlist 무력화
  if (config.outboundAllowlist.enabled) {
    const hasEmpty = config.outboundAllowlist.allowedChannels.some(
      (c) => c.trim() === ''
    );
    if (hasEmpty) {
      throw new Error(
        '[P-MATRIX] outboundAllowlist.allowedChannels에 빈 문자열을 포함할 수 없습니다. ' +
          '빈 배열([])은 전체 허용, 항목은 반드시 비어있지 않은 문자열이어야 합니다.'
      );
    }
  }
}

// ─── 내부 헬퍼 ───────────────────────────────────────────────────────────────

/**
 * ~/.pmatrix/config.json 읽기 (setup CLI가 작성한 파일)
 */
function readPMatrixConfig(): PMatrixFileConfig {
  const configPath = path.join(os.homedir(), '.pmatrix', 'config.json');
  return readJsonFile(configPath);
}

/**
 * JSON 파일 읽기 — 파일 없음/파싱 실패 시 빈 객체 반환
 */
function readJsonFile(filePath: string): PMatrixFileConfig {
  try {
    if (!fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as PMatrixFileConfig;
  } catch {
    // 파싱 실패 → 기본값 사용. 플러그인 동작은 계속.
    return {};
  }
}

/**
 * "${VAR_NAME}" 형태의 환경변수 참조 해석
 * 예: "${PMATRIX_API_KEY}" → process.env.PMATRIX_API_KEY
 */
function resolveEnvRef(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.match(/^\$\{(.+)\}$/);
  if (match && match[1]) {
    return process.env[match[1]];
  }
  return value;
}
