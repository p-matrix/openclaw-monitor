// =============================================================================
// breach-support.ts — Shared breach data collection for P-MATRIX monitors
// Provides: scope tagging, approval tracking, blocked action history,
//           session reporting, delegated action type inference
// =============================================================================

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ── Types ──

interface AuthorityLimit {
  allowed_action_types?: string[];
  denied_action_types?: string[];
  allowed_paths?: string[];
  denied_paths?: string[];
  max_tool_calls_per_session?: number;
  max_file_modifications_per_session?: number;
}

interface BlockedAction {
  tool_name: string;
  timestamp: number;
  reason: string;
}

interface ApprovalRecord {
  action_id: string;
  tool_name: string;
  status: 'requested' | 'granted' | 'denied';
  timestamp: number;
}

interface SessionReport {
  report_type: string;
  actions_summary: {
    tool_calls_count: number;
    file_modifications_count: number;
    errors_count: number;
    denied_count: number;
  };
  session_duration_ms?: number;
}

// ── Main Class ──

export class BreachSupport {
  private blockedActions: BlockedAction[] = [];
  private approvalRecords: ApprovalRecord[] = [];
  private toolCallCount = 0;
  private fileModCount = 0;
  private errorsCount = 0;
  private deniedCount = 0;
  private sessionStartTime = Date.now();
  private authorityLimit: AuthorityLimit | null = null;
  private readonly agentId: string;

  constructor(agentId: string) {
    this.agentId = agentId;
    this.authorityLimit = this._loadAuthorityLimit();
  }

  // ── Scope Tagging ──

  /**
   * Check if an action is within the delegated scope.
   * Returns null if no authority_limit is cached (graceful degradation).
   */
  isInScope(actionPrimitive: string, filePath?: string): boolean | null {
    if (!this.authorityLimit) return null;

    const allowed = this.authorityLimit.allowed_action_types;
    if (allowed && allowed.length > 0 && !allowed.includes(actionPrimitive)) {
      return false;
    }

    if (filePath && this.authorityLimit.allowed_paths) {
      const allowedPaths = this.authorityLimit.allowed_paths;
      // Simple glob matching: check if filePath starts with any allowed path prefix
      // (strips ** suffix for prefix matching)
      const pathInScope = allowedPaths.some(pattern => {
        const prefix = pattern.replace(/\/?\*\*$/, '');
        return filePath.startsWith(prefix) || filePath === prefix;
      });
      if (!pathInScope) return false;
    }

    if (filePath && this.authorityLimit.denied_paths) {
      const deniedPaths = this.authorityLimit.denied_paths;
      const pathDenied = deniedPaths.some(pattern => {
        const prefix = pattern.replace(/\/?\*\*$/, '');
        return filePath.startsWith(prefix) || filePath === prefix;
      });
      if (pathDenied) return false;
    }

    return true;
  }

  // ── Approval Tracking ──

  recordApprovalRequested(actionId: string, toolName: string): void {
    this.approvalRecords.push({
      action_id: actionId,
      tool_name: toolName,
      status: 'requested',
      timestamp: Date.now(),
    });
  }

  recordApprovalGranted(actionId: string): void {
    this.approvalRecords.push({
      action_id: actionId,
      tool_name: '',
      status: 'granted',
      timestamp: Date.now(),
    });
  }

  recordApprovalDenied(actionId: string): void {
    this.approvalRecords.push({
      action_id: actionId,
      tool_name: '',
      status: 'denied',
      timestamp: Date.now(),
    });
  }

  getApprovalStatus(actionId: string): 'granted' | 'denied' | 'pending' | null {
    // Find most recent record for this action_id
    // Phase R-6 (2026-04-27): noUncheckedIndexedAccess narrowing —
    // explicit local const after array index for type safety.
    for (let i = this.approvalRecords.length - 1; i >= 0; i--) {
      const rec = this.approvalRecords[i];
      if (rec && rec.action_id === actionId) {
        return rec.status === 'requested' ? 'pending' : rec.status as 'granted' | 'denied';
      }
    }
    return null;
  }

  // ── Blocked Action Tracking ──

  recordBlockedAction(toolName: string, reason: string): void {
    this.blockedActions.push({
      tool_name: toolName,
      timestamp: Date.now(),
      reason,
    });
  }

  /**
   * Get blocked actions within the last windowMs (default 60s).
   * Pattern Matcher's retry_after_block uses 60s window.
   */
  getRecentBlocked(windowMs = 60_000): BlockedAction[] {
    const cutoff = Date.now() - windowMs;
    return this.blockedActions.filter(b => b.timestamp >= cutoff);
  }

  // ── Counters ──

  incrementToolCalls(): void { this.toolCallCount++; }
  incrementFileModifications(): void { this.fileModCount++; }
  incrementErrors(): void { this.errorsCount++; }
  incrementDenied(): void { this.deniedCount++; }

  getToolCallCount(): number { return this.toolCallCount; }
  getFileModCount(): number { return this.fileModCount; }

  // ── Session Reporting ──

  /**
   * Build session report for reporting_breach detection.
   * Sent as observation fact at session_end with subject matching report_id.
   */
  getSessionReport(): SessionReport {
    return {
      report_type: 'session_summary',
      actions_summary: {
        tool_calls_count: this.toolCallCount,
        file_modifications_count: this.fileModCount,
        errors_count: this.errorsCount,
        denied_count: this.deniedCount,
      },
      session_duration_ms: Date.now() - this.sessionStartTime,
    };
  }

  // ── Delegated Action Type ──

  /**
   * Infer the action type being delegated to a subagent.
   * Uses the most recent tool context (if a tool was being used when subagent spawned).
   */
  inferDelegatedActionType(lastToolName?: string): string | undefined {
    if (!lastToolName) return undefined;
    // Map common tool names to AP types
    const toolToAP: Record<string, string> = {
      'bash': 'AP-1', 'shell': 'AP-1', 'exec': 'AP-1',
      'run_shell_command': 'AP-1', 'execute_command': 'AP-1',
      'write_file': 'AP-2', 'create_file': 'AP-2', 'edit_file': 'AP-2',
      'read_file': 'AP-2',
      'web_fetch': 'AP-3', 'http_request': 'AP-3', 'curl': 'AP-3',
    };
    return toolToAP[lastToolName] ?? 'AP-1';
  }

  // ── Metadata Enrichment ──

  /**
   * Build breach-related metadata to include in signal payloads.
   */
  enrichMetadata(base: Record<string, any>, opts?: {
    actionPrimitive?: string;
    filePath?: string;
    toolName?: string;
  }): Record<string, any> {
    const enriched = { ...base };

    // Scope tagging
    if (opts?.actionPrimitive) {
      enriched.in_scope = this.isInScope(opts.actionPrimitive, opts.filePath);
    }

    // Blocked action history (for concealment detection)
    const recentBlocked = this.getRecentBlocked();
    if (recentBlocked.length > 0) {
      enriched.blocked_action_history = recentBlocked.map(b => ({
        tool: b.tool_name,
        ts: b.timestamp,
        reason: b.reason,
      }));
    }

    return enriched;
  }

  // ── Internal ──

  private _loadAuthorityLimit(): AuthorityLimit | null {
    try {
      const cacheDir = path.join(os.homedir(), '.pmatrix', 'cache', 'agents', this.agentId);
      const contractPath = path.join(cacheDir, 'contract.json');
      if (!fs.existsSync(contractPath)) return null;
      const raw = fs.readFileSync(contractPath, 'utf-8');
      const parsed = JSON.parse(raw);
      const data = parsed.data || parsed;
      return data.authority_limit || null;
    } catch {
      return null; // Graceful degradation
    }
  }
}
