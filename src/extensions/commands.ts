// =============================================================================
// @pmatrix/openclaw-monitor — extensions/commands.ts
// /pmatrix 채팅 커맨드 (§9-4):
//   status    — 현재 Grade, R(t), 4축 분해 표시
//   halt      — 수동 Kill Switch 발동
//   resume    — Halt 해제
//   allow once— Safety Gate 확인 대기 중 일회 허용
//   help      — 명령어 목록 표시
// =============================================================================

import {
  OpenClawPluginAPI,
  PMatrixConfig,
  PluginCommandContext,
  PluginCommandResult,
} from '../types';
import { PMatrixHttpClient } from '../client';
import { getSession, haltSession, resumeSession, sessions } from '../session-state';
import {
  formatStatusMessage,
  formatHaltManual,
  formatResumeMessage,
} from '../ui/formatter';

// ─── 등록 진입점 ──────────────────────────────────────────────────────────────

export function registerCommands(
  api: OpenClawPluginAPI,
  config: PMatrixConfig,
  client: PMatrixHttpClient
): void {
  api.registerCommand({
    name: 'pmatrix',
    description: 'P-MATRIX safety monitor commands (status/halt/resume/allow/help)',
    acceptsArgs: true,
    handler: async (ctx: PluginCommandContext): Promise<PluginCommandResult> => {
      const args = (ctx.args ?? '').trim().split(/\s+/).filter(Boolean);
      const sub = args[0] ?? 'help';

      switch (sub) {
        case 'status':
          return handleStatus(config, client, ctx);
        case 'halt':
          return handleHalt(ctx);
        case 'resume':
          return handleResume(config, client, ctx);
        case 'allow':
          if (args[1] === 'once') {
            return handleAllowOnce(ctx);
          }
          return { text: HELP_TEXT };
        default:
          return { text: HELP_TEXT };
      }
    },
  });
}

// ─── status ───────────────────────────────────────────────────────────────────

/**
 * /pmatrix status
 * 서버에서 최신 Grade 갱신 시도 후 로컬 상태 표시.
 * 서버 다운 시 로컬 캐시 사용 (§7-1 fail-open).
 */
async function handleStatus(
  config: PMatrixConfig,
  client: PMatrixHttpClient,
  ctx: PluginCommandContext
): Promise<PluginCommandResult> {
  // 커맨드에서는 sessionKey 대신 config.agentId 기반 조회
  // (커맨드 컨텍스트에 sessionKey 없음)
  try {
    const grade = await client.getAgentGrade(config.agentId);
    if (grade) {
      const lines = [`[P-MATRIX] Agent Status`];
      lines.push(`  Grade: ${grade.grade ?? '-'} / P-Score: ${grade.p_score ?? '-'}`);
      if (grade.risk != null && grade.mode) {
        lines.push(`  R(t): ${grade.risk.toFixed(3)} / Mode: ${grade.mode}`);
      }
      if (grade.axes) {
        lines.push(
          `  Axes: B=${grade.axes.baseline?.toFixed(2) ?? '-'} N=${grade.axes.norm?.toFixed(2) ?? '-'} ` +
          `S=${grade.axes.stability?.toFixed(2) ?? '-'} M=${grade.axes.meta_control?.toFixed(2) ?? '-'}`,
        );
      }
      return { text: lines.join('\n') };
    }
    return { text: '[P-MATRIX] 서버 응답에 Grade 정보 없음.' };
  } catch {
    // 서버 오프라인 → 로컬 캐시 사용 (§7-1)
  }

  return { text: '[P-MATRIX] 서버 연결 불가. 로컬 캐시 없음.' };
}

// ─── halt ─────────────────────────────────────────────────────────────────────

/**
 * /pmatrix halt — 수동 Kill Switch 발동
 * 커맨드 컨텍스트에 sessionKey가 없으므로 전체 활성 세션을 halt.
 */
function handleHalt(ctx: PluginCommandContext): PluginCommandResult {
  let halted = 0;
  for (const [key, state] of sessions) {
    if (!state.isHalted) {
      haltSession(key, 'Manual halt via /pmatrix halt');
      halted++;
    }
  }
  return { text: formatHaltManual() };
}

// ─── resume ───────────────────────────────────────────────────────────────────

/**
 * /pmatrix resume — Halt 해제
 * 1. 전체 halted 세션 로컬 resume (즉시)
 * 2. 서버에 resume 통지 (감사 추적, fire-and-forget)
 */
async function handleResume(
  config: PMatrixConfig,
  client: PMatrixHttpClient,
  ctx: PluginCommandContext,
): Promise<PluginCommandResult> {
  let resumed = 0;
  for (const [key, state] of sessions) {
    if (state.isHalted) {
      resumeSession(key);
      resumed++;
    }
  }

  // 서버 통지 (fail-open: 실패해도 로컬 resume 유지)
  if (resumed > 0) {
    client.notifyResume(config.agentId).catch(() => {});
  }

  return { text: formatResumeMessage() };
}

// ─── allow once ───────────────────────────────────────────────────────────────

/**
 * /pmatrix allow once — Safety Gate 확인 대기 중 일회 허용
 * pendingConfirmation의 Promise를 resolve(true)로 해제.
 */
function handleAllowOnce(ctx: PluginCommandContext): PluginCommandResult {
  // Resolve pending confirmation if one exists
  for (const [, state] of sessions) {
    if (state.pendingConfirmation) {
      state.pendingConfirmation.resolve(true);
      break;
    }
  }
  return {
    text: '[P-MATRIX] Safety Gate allow-once 요청 접수. 대기 중인 확인이 있으면 허용됩니다.',
  };
}

// ─── help ─────────────────────────────────────────────────────────────────────

const HELP_TEXT = [
  '─────────────────────────────────────────',
  '[P-MATRIX] 명령어 목록',
  '─────────────────────────────────────────',
  '/pmatrix status      Grade, R(t), 4축 분해 표시',
  '/pmatrix halt        수동 Kill Switch 발동',
  '/pmatrix resume      Halt 해제',
  '/pmatrix allow once  Safety Gate 일회 허용',
  '/pmatrix help        이 목록 표시',
  '─────────────────────────────────────────',
].join('\n');
