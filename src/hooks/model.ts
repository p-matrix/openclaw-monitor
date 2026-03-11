// =============================================================================
// @pmatrix/openclaw-monitor — hooks/model.ts
// 모델 해석 훅:
//   before_model_resolve — baseline 기준선 캡처 (§5-4) + Kill Switch 안전 모델 강제 전환
//   before_prompt_build  — 프롬프트 해시 기록 (baseline 기준선 보조)
// =============================================================================

import { OpenClawPluginAPI, PMatrixConfig, HookContext } from '../types';
import { PMatrixHttpClient } from '../client';
import {
  getOrCreateSession,
  getSession,
  bufferSignal,
  buildSignalPayload,
  captureBaseline,
} from '../session-state';

// ─── 등록 진입점 ──────────────────────────────────────────────────────────────

export function registerModelHooks(
  api: OpenClawPluginAPI,
  config: PMatrixConfig,
  client: PMatrixHttpClient
): void {
  registerBeforeModelResolve(api, config, client);
  registerBeforePromptBuild(api, config);
}

// ─── before_model_resolve (§5-4) ─────────────────────────────────────────────

/**
 * 모델 선택 직전:
 *   1. baseline 기준선 최초 캡처 (세션 첫 호출 시)
 *   2. Halt(R≥0.75) → 안전 모델 강제 전환 (Tier-0)
 *   2b. Critical(R≥0.50) → 안전 모델 다운그레이드 (Tier-1, §13 TIER-1, 분석서 §4-2)
 *   3. 기준선 대비 모델 변경 → baseline 감점 신호 (-0.10) 버퍼링
 */
function registerBeforeModelResolve(
  api: OpenClawPluginAPI,
  config: PMatrixConfig,
  _client: PMatrixHttpClient
): void {
  api.on('before_model_resolve', async (event, ctx) => {
    const sessionKey = resolveKey(ctx, event);
    if (!sessionKey) return {};

    const state = getOrCreateSession(sessionKey, config.agentId);
    const provider = String(event['provider'] ?? event['llmProvider'] ?? '');
    const model = String(event['model'] ?? event['modelId'] ?? '');

    // ── 1. baseline 기준선 최초 캡처 ─────────────────────────────────────────────
    if (!state.baselineModel && model) {
      captureBaseline(sessionKey, provider, model);

      if (config.debug) {
        api.logger.debug(
          `[P-MATRIX] baseline captured: provider=${provider}, model=${model}`
        );
      }

      // 첫 호출은 기준선 설정이므로 변경 감지 불필요
      return {};
    }

    // ── 2. Halt(A-0, R≥0.75) → 안전 모델 강제 전환 ──────────────────────────
    if (state.isHalted) {
      const safeModel = config.killSwitch.safeModel;
      if (model && model !== safeModel) {
        if (config.debug) {
          api.logger.debug(
            `[P-MATRIX] Halt: forcing safe model ${safeModel} (was: ${model})`
          );
        }
        return { modelOverride: safeModel };
      }
    }

    // ── 2b. Critical(A-2, R≥0.50) → 안전 모델 다운그레이드 (Tier-1) ─────────
    // Halt 미발동 상태에서 Critical 진입 시 safeModel로 전환.
    // Server 경계값 기준: A-2 = [0.50, 0.75) (§14-4, 분석서 §4-2)
    if (!state.isHalted && state.currentRt >= 0.50) {
      const safeModel = config.killSwitch.safeModel;
      if (model && model !== safeModel) {
        // dataSharing 동의 시 다운그레이드 이벤트 신호 전송
        if (config.dataSharing) {
          const signal = buildSignalPayload(state, {
            event_type: 'model_downgrade',
            tool_name: `${model} → ${safeModel}`,
            rt_at_override: state.currentRt,
            mode_at_override: state.currentMode,
          });
          bufferSignal(sessionKey, signal);
        }

        if (config.debug) {
          api.logger.debug(
            `[P-MATRIX] Critical(R=${state.currentRt.toFixed(2)}): ` +
              `downgrading to safe model ${safeModel} (was: ${model})`
          );
        }

        return { modelOverride: safeModel };
      }
    }

    // ── 3. 기준선 대비 모델 변경 감지 → baseline 감점 신호 ──────────────────────
    if (
      state.baselineModel &&
      model &&
      model !== state.baselineModel &&
      config.dataSharing
    ) {
      const signal = buildSignalPayload(state, {
        event_type: 'model_changed',
        tool_name: `${state.baselineModel} → ${model}`,
        baseline_delta: -0.10,
      });
      bufferSignal(sessionKey, signal);

      if (config.debug) {
        api.logger.debug(
          `[P-MATRIX] Model changed: ${state.baselineModel} → ${model} (baseline -0.10)`
        );
      }
    }

    return {};
  });
}

// ─── before_prompt_build ─────────────────────────────────────────────────────

/**
 * 프롬프트 빌드 직전 — 시스템 프롬프트 해시 기록 (baseline 기준선 보조)
 * 프롬프트 전문 서버 전송 금지 (dataSharing 동의 후 TIER-1에서만 허용 §14-5)
 */
function registerBeforePromptBuild(
  api: OpenClawPluginAPI,
  config: PMatrixConfig
): void {
  api.on('before_prompt_build', async (event, ctx) => {
    const sessionKey = resolveKey(ctx, event);
    if (!sessionKey) return {};

    const state = getSession(sessionKey);
    if (!state || state.baselinePromptHash) return {};

    // 시스템 프롬프트 해시만 저장 — 전문 서버 전송 안 함 (§14-5)
    const systemPrompt = String(
      event['systemPrompt'] ?? event['system_prompt'] ?? ''
    );
    if (systemPrompt) {
      const hash = simpleHash(systemPrompt);
      state.baselinePromptHash = hash;

      if (config.debug) {
        api.logger.debug(
          `[P-MATRIX] baseline prompt hash captured: ${hash.slice(0, 8)}...`
        );
      }
    }

    return {};
  });
}

// ─── 내부 헬퍼 ────────────────────────────────────────────────────────────────

function resolveKey(
  ctx: HookContext,
  event: Record<string, unknown>
): string | null {
  return (
    ctx.sessionKey ??
    (event['sessionKey'] as string | undefined) ??  // FIX #35: camelCase fallback (FIX #18 누락분)
    (event['sessionId'] as string | undefined) ??
    (event['session_id'] as string | undefined) ??
    null
  );
}

/**
 * 간단한 문자열 해시 (FNV-1a 32bit 근사)
 * 프롬프트 전문을 저장하지 않기 위한 단방향 해시 (§14-5)
 */
function simpleHash(str: string): string {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
