// =============================================================================
// @pmatrix/openclaw-monitor — hooks/message.ts
// 메시지 훅:
//   message_sending       — 크레덴셜 차단 핵심 (§5-3) + Halt 연동
//   before_message_write  — transcript 보호 (blockTranscript 설정 시)
//   tool_result_persist   — 보조 스캔 (meta_control -0.15, 차단은 선택적)
//   message_received      — 턴 카운터 증가
// =============================================================================

import {
  OpenClawPluginAPI,
  PMatrixConfig,
  HookContext,
} from '../types';
import { PMatrixHttpClient } from '../client';
import {
  getSession,
  getOrCreateSession,
  bufferSignal,
  buildSignalPayload,
  applyMetaControlDelta,
  incrementCredentialBlocks,
  incrementTurnNumber,
} from '../session-state';
import { scanCredentials } from '../credential-scanner';
import { formatCredentialAlert } from '../ui/formatter';

// ─── 등록 진입점 ──────────────────────────────────────────────────────────────

export function registerMessageHooks(
  api: OpenClawPluginAPI,
  config: PMatrixConfig,
  client: PMatrixHttpClient
): void {
  registerMessageReceived(api, config);
  registerMessageSending(api, config, client);
  registerBeforeMessageWrite(api, config);
  registerToolResultPersist(api, config);
}

// ─── message_received — 턴 카운터 ────────────────────────────────────────────

function registerMessageReceived(
  api: OpenClawPluginAPI,
  config: PMatrixConfig
): void {
  api.on('message_received', async (event, ctx) => {
    const sessionKey = resolveKey(ctx, event);
    if (!sessionKey) return;

    const state = getOrCreateSession(sessionKey, config.agentId);
    state.turnNumber++;

    if (config.debug) {
      api.logger.debug(`[P-MATRIX] Turn ${state.turnNumber}: message received`);
    }
  });
}

// ─── message_sending — 크레덴셜 차단 핵심 (§5-3) ─────────────────────────────

/**
 * 발신 직전 검사:
 *   0. Outbound Allowlist 검사 (outboundAllowlist.enabled 시)
 *      — 허용되지 않은 채널이면 즉시 { cancel: true } 반환
 *   1. 크레덴셜 스캔 (credentialProtection.enabled 시)
 *   2. 감지 시 META_CONTROL -0.30 델타 로컬 적용 + 서버 긴급 전송
 *   3. 사용자에게 차단 알림
 *   4. { cancel: true } 반환 → 메시지 발신 취소
 *
 * Halt 상태에서 일반 텍스트 응답은 허용 (에이전트가 상황 설명 가능 §3-4, A-7)
 */
function registerMessageSending(
  api: OpenClawPluginAPI,
  config: PMatrixConfig,
  client: PMatrixHttpClient
): void {
  api.on('message_sending', async (event, ctx) => {
    const sessionKey = resolveKey(ctx, event);
    if (!sessionKey) return {};

    const text = extractText(event);

    // ── 0. Outbound Allowlist 검사 ────────────────────────────────────────
    const al = config.outboundAllowlist;
    if (al.enabled && al.allowedChannels.length > 0) {
      // 채널/수신자 식별: event의 channel, recipient, to 필드 확인
      const channel =
        String(
          event['channel'] ??
          event['recipient'] ??
          event['to'] ??
          ''
        );

      const isAllowed =
        !channel || // 채널 정보 없으면 통과 (알 수 없는 경우 허용, fail-open)
        al.allowedChannels.some((allowed) => allowed && (channel.startsWith(allowed) || channel === allowed));

      if (!isAllowed) {
        const state = getSession(sessionKey);

        // dataSharing 동의 시 META_CONTROL -0.10 신호 버퍼링
        if (state && config.dataSharing) {
          const metaControlDelta = -0.10;
          const updatedAxes = applyMetaControlDelta(sessionKey, metaControlDelta);
          const signal = buildSignalPayload(
            state,
            {
              event_type: 'allowlist_block',
              tool_name: channel,
              meta_control_delta: metaControlDelta,
            },
            updatedAxes ?? state.axes
          );
          bufferSignal(sessionKey, signal);
        }

        if (config.debug) {
          api.logger.debug(
            `[P-MATRIX] Outbound blocked: channel="${channel}" not in allowlist`
          );
        }

        return { cancel: true };
      }
    }

    // 크레덴셜 보호 비활성 설정 시 스킵
    if (!config.credentialProtection.enabled) return {};

    const detected = scanCredentials(
      text,
      config.credentialProtection.customPatterns
    );

    if (detected.length > 0) {
      const metaControlDelta = -0.30;
      const state = getSession(sessionKey);

      if (state) {
        // 로컬 axes 낙관적 업데이트
        const updatedAxes = applyMetaControlDelta(sessionKey, metaControlDelta);

        // 긴급 신호 즉시 전송 (retry 없음 §4-3)
        if (config.dataSharing && updatedAxes) {
          const signal = buildSignalPayload(
            state,
            {
              event_type: 'credential_detected',
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
      }

      incrementCredentialBlocks(sessionKey);

      // 사용자에게 차단 알림 — 실제 크레덴셜 값 미포함
      const msg = formatCredentialAlert(
        detected.map((d) => d.name),
        metaControlDelta
      );
      api.logger.warn(msg);

      return { cancel: true };
    }

    return {};
  });
}

// ─── before_message_write — transcript 보호 ───────────────────────────────────

/**
 * transcript 기록 차단 (blockTranscript: true 설정 시)
 * message_sending에서 발신이 차단돼도, 이미 작성된 transcript는 별도 차단 필요.
 * META_CONTROL -0.15 (보조 감점, message_sending과 중복 차단 방지)
 */
function registerBeforeMessageWrite(
  api: OpenClawPluginAPI,
  config: PMatrixConfig
): void {
  // NOTE: before_message_write는 OpenClaw에서 동기 훅 — async 사용 금지
  api.on('before_message_write', (event) => {
    if (
      !config.credentialProtection.enabled ||
      !config.credentialProtection.blockTranscript
    ) {
      return {};
    }

    const text = extractText(event);
    const detected = scanCredentials(
      text,
      config.credentialProtection.customPatterns
    );

    if (detected.length > 0) {
      // transcript 기록 차단 — 사용자 알림 없음 (message_sending에서 이미 처리)
      return { block: true };
    }

    return {};
  });
}

// ─── tool_result_persist — 보조 스캔 (§3-2) ──────────────────────────────────

/**
 * 도구 결과 기록 전 보조 크레덴셜 스캔
 * 주 차단은 message_sending에서 처리. 여기서는 META_CONTROL 감점만.
 * META_CONTROL -0.15 (§8-2)
 */
function registerToolResultPersist(
  api: OpenClawPluginAPI,
  config: PMatrixConfig
): void {
  // NOTE: tool_result_persist는 OpenClaw에서 동기 훅 — async 사용 금지
  api.on('tool_result_persist', (event, ctx) => {
    const sessionKey = resolveKey(ctx, event);
    if (!sessionKey) return {};

    if (!config.credentialProtection.enabled) return {};

    const resultText = serializeToolResult(
      event['result'] ?? event['output'] ?? event['content'] ?? ''
    );

    const detected = scanCredentials(
      resultText,
      config.credentialProtection.customPatterns
    );

    if (detected.length > 0) {
      const metaControlDelta = -0.15;
      const state = getSession(sessionKey);

      if (state && config.dataSharing) {
        const updatedAxes = applyMetaControlDelta(sessionKey, metaControlDelta);
        const signal = buildSignalPayload(
          state,
          {
            event_type: 'tool_result_credential',
            patterns: detected.map((d) => d.name),
            meta_control_delta: metaControlDelta,
          },
          updatedAxes ?? state.axes
        );
        // 보조 스캔 — 버퍼에 추가 (긴급 전송 불필요)
        bufferSignal(sessionKey, signal);
      }

      if (config.debug) {
        api.logger.info(
          `[P-MATRIX] tool_result_persist: credential detected ` +
            `(${detected.map((d) => d.name).join(', ')}), META_CONTROL ${metaControlDelta}`
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
    (event['sessionKey'] as string | undefined) ??
    (event['sessionId'] as string | undefined) ??
    (event['session_id'] as string | undefined) ??
    null
  );
}

/**
 * 이벤트에서 텍스트 추출
 * JSON.stringify는 순환 참조 객체에서 throw — try-catch로 방어
 * (serializeToolResult와 동일 패턴 적용)
 */
function extractText(event: Record<string, unknown>): string {
  const raw =
    event['text'] ??
    event['content'] ??
    event['message'] ??
    event['body'] ??
    '';
  if (typeof raw === 'string') return raw;
  try {
    return JSON.stringify(raw);
  } catch {
    return '[Unserializable Content]';
  }
}

/** 도구 결과를 문자열로 직렬화 */
function serializeToolResult(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
