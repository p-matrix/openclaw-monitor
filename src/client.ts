// =============================================================================
// @pmatrix/openclaw-monitor — client.ts
// =============================================================================
// R-X.3 migration: PMatrixHttpClient extracted to @pmatrix/core-sdk v0.1.0.
// Thin OpenClaw-bound wrapper pre-supplying AdapterIdentity.
//
// OpenClaw is unique: signal_source uses 'adapter_stream' pattern (not '*_hook')
// because OpenClaw runs as a plugin runtime, not a CLI hook lifecycle.
// =============================================================================

import { PMatrixHttpClient as CorePMatrixHttpClient } from '@pmatrix/core-sdk';
import type {
  AdapterIdentity,
  PMatrixConfig,
} from '@pmatrix/core-sdk';

export type { SessionSummaryInput } from '@pmatrix/core-sdk';

const OPENCLAW_IDENTITY: AdapterIdentity = Object.freeze({
  signalSource: 'adapter_stream',
  framework: 'openclaw',
});

export class PMatrixHttpClient extends CorePMatrixHttpClient {
  constructor(config: PMatrixConfig) {
    super(config, OPENCLAW_IDENTITY);
  }
}
