// =============================================================================
// @pmatrix/openclaw-monitor — client.ts
// PMatrixHttpClient: POST /v1/inspect/stream, GET /v1/agents/{id}/public
// retry 3회 (backoff: 100ms → 500ms → 2,000ms), 로컬 백업
// =============================================================================

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  PMatrixConfig,
  SignalPayload,
  GradeResponse,
  BatchSendResponse,
  AxesState,
  SafetyMode,
  TrustGrade,
} from './types';

// ─── 상수 ────────────────────────────────────────────────────────────────────

/** retry backoff 딜레이 (ms) — 1차: 100ms, 2차: 500ms, 3차: 2,000ms */
const RETRY_DELAYS = [100, 500, 2_000] as const;

const REQUEST_TIMEOUT_MS = 10_000;  // 개별 HTTP 요청 타임아웃

// unsent 파일 재전송 상수
const RESUBMIT_INTERVAL_MS = 60_000;        // 60초마다 최대 1회 시도
const MAX_RESUBMIT_FILES   = 5;             // 1회 처리 파일 수 상한
const MAX_UNSENT_AGE_MS    = 7 * 24 * 60 * 60 * 1_000;  // 7일 경과 → stale 삭제

// ─── 응답 인터페이스 ──────────────────────────────────────────────────────────

export interface HealthCheckResult {
  healthy: boolean;
  grade?: GradeResponse;
}

export interface SessionSummaryInput {
  sessionId: string;
  agentId: string;
  totalTurns: number;
  dangerEvents: number;
  credentialBlocks: number;
  safetyGateBlocks: number;
  endReason?: string;
  signal_source: 'adapter_stream';
  framework: 'openclaw';
  framework_tag: 'beta' | 'stable';
}

// ─── PMatrixHttpClient ────────────────────────────────────────────────────────

export class PMatrixHttpClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly agentId: string;
  private readonly retryMax: number;
  private readonly debug: boolean;
  private lastResubmitAt: number = 0;  // throttle 기준 시각

  constructor(config: PMatrixConfig) {
    this.baseUrl = config.serverUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.agentId = config.agentId;
    this.retryMax = config.batch.retryMax;
    this.debug = config.debug;
  }

  // ─── 공개 메서드 ────────────────────────────────────────────────────────────

  /**
   * 서버 연결 확인 (fail-open)
   * 실패해도 Plugin은 계속 동작 — 로컬 캐시로 Safety Gate 작동 (§5-1)
   * 성공 시 초기 Grade도 함께 반환 → R(t) 캐시 즉시 갱신
   */
  async healthCheck(): Promise<HealthCheckResult> {
    if (!this.agentId) {
      return { healthy: false };
    }
    try {
      const grade = await this.getAgentGrade(this.agentId);
      return { healthy: true, grade };
    } catch {
      return { healthy: false };
    }
  }

  /**
   * 에이전트 Grade 조회
   * GET /v1/agents/{agent_id}/public
   * Cache TTL: 30초 (§6-3)
   */
  async getAgentGrade(agentId: string): Promise<GradeResponse> {
    const url = `${this.baseUrl}/v1/agents/${encodeURIComponent(agentId)}/public`;
    const raw = await this.fetchWithRetry('GET', url, null);
    // TODO(runtime-guard): validate shape at runtime if payload schema drifts
    return raw as GradeResponse;
  }

  /**
   * 신호 배치 전송
   * POST /v1/inspect/stream
   * 응답에 최신 R(t)/Grade 포함 → 호출자가 캐시 갱신에 활용
   */
  async sendBatch(signals: SignalPayload[]): Promise<BatchSendResponse> {
    if (signals.length === 0) return { received: 0 };
    // Defense-in-depth: all-zero axes → R(t)=0.75 → instant HALT.
    // Correct to neutral (0.5) before transmission.
    for (const s of signals) {
      if (s.baseline === 0 && s.norm === 0 && s.stability === 0 && s.meta_control === 0) {
        s.baseline = 0.5;
        s.norm = 0.5;
        s.stability = 0.5;
        s.meta_control = 0.5;
      }
    }
    try {
      return await this.sendBatchDirect(signals);
    } catch (err) {
      await this.backupToLocal(signals);
      throw err;
    }
  }

  /**
   * unsent 파일 재전송
   *
   * 60초 throttle — 서버가 살아났을 때 주기적으로 최대 MAX_RESUBMIT_FILES개 재전송.
   * 7일 초과 stale 파일은 재전송 없이 삭제.
   * backupToLocal과 루프를 피하기 위해 sendBatchDirect(retry 포함, backup 없음) 사용.
   * 전체 silent fail — Plugin 동작 방해 안 함.
   * fs.promises.* 비동기 사용 (이벤트 루프 블로킹 방지)
   */
  async resubmitUnsent(): Promise<void> {
    const now = Date.now();
    if (now - this.lastResubmitAt < RESUBMIT_INTERVAL_MS) return;
    this.lastResubmitAt = now;

    const dir = path.join(os.homedir(), '.pmatrix', 'unsent');
    let files: string[];
    try {
      files = (await fs.promises.readdir(dir))
        .filter(f => f.endsWith('.json'))
        .sort()                                 // timestamp 파일명 → 오래된 것 우선
        .slice(0, MAX_RESUBMIT_FILES);
    } catch {
      return;  // 디렉토리 없음 — unsent 파일 없는 정상 상태
    }

    for (const filename of files) {
      const filepath = path.join(dir, filename);
      try {
        const stat = await fs.promises.stat(filepath);
        if (now - stat.mtimeMs > MAX_UNSENT_AGE_MS) {
          // stale: 재전송 없이 삭제
          await fs.promises.unlink(filepath);
          if (this.debug) {
            console.debug(`[P-MATRIX] Stale unsent file deleted: ${filename}`);
          }
          continue;
        }

        const raw = await fs.promises.readFile(filepath, 'utf-8');
        const signals = JSON.parse(raw) as SignalPayload[];
        await this.sendBatchDirect(signals);    // retry 포함, backup 루프 없음
        await fs.promises.unlink(filepath);

        if (this.debug) {
          console.debug(
            `[P-MATRIX] Resubmitted ${signals.length} signal(s) from ${filename}`
          );
        }
      } catch (err) {
        // JSON 파싱 실패 → 손상된 파일, 재시도해도 의미 없으므로 즉시 삭제
        if (err instanceof SyntaxError) {
          await fs.promises.unlink(filepath).catch(() => {});
          if (this.debug) {
            console.debug(`[P-MATRIX] Corrupted unsent file removed: ${filename}`);
          }
        }
        // 네트워크/전송 실패 → 파일 유지하고 다음 주기에 재시도 (intentional)
      }
    }
  }

  /**
   * 긴급 신호 즉시 전송 (retry 없음, fire-and-forget)
   * 크레덴셜 감지 / Halt 발동 / meta_control 특별 규칙 차단 시 사용
   */
  async sendCritical(signal: SignalPayload): Promise<void> {
    const url = `${this.baseUrl}/v1/inspect/stream`;
    try {
      await this.fetchOnce('POST', url, signal);
      if (this.debug) {
        console.debug(`[P-MATRIX] Critical signal sent: ${signal.metadata['event_type'] ?? 'unknown'}`);
      }
    } catch {
      // 긴급 신호 실패 시 로컬 백업 — Plugin 동작은 계속
      await this.backupToLocal([signal]);
    }
  }

  /**
   * Kill Switch Halt 해제 통지
   * POST /v1/inspect/resume — 서버에 resume 이벤트 기록
   * fire-and-forget: 실패해도 로컬 resume은 이미 적용됨 (§7-1 fail-open)
   */
  async notifyResume(agentId: string): Promise<void> {
    const url = `${this.baseUrl}/v1/inspect/resume`;
    try {
      await this.fetchWithRetry('POST', url, { agent_id: agentId });
      if (this.debug) {
        console.debug(`[P-MATRIX] Resume notified to server: agent=${agentId}`);
      }
    } catch {
      // 서버 불가 시 로컬 resume만 유지 (fail-open §7-1)
      if (this.debug) {
        console.debug('[P-MATRIX] Resume server notification failed (local resume active)');
      }
    }
  }

  /**
   * 버퍼 플러시 — 세션 종료 / 버퍼 임계값 초과 시
   */
  async flush(
    buffer: SignalPayload[],
    opts: { priority?: 'session_end' | 'normal' } = {}
  ): Promise<void> {
    if (buffer.length === 0) return;

    try {
      await this.sendBatch(buffer);
      if (this.debug) {
        console.debug(
          `[P-MATRIX] Flushed ${buffer.length} signals (${opts.priority ?? 'normal'})`
        );
      }
    } catch {
      // sendBatch 내부에서 이미 backupToLocal 처리됨
    }
  }

  /**
   * 세션 종료 요약 전송
   * session_end Hook에서 호출 (§5-7)
   * dataSharing 동의 후에만 호출할 것
   */
  async sendSessionSummary(data: SessionSummaryInput): Promise<void> {
    const url = `${this.baseUrl}/v1/inspect/stream`;
    const payload: SignalPayload = {
      agent_id: data.agentId,
      // Issue D: neutral axes — avoids all-zero → R(t)=0.75 (HALT) grade pollution
      baseline: 0.5,
      norm: 0.5,
      stability: 0.5,
      meta_control: 0.5,
      timestamp: new Date().toISOString(),
      signal_source: 'adapter_stream',
      framework: 'openclaw',
      framework_tag: data.framework_tag,
      schema_version: '0.3',
      metadata: {
        event_type: 'session_summary',
        session_id: data.sessionId,
        total_turns: data.totalTurns,
        danger_events: data.dangerEvents,
        credential_blocks: data.credentialBlocks,
        safety_gate_blocks: data.safetyGateBlocks,
        end_reason: data.endReason,
        priority: 'normal',
      },
      state_vector: null,
    };

    try {
      await this.fetchWithRetry('POST', url, payload);
    } catch {
      await this.backupToLocal([payload]);
    }
  }

  /**
   * 배치 전송 응답에서 R(t) 정보 추출
   * BatchSendResponse에 risk/grade/mode/axes가 있으면 반환
   */
  static extractRtFromResponse(res: BatchSendResponse): {
    rt: number;
    mode: SafetyMode;
    grade: TrustGrade;
    axes: AxesState;
  } | null {
    if (
      res.risk == null ||
      res.grade == null ||
      res.mode == null ||
      res.axes == null
    ) {
      return null;
    }
    return {
      rt: res.risk,
      mode: res.mode,
      grade: res.grade,
      axes: {
        baseline: res.axes.baseline,
        norm: res.axes.norm,
        stability: res.axes.stability,
        meta_control: res.axes.meta_control,
      },
    };
  }

  // ─── 내부 메서드 ────────────────────────────────────────────────────────────

  /**
   * 순수 배치 HTTP 전송 — backupToLocal 없음
   * sendBatch와 resubmitUnsent 양쪽에서 공유.
   * 단건은 객체, 복수는 배열로 전송.
   */
  private async sendBatchDirect(signals: SignalPayload[]): Promise<BatchSendResponse> {
    const url = `${this.baseUrl}/v1/inspect/stream`;
    const body = signals.length === 1 ? signals[0] : signals;
    const raw = await this.fetchWithRetry('POST', url, body);
    // TODO(runtime-guard): validate shape at runtime if payload schema drifts
    return (raw as BatchSendResponse | null) ?? { received: signals.length };
  }

  /**
   * retry 포함 fetch — 최대 retryMax+1회 시도
   * backoff: 100ms, 500ms, 2,000ms
   */
  private async fetchWithRetry(
    method: string,
    url: string,
    body: unknown
  ): Promise<unknown> {
    let lastError: Error = new Error('Unknown error');

    for (let attempt = 0; attempt <= this.retryMax; attempt++) {
      try {
        return await this.fetchOnce(method, url, body);
      } catch (err) {
        lastError = err as Error;
        if (attempt < this.retryMax) {
          const delay = RETRY_DELAYS[attempt] ?? 2_000;
          if (this.debug) {
            console.debug(
              `[P-MATRIX] Retry ${attempt + 1}/${this.retryMax} after ${delay}ms: ${lastError.message}`
            );
          }
          await sleep(delay);
        }
      }
    }

    throw lastError;
  }

  /**
   * 단건 fetch (Node.js 22+ 내장 fetch 사용)
   * Authorization: Bearer {apiKey}
   */
  private async fetchOnce(
    method: string,
    url: string,
    body: unknown
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const headers: Record<string, string> = {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      };

      const response = await fetch(url, {
        method,
        headers,
        body: body != null ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
      }

      const text = await response.text();
      return text ? JSON.parse(text) : null;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * 전송 실패 시 로컬 파일 백업 (fire-and-forget async)
   * 저장 경로: ~/.pmatrix/unsent/{timestamp}.json
   *
   * FIX #8: 동기 I/O(mkdirSync, writeFileSync) → 비동기 I/O로 교체.
   * 서버 불안정 시 호출될 때마다 이벤트 루프를 블로킹(stop-the-world)하던 문제 해결.
   * 호출부는 모두 fire-and-forget(await 없음)이므로 async 전환 시 동작 동일.
   */
  private async backupToLocal(signals: SignalPayload[]): Promise<void> {
    try {
      const dir = path.join(os.homedir(), '.pmatrix', 'unsent');
      await fs.promises.mkdir(dir, { recursive: true });
      const filename = path.join(dir, `${Date.now()}.json`);
      await fs.promises.writeFile(filename, JSON.stringify(signals, null, 2), 'utf-8');
      if (this.debug) {
        console.debug(`[P-MATRIX] ${signals.length} signals backed up to ${filename}`);
      }
    } catch {
      // 로컬 백업 실패도 조용히 무시 — Plugin 동작 계속
    }
  }
}

// ─── 유틸 ─────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
