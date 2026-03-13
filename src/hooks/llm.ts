// =============================================================================
// @pmatrix/openclaw-monitor — hooks/llm.ts  (TIER-2 확장)
// LLM 추론 관찰 훅:
//   llm_input  — runId 등록 + norm/stability 신호 버퍼링 + prompt_len 수집
//   llm_output — latency 계산 + 토큰 추적 + 크레덴셜 보조 스캔 (meta_control -0.25)
//                + cost-tracker 누적 (accumulateTokens)
//
// 분석서 §1-2 ★★ 최고 가치 신호:
//   llm_input  필드: runId, sessionId, provider, model,
//                    systemPrompt, prompt, historyMessages(number), imagesCount
//   llm_output 필드: runId, sessionId, provider, model,
//                    assistantTexts[], lastAssistant,
//                    usage.{input,output,cacheRead,cacheWrite,total}
//
// 프라이버시 (§14-5):
//   - prompt 전문은 절대 서버 전송 금지 (dataSharing 동의 시에도)
//   - prompt 길이(문자 수)는 전송 가능 — 복원 불가, Drift 분석에 필수 (PART I-1)
//   - systemPrompt → FNV-1a 해시만 전송 (단방향, 복원 불가)
//   - llm_output 신호 버퍼링은 dataSharing 동의 후에만
// =============================================================================

import { OpenClawPluginAPI, PMatrixConfig, HookContext } from '../types';
import { PMatrixHttpClient } from '../client';
import {
  getSession,
  getOrCreateSession,
  bufferSignal,
  buildSignalPayload,
  applyMetaControlDelta,
  startLlmRun,
  completeLlmRun,
  pushOutputTokens,
  incrementDangerEvents,
} from '../session-state';
import { scanCredentials } from '../credential-scanner';
import { accumulateTokens } from '../cost-tracker';

// ─── 등록 진입점 ──────────────────────────────────────────────────────────────

export function registerLlmHooks(
  api: OpenClawPluginAPI,
  config: PMatrixConfig,
  client: PMatrixHttpClient
): void {
  registerLlmInput(api, config);
  registerLlmOutput(api, config, client);
}

// ─── llm_input (§1-2 ⑤) ─────────────────────────────────────────────────────

/**
 * LLM 요청 전송 시점:
 *   1. runId 등록 → llm_output에서 latency 계산에 사용
 *   2. dataSharing 동의 시 norm/stability 메타데이터 버퍼링
 *      - systemPrompt: 해시만 전송 (전문 금지 §14-5)
 *      - historyMessages: count(number) 전송 (분석서 §1-2 ⑤ 검증)
 *      - prompt 전문: 절대 전송 안 함
 */
function registerLlmInput(
  api: OpenClawPluginAPI,
  config: PMatrixConfig
): void {
  api.on('llm_input', async (event, ctx) => {
    if (config.debug) {
      api.logger.info('[P-MATRIX] llm_input hook FIRED');
    }
    const sessionKey = resolveKey(ctx, event);
    if (!sessionKey) return {};

    const state = getOrCreateSession(sessionKey, config.agentId);

    // runId 등록 — latency 계산 기준 시각
    const runId = String(event['runId'] ?? event['run_id'] ?? '');
    if (runId) {
      startLlmRun(sessionKey, runId);
    }

    // dataSharing 동의 후에만 신호 버퍼링
    if (!config.dataSharing) return {};

    const model = String(event['model'] ?? event['modelId'] ?? '');
    const provider = String(event['provider'] ?? event['llmProvider'] ?? '');
    const historyMessages = Number(
      event['historyMessages'] ?? event['history_messages'] ?? 0
    );
    const imagesCount = Number(
      event['imagesCount'] ?? event['images_count'] ?? 0
    );

    // systemPrompt: 해시만 계산 — 전문 서버 전송 금지 (§14-5)
    const rawSystemPrompt = String(event['systemPrompt'] ?? event['system_prompt'] ?? '');
    const promptHash = rawSystemPrompt ? simpleHash(rawSystemPrompt) : undefined;

    // prompt_len: 문자 수 (정수) 전송 — 전문 금지, 길이는 안전 (PART I-1)
    // Drift 서버 분석에서 prompt_len is None → prompt_score = 0.0 처리
    const rawPrompt = String(event['prompt'] ?? event['userPrompt'] ?? '');
    const promptLen = rawPrompt.length > 0 ? rawPrompt.length : undefined;

    const signal = buildSignalPayload(state, {
      event_type: 'llm_input',
      llm_model: model || undefined,
      // FIX #37: || undefined는 historyMessages=0을 undefined로 변환 — 정확한 0값 보존을 위해 3항 연산자 사용
      history_messages: historyMessages > 0 ? historyMessages : undefined,
      prompt_hash: promptHash,
      prompt_len: promptLen,
      images_count: imagesCount > 0 ? imagesCount : undefined,
      provider: provider || undefined,
    });
    bufferSignal(sessionKey, signal);

    if (config.debug) {
      api.logger.info(
        `[P-MATRIX] llm_input: runId=${runId}, model=${model}, ` +
          `history=${historyMessages}, promptLen=${promptLen ?? 0}, ` +
          `promptHash=${promptHash?.slice(0, 8) ?? 'none'}`
      );
    }

    return {};
  });
}

// ─── llm_output (§1-2 ⑥) ────────────────────────────────────────────────────

/**
 * LLM 응답 수신 완료 시점:
 *   1. runId 매칭 → latency 계산 + 이동 평균 갱신
 *   2. 출력 토큰 이동 평균 갱신 (NORM 계산용)
 *   3. lastAssistant 크레덴셜 보조 스캔 (META_CONTROL -0.25)
 *      - 주 차단은 message_sending에서 처리 (§8-2)
 *      - 여기서는 신호 기록 목적 (sendCritical)
 *   4. dataSharing 동의 시 norm/stability 신호 버퍼링
 */
function registerLlmOutput(
  api: OpenClawPluginAPI,
  config: PMatrixConfig,
  client: PMatrixHttpClient
): void {
  api.on('llm_output', async (event, ctx) => {
    if (config.debug) {
      api.logger.info('[P-MATRIX] llm_output hook FIRED');
    }
    const sessionKey = resolveKey(ctx, event);
    if (!sessionKey) return {};

    const state = getSession(sessionKey);
    if (!state) return {};

    // ── 1. runId → latency 계산 ───────────────────────────────────────────
    const runId = String(event['runId'] ?? event['run_id'] ?? '');
    const latency = runId ? completeLlmRun(sessionKey, runId) : null;

    // ── 2. 토큰 이동 평균 갱신 ───────────────────────────────────────────
    const usage = (event['usage'] ?? {}) as Record<string, unknown>;
    // FIX #49: safeTokenCount — NaN/Infinity 값이 가드 로직을 우회하지 않도록 검증
    const outputTokens = safeTokenCount(usage['output']);
    const inputTokens = safeTokenCount(usage['input']);
    const totalTokens = safeTokenCount(usage['total']);
    const cacheRead = safeTokenCount(usage['cacheRead'] ?? usage['cache_read']);
    const cacheWrite = safeTokenCount(usage['cacheWrite'] ?? usage['cache_write']);

    if (outputTokens > 0) {
      pushOutputTokens(sessionKey, outputTokens);
    }

    // [Tier-2 §A-2] 토큰 누적 — cost-tracker (dataSharing 무관, 항상 수행)
    // cost_usd 계산 없음 — 서버 pricing.py 담당
    accumulateTokens(sessionKey, inputTokens, outputTokens);

    // ── 3. 크레덴셜 보조 스캔 (META_CONTROL -0.25, §8-2) ───────────────────────
    const lastAssistant = String(
      event['lastAssistant'] ??
      event['last_assistant'] ??
      (Array.isArray(event['assistantTexts'])
        ? (event['assistantTexts'] as string[]).at(-1)
        : '') ??
      ''
    );

    if (lastAssistant && config.credentialProtection.enabled) {
      const detected = scanCredentials(
        lastAssistant,
        config.credentialProtection.customPatterns
      );

      if (detected.length > 0) {
        const metaControlDelta = -0.25;

        // 로컬 axes 낙관적 업데이트 — dataSharing 무관
        const updatedAxes = applyMetaControlDelta(sessionKey, metaControlDelta);
        incrementDangerEvents(sessionKey);

        // 서버 긴급 전송 — dataSharing 동의 시에만
        if (config.dataSharing && updatedAxes) {
          const signal = buildSignalPayload(
            state,
            {
              event_type: 'llm_output_credential',
              patterns: detected.map((d) => d.name),
              meta_control_delta: metaControlDelta,
              priority: 'critical',
            },
            updatedAxes
          );
          // FIX #32: Promise 오류 묵살 방지 — debug 로그
          void client.sendCritical(signal).catch((err: Error) => {
            if (config.debug) {
              api.logger.debug(`[P-MATRIX] sendCritical failed: ${err.message}`);
            }
          });
        }

        if (config.debug) {
          api.logger.debug(
            `[P-MATRIX] llm_output: credential detected ` +
              `(${detected.map((d) => d.name).join(', ')}), META_CONTROL ${metaControlDelta}`
          );
        }
      }
    }

    // ── 4. norm/stability 신호 버퍼링 — dataSharing 동의 후에만 ─────────────
    if (!config.dataSharing) return {};

    const model = String(event['model'] ?? event['modelId'] ?? '');

    const signal = buildSignalPayload(state, {
      event_type: 'llm_output',
      llm_model: model || undefined,
      llm_tokens_total: totalTokens ?? undefined,
      output_tokens: outputTokens ?? undefined,
      input_tokens: inputTokens ?? undefined,
      latency_ms: latency ?? undefined,
      cache_read_tokens: cacheRead ?? undefined,
      cache_write_tokens: cacheWrite ?? undefined,
    });
    bufferSignal(sessionKey, signal);

    if (config.debug) {
      api.logger.debug(
        `[P-MATRIX] llm_output: model=${model}, ` +
          `tokens=${outputTokens}/${totalTokens}, latency=${latency ?? '?'}ms`
      );
    }

    return {};
  });
}

// ─── 내부 헬퍼 ────────────────────────────────────────────────────────────────

/**
 * FIX #49: 토큰 수 안전 변환 — NaN / Infinity / 음수 → 0
 * Number("abc") = NaN, Number(Infinity) = Infinity — 두 경우 모두 0으로 처리
 */
function safeTokenCount(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function resolveKey(
  ctx: HookContext,
  event: Record<string, unknown>
): string | null {
  // FIX #18: camelCase sessionKey fallback 추가 (message.ts와 통일)
  return (
    ctx.sessionKey ??
    (event['sessionKey'] as string | undefined) ??
    (event['sessionId'] as string | undefined) ??
    (event['session_id'] as string | undefined) ??
    null
  );
}

/**
 * FNV-1a 32bit 해시 — systemPrompt 단방향 식별 (§14-5)
 * 전문을 복원할 수 없으므로 프라이버시 안전.
 */
function simpleHash(str: string): string {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
