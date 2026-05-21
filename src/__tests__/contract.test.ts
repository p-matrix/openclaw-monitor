// =============================================================================
// openclaw-monitor contract.test.ts — Tier 2 conformance (Contract v0.1)
// =============================================================================
// OpenClaw is unique among the 6 SDK:
//   - signal_source = 'adapter_stream' (NOT '*_hook' pattern)
//   - plugin runtime (NOT CLI lifecycle hooks)
//   - GateAction includes 'CONFIRM' (user-confirm-required path)
// =============================================================================

import {
  AgentEventSchema,
  NormalizedActionEventSchema,
  ObservableFactSchema,
  AxisEvidenceSchema,
  PEPEvaluationInputSchema,
  type AgentEvent,
  type NormalizedActionEvent,
  type ObservableFact,
  type AxisEvidence,
  type PEPEvaluationInput,
  type GateAction,
} from '@pmatrix/core-sdk';
import { PMatrixHttpClient } from '../client';
import type { SessionSummaryInput } from '../client';
import type { PMatrixConfig } from '@pmatrix/core-sdk';

function mockConfig(): PMatrixConfig {
  return {
    serverUrl: 'https://test.invalid',
    agentId: 'openclaw-agent-001',
    apiKey: 'test-key',
    safetyGate: { enabled: true, serverTimeoutMs: 2500 },
    credentialProtection: { enabled: true, customPatterns: [] },
    killSwitch: { autoHaltOnRt: 0.75 },
    dataSharing: false,
    batch: { maxSize: 50, flushIntervalMs: 5000, retryMax: 3 },
    debug: false,
  };
}

function openclawAgentEvent(eventType: string, hookName: string): AgentEvent {
  return {
    vendor: 'openclaw',
    product: 'openclaw',
    host_surface: 'cli',  // plugin runtime treated as cli surface
    event_type: eventType,
    timestamp: '2026-05-20T00:00:00.000Z',
    session_id: 'sess-openclaw-001',
    agent_id: 'openclaw-agent-001',
    raw_event_ref: 'sha256:openclaw-raw-event',
    content_included: false,
    host_integration_scope: {
      integration_type: 'cli-hook',
      hook_name: hookName,
      adapter_version: '0.6.0',
    },
    vendor_extensions: { channel: 'main', plugin_runtime: 'v2026.3.2' },
  };
}

describe('openclaw-monitor contract v0.1 conformance', () => {
  test('PMatrixHttpClient identity auto-injected (adapter_stream / openclaw)', () => {
    const client = new PMatrixHttpClient(mockConfig());
    // OpenClaw is the unique SDK using adapter_stream pattern (not *_hook)
    expect(client.identity.signalSource).toBe('adapter_stream');
    expect(client.identity.framework).toBe('openclaw');
  });

  test('GateAction includes CONFIRM (openclaw user-confirm path)', () => {
    const confirm: GateAction = 'CONFIRM';
    const allow: GateAction = 'ALLOW';
    const block: GateAction = 'BLOCK';
    expect(confirm).toBe('CONFIRM');
    expect(allow).toBe('ALLOW');
    expect(block).toBe('BLOCK');
  });

  test('SessionSummaryInput drops hardcoded brand fields (R-X.3)', () => {
    const summary: SessionSummaryInput = {
      sessionId: 'sess-001',
      agentId: 'openclaw-agent-001',
      totalTurns: 5,
      dangerEvents: 0,
      credentialBlocks: 0,
      safetyGateBlocks: 0,
      framework_tag: 'stable',
    };
    expect(Object.prototype.hasOwnProperty.call(summary, 'signal_source')).toBe(false);
  });

  test.each([
    ['before_agent_start', 'before_agent_start'],
    ['before_model_resolve', 'before_model_resolve'],
    ['before_tool_call', 'before_tool_call'],
    ['after_tool_call', 'after_tool_call'],
    ['after_llm', 'after_llm'],
    ['subagent_spawning', 'subagent_spawning'],
    ['session_start', 'session_start'],
    ['session_end', 'session_end'],
  ])('emits valid AgentEvent for %s plugin event', (eventType, hookName) => {
    const ev = openclawAgentEvent(eventType, hookName);
    expect(AgentEventSchema.safeParse(ev).success).toBe(true);
  });

  test('vendor_extensions accepts OpenClaw plugin runtime primitives', () => {
    const ev = openclawAgentEvent('after_llm', 'after_llm');
    ev.vendor_extensions = {
      channel: 'discord',
      plugin_runtime: 'v2026.3.2',
      llm_model: 'gpt-5',
      input_tokens: 2048,
      output_tokens: 768,
      prompt_len: 6400,
      agent_depth: 1,
      parent_agent_id: 'parent-agent-001',
      is_sub_agent: true,
      action_primitive: 'AP-2',
      duration_ms: 850,
    };
    expect(AgentEventSchema.safeParse(ev).success).toBe(true);
  });

  test('rejects content_included: true (content-agnostic invariant)', () => {
    const ev = openclawAgentEvent('after_llm', 'after_llm');
    (ev as unknown as Record<string, unknown>)['content_included'] = true;
    expect(AgentEventSchema.safeParse(ev).success).toBe(false);
  });

  test('5-layer round-trip — subagent_spawn (OpenClaw signature)', () => {
    const agentEvent: AgentEvent = openclawAgentEvent('subagent_spawning', 'subagent_spawning');
    expect(AgentEventSchema.safeParse(agentEvent).success).toBe(true);

    const normalized: NormalizedActionEvent = {
      source_event_ref: agentEvent.raw_event_ref,
      action_type: 'subagent_spawn',
      actor: agentEvent.agent_id,
      target: 'subagent-spawned-001',
      scope: {},
      action_category: 'subagent',
      evidence_ref: 'sha256:subagent-spawn-evidence',
    };
    expect(NormalizedActionEventSchema.safeParse(normalized).success).toBe(true);

    const fact: ObservableFact = {
      fact_type: 'action',
      fact_id: 'fact-openclaw-001',
      agent_id: agentEvent.agent_id,
      contract_id: 'contract-openclaw-001',
      source_vendor: agentEvent.vendor,
      source_surface: agentEvent.host_surface,
      observed_at: agentEvent.timestamp,
      confidence: 0.92,
      provenance: {
        adapter_id: 'openclaw-monitor-001',
        adapter_version: '0.6.0',
        chain_ref: null,
        signature: 'hmac-sha256:openclaw-sig',
      },
      content_agnostic_ref: 'sha256:fact-canonical',
    };
    expect(ObservableFactSchema.safeParse(fact).success).toBe(true);

    const evidence: AxisEvidence = {
      axis: 'meta_control',
      evidence_type: 'observation',
      signal_strength: 0.3,
      direction: 'increase',
      confidence: 0.85,
      reason_code: 'subagent_depth_increase',
      fact_refs: [fact.fact_id],
      axis_status: 'WARN',
      axis_details: 'agent_depth=1, subagent_spawning detected',
    };
    expect(AxisEvidenceSchema.safeParse(evidence).success).toBe(true);

    const pepInput: PEPEvaluationInput = {
      delegation_contract_ref: null,
      current_runtime_mode: 'Caution',
      current_rt: 0.38,
      current_tier: 'T5',
      action_type: 'subagent_spawn',
      action_category: 'subagent',
      authority_scope: 'subagent_orchestration',
      approval_requirement: 'human-required',  // OpenClaw human-confirm path
      risk_level: 'medium',
      fact_refs: [fact.fact_id],
      peer_verifications: [
        {
          peer_node_id: 'peer-openclaw-verifier',
          decision: 'PASS',
          axes_status: {
            cap_within_bounds: 'N/A',
            delegation_receipt_valid: 'N/A',
            expiry_not_passed: 'N/A',
            action_within_scope: 'PASS',
            delegator_authority: 'PASS',
            policy_digest_match: 'PASS',
            rt_within_threshold: 'PASS',
            mode_compatible: 'PASS',
          },
          signature: 'hmac-sha256:peer-openclaw',
          timestamp: agentEvent.timestamp,
        },
      ],
      quorum_rule: 'critical-axis-veto',
    };
    expect(PEPEvaluationInputSchema.safeParse(pepInput).success).toBe(true);
  });
});
