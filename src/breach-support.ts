// =============================================================================
// breach-support.ts — Re-export from @pmatrix/core-sdk (A19-1 extract)
// =============================================================================
// Previously duplicated across 6 SDK as 2 architectural variants. Now unified
// in @pmatrix/core-sdk/breach-support. Persistence (saveState/loadOrCreate/
// deleteState) is opt-in — call them only in SDKs with multi-process hook
// architecture (cc / codex / hermes).
// =============================================================================

export { BreachSupport } from '@pmatrix/core-sdk';
