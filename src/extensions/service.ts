// =============================================================================
// @pmatrix/openclaw-monitor — extensions/service.ts
// 배치 전송 Service Worker (§4-3):
//   - flushIntervalMs마다 전체 세션 버퍼 자동 플러시
//   - 버퍼 ≥ maxSize → 즉시 플러시 (interval 주기 무관)
//   - 전송 실패 → client 내부 retry 3회 + backupToLocal (~/.pmatrix/unsent/)
//
// 주의: safety_critical 신호(크레덴셜 감지, Halt, 폭발)는
//       각 훅에서 sendCritical()로 즉시 전송 — 이 서비스와 무관
// =============================================================================

import { OpenClawPluginAPI, PMatrixConfig } from '../types';
import { PMatrixHttpClient } from '../client';
import { sessions, popBuffer, getBufferSize } from '../session-state';

// ─── 등록 진입점 ──────────────────────────────────────────────────────────────

// FIX #16: interval ID 보관 — 재등록 시 기존 interval 중지 (플러그인 언로드 후 이중 실행 방지)
let _batchIntervalId: ReturnType<typeof setInterval> | null = null;

export function registerBatchService(
  api: OpenClawPluginAPI,
  config: PMatrixConfig,
  client: PMatrixHttpClient
): void {
  api.registerService({
    id: 'pmatrix-batch',
    start: async () => {
      // FIX #16: 이전 interval이 있으면 먼저 중지
      if (_batchIntervalId !== null) {
        clearInterval(_batchIntervalId);
        _batchIntervalId = null;
      }

      // 주기 플러시 인터벌 설정 — 즉시 반환, interval은 백그라운드 유지
      _batchIntervalId = setInterval(() => {
        void flushAllSessions(api, config, client);
        void client.resubmitUnsent();  // BUG-5: unsent 백업 파일 재전송 (60초 throttle)
      }, config.batch.flushIntervalMs);

      if (config.debug) {
        api.logger.info(
          `[P-MATRIX] Batch service started — ` +
            `interval=${config.batch.flushIntervalMs}ms, maxSize=${config.batch.maxSize}`
        );
      }
    },
    stop: async () => {
      if (_batchIntervalId !== null) {
        clearInterval(_batchIntervalId);
        _batchIntervalId = null;
      }
    },
  });

  // NOTE: gateway_stop interval 정리는 service.stop()에서 처리.
  //       별도 registerHook('gateway_stop') 불필요 — hooks/session.ts에서 전역 정리 담당.
}

// ─── 플러시 로직 ──────────────────────────────────────────────────────────────

/**
 * 전체 세션 버퍼를 순회하며 조건 충족 시 배치 전송
 *
 * 플러시 조건 (§4-3):
 *   1. 버퍼 크기 ≥ maxSize (즉시 전송)
 *   2. interval 경과 (setInterval이 보장 — 항상 true)
 */
async function flushAllSessions(
  api: OpenClawPluginAPI,
  config: PMatrixConfig,
  client: PMatrixHttpClient
): Promise<void> {
  // FIX #39: await 지점에서 Map 동시 수정 방지 — 반복 전 스냅샷으로 복사
  // FIX #66: lastFlushAtMs를 스냅샷 단계에서 캡처 — 루프 내 sessions.get() 재호출 제거
  //          (스냅샷 후 deleteSession() 호출 시 sessions.get()이 undefined → ?? 0 폴백으로
  //           timeSinceFlush = Date.now() - 0 이 되어 불필요한 flushSession() 호출 발생 방지)
  const snapshot = Array.from(sessions.entries()).map(([sessionKey, state]) => ({
    sessionKey,
    lastFlushAtMs: state.lastFlushAt.getTime(),
  }));

  for (const { sessionKey, lastFlushAtMs } of snapshot) {
    const bufferSize = getBufferSize(sessionKey);
    if (bufferSize === 0) continue;

    // 즉시 플러시 조건: 버퍼 크기 ≥ maxSize
    // 주기 플러시 조건: interval 경과 (항상 충족)
    const shouldFlush = bufferSize >= config.batch.maxSize;
    const timeSinceFlush = Date.now() - lastFlushAtMs;
    const intervalElapsed = timeSinceFlush >= config.batch.flushIntervalMs;

    if (shouldFlush || intervalElapsed) {
      await flushSession(sessionKey, api, config, client);
    }
  }
}

/**
 * 특정 세션 버퍼 플러시
 * 실패 시 client 내부 retry + backupToLocal 처리 (중복 재삽입 없음)
 */
async function flushSession(
  sessionKey: string,
  api: OpenClawPluginAPI,
  config: PMatrixConfig,
  client: PMatrixHttpClient
): Promise<void> {
  // FIX #52: popBuffer() 내부에서 lastFlushAt 갱신 + signalBuffer 비움.
  // 이후 sessions.get() 재조회 불필요 — deleteSession 병행 시 null 가능성 제거.
  const signals = popBuffer(sessionKey);
  if (signals.length === 0) return;

  try {
    await client.sendBatch(signals);

    if (config.debug) {
      api.logger.info(
        `[P-MATRIX] Batch sent: ${signals.length} signals (session=${sessionKey})`
      );
    }
  } catch (err) {
    // client.sendBatch: 3회 retry 후에도 실패 → backupToLocal 내부 처리
    api.logger.warn(
      `[P-MATRIX] Batch send failed (session=${sessionKey}): ${(err as Error).message}`
    );
  }
}
