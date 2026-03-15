// =============================================================================
// @pmatrix/openclaw-monitor — index.ts
// Plugin 진입점: setup(api) export
//
// 사용법 (openclaw.json):
//   {
//     "plugins": ["@pmatrix/openclaw-monitor"],
//     "pmatrix": {
//       "serverUrl": "https://api.pmatrix.io",
//       "agentId":   "oc_abc123",
//       "apiKey":    "${PMATRIX_API_KEY}"
//     }
//   }
// =============================================================================

import { OpenClawPluginAPI, PMatrixConfig } from './types';
import { loadConfig } from './config';
import { PMatrixHttpClient } from './client';
import { registerSessionHooks } from './hooks/session';
import { registerToolHooks } from './hooks/tool';
import { registerMessageHooks } from './hooks/message';
import { registerModelHooks } from './hooks/model';
import { registerSubagentHooks } from './hooks/subagent';
import { registerLlmHooks } from './hooks/llm';
import { registerCompactionHooks } from './hooks/compaction';
import { registerTurnHooks } from './hooks/turn';
import { registerCommands } from './extensions/commands';
import { registerGatewayMethods } from './extensions/gateway-methods';
import { registerBatchService } from './extensions/service';
import { setFrameworkTag } from './session-state';
import { FieldNode, isField4Enabled, buildFieldConfigFromEnv } from '@pmatrix/field-node-runtime';

// ─── 공개 타입 재수출 (npm 소비자용) ─────────────────────────────────────────

export type { PMatrixConfig, SessionState, SignalPayload, GradeResponse } from './types';
export { loadConfig, validateConfig } from './config';
export { PMatrixHttpClient } from './client';

// ─── Plugin 진입점 ────────────────────────────────────────────────────────────

/**
 * P-MATRIX OpenClaw Monitor Plugin
 *
 * OpenClaw이 openclaw.json의 plugins 배열을 로드할 때 호출.
 * 실패 시 Plugin은 비활성화되지만 OpenClaw 자체는 계속 동작.
 *
 * Week 1: gateway_start/stop + session_start/end 훅 등록
 * Week 2: before_tool_call (Safety Gate)
 * Week 3: message_sending (크레덴셜 차단)
 * Week 4: registerCommand('pmatrix') + Kill Switch
 */
export function setup(api: OpenClawPluginAPI): void {
  let config: PMatrixConfig;

  try {
    config = loadConfig();
  } catch (err) {
    api.logger.error(
      `[P-MATRIX] ❌ 설정 로드 실패: ${(err as Error).message}`
    );
    api.logger.error(
      '[P-MATRIX] Plugin이 비활성화됩니다. openclaw.json을 확인하세요.'
    );
    return;
  }

  // config에서 frameworkTag 읽어 모듈 수준 설정
  if (config.frameworkTag) setFrameworkTag(config.frameworkTag);

  const client = new PMatrixHttpClient(config);

  // ── 4.0 Field Node (in-process, fail-open) ────────────────────────────────
  let fieldNode: FieldNode | null = null;
  if (isField4Enabled()) {
    try {
      const fc = buildFieldConfigFromEnv(config.serverUrl, config.apiKey);
      if (fc) {
        fieldNode = new FieldNode(fc);
        fieldNode.start();
      }
    } catch {
      // Fail-open: Field 초기화 실패해도 3.5 모니터링은 정상 동작
    }
  }

  // ── Week 1: 세션 라이프사이클 훅 ─────────────────────────────────────────
  registerSessionHooks(api, config, client, fieldNode);

  // ── Week 2: Safety Gate ───────────────────────────────────────────────────
  registerToolHooks(api, config, client);

  // ── Week 3: 크레덴셜 차단 + baseline 기준선 + 하위 에이전트 ──────────────
  registerMessageHooks(api, config, client);
  registerModelHooks(api, config, client);
  registerSubagentHooks(api, config, client);

  // ── Tier-1: LLM 추론 관찰 ────────────────────────────────────────────────
  registerLlmHooks(api, config, client);

  // ── GA B-4: 턴 경계 축 업데이트 (before_agent_start, agent_end) ──────────
  registerTurnHooks(api, config, client, fieldNode);

  // ── Tier-2: 컨텍스트 관리 (before_compaction, after_compaction, before_reset) ─
  registerCompactionHooks(api, config);

  // ── Week 4: 커맨드 + RPC + 배치 서비스 ──────────────────────────────────
  registerCommands(api, config, client);
  registerGatewayMethods(api, config, client);
  registerBatchService(api, config, client);

  if (config.debug) {
    api.logger.debug(
      '[P-MATRIX] Plugin setup complete. ' +
        'Hooks: gateway_start/stop, session_start/end, before_tool_call, after_tool_call, ' +
        'message_sending, before_message_write, tool_result_persist, message_received, ' +
        'before_model_resolve, before_prompt_build, ' +
        'subagent_spawning, subagent_spawned, subagent_ended, ' +
        'llm_input, llm_output, ' +
        'before_agent_start, agent_end, ' +
        'before_compaction, after_compaction, before_reset. ' +
        'Commands: /pmatrix (status/halt/resume/allow/help). ' +
        'Gateway: pmatrix.status. Service: pmatrix-batch.'
    );
  }
}

// ─── OpenClaw Plugin SDK 호환 래퍼 ──────────────────────────────────────────
// OpenClaw 2026.3+ 은 default export { id, register(api) } 패턴을 기대.
// 기존 setup() 을 register() 로 위임.

const plugin = {
  id: 'openclaw-monitor',
  name: '@pmatrix/openclaw-monitor',
  description: 'Real-time safety monitoring plugin for OpenClaw agents',
  register(api: OpenClawPluginAPI): void {
    setup(api);
  },
};

export default plugin;
