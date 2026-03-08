# @pmatrix/openclaw-monitor

Runtime safety governance plugin for OpenClaw — **active intervention, not just logging.**

Blocks dangerous tool calls before execution, detects credential leaks in outgoing messages, and continuously measures agent risk with live Trust Grade (A–E).

> Early Access — Requires a P-MATRIX account and API key.

---

## What it does

### Core Protection

- **Safety Gate** — Intercepts high-risk tool calls before execution.
  Blocks or prompts for confirmation based on current risk level R(t).
- **Credential Protection** — Detects and blocks 11 types of API keys
  and secrets before they leave the agent.
- **Kill Switch** — Automatically halts the agent when R(t) ≥ 0.75.
  Manually via `/pmatrix halt`.

### Behavioral Intelligence

- **Autonomy Escalation** — Detects consecutive tool calls without
  user intervention. Applies norm penalty (-0.10).
- **Chain-Risk Detection** — Identifies dangerous tool call sequences
  (e.g., READ → WRITE → EXEC). Applies norm penalty (-0.05).
- **Drift Detection** — Compares per-turn behavioral snapshots and
  flags significant deviations. Adjusts stability axis accordingly.
- **Subagent Explosion Detection** — Blocks runaway subagent spawning
  (5+ in 5 minutes).
- **Live Grade** — Streams 4-axis safety signals and displays Trust
  Grade (A–E) in real time.

---

## Requirements

| Requirement | Version |
|-------------|---------|
| Node.js | ≥ 22 |
| P-MATRIX server | v1.0.0+ |

---

## Installation

```bash
openclaw plugins install @pmatrix/openclaw-monitor
```

Set up your API key:

```bash
npx @pmatrix/openclaw-monitor setup
```

Start the gateway:

```bash
openclaw gateway
```

---

### Privacy

**🔒 Content-Agnostic:** P-MATRIX never collects, parses, or stores
your LLM prompts or responses.

When data sharing is enabled, we only transmit numerical metadata —
token counts, timing, tool names, and safety events. Your agent's
prompt and response content stays local.

Pattern-based instant blocks (sudo, rm -rf, curl|sh) and credential
scanning run entirely on-device with no network dependency.

---

### Advanced Configuration

For full control, edit `~/.pmatrix/config.json` (created by the setup command):

```json
{
  "serverUrl": "https://api.pmatrix.io",
  "agentId": "oc_YOUR_AGENT_ID",
  "apiKey": "pm_live_xxxxxxxxxxxx",

  "safetyGate": {
    "enabled": true,
    "confirmTimeoutMs": 20000,
    "serverTimeoutMs": 2500
  },

  "credentialProtection": {
    "enabled": true,
    "blockTranscript": true,
    "customPatterns": []
  },

  "killSwitch": {
    "autoHaltOnRt": 0.75,
    "safeModel": "claude-opus-4-6"
  },

  "dataSharing": false,

  "batch": {
    "maxSize": 10,
    "flushIntervalMs": 2000,
    "retryMax": 3
  },

  "debug": false
}
```

Or set your API key as an environment variable:

```bash
export PMATRIX_API_KEY=pm_live_xxxxxxxxxxxx
```

---

## Chat Commands

| Command | Description |
|---------|-------------|
| `/pmatrix status` | Show current Grade, R(t), and 4-axis breakdown |
| `/pmatrix halt` | Manually trigger Kill Switch |
| `/pmatrix resume` | Resume from Halt state |
| `/pmatrix allow once` | Allow a pending Safety Gate confirmation |
| `/pmatrix help` | Show command list |

---

## Safety Gate

The Safety Gate intercepts tool calls before execution and evaluates them against the current risk level R(t):

| Risk Level | Mode | HIGH-risk tool | MEDIUM-risk tool | LOW-risk tool |
|-----------|------|---------------|-----------------|--------------|
| < 0.15 | Normal | Allow | Allow | Allow |
| 0.15–0.30 | Caution | **Confirm** | Allow | Allow |
| 0.30–0.50 | Alert | **Confirm** | Allow | Allow |
| 0.50–0.75 | Critical | **Block** | **Confirm** | Allow |
| ≥ 0.75 | Halt | **Block** | **Block** | **Block** |

**HIGH-risk tools** (auto-classified): `exec`, `bash`, `shell`, `run`, `apply_patch`, `browser`, `computer`, `terminal`, `code_interpreter`

**MEDIUM-risk tools**: `web_fetch`, `http_request`, `fetch`, `request`, `curl`, `wget`

**LOW-risk tools** (prefix match): `file_read`, `list_files`, `search`, `read`, `glob`, `grep`, and common read-only commands (`ls`, `find`, `cat`, `head`, `tail`)

> Unknown tools default to **MEDIUM** risk as a conservative baseline.
> Use `safetyGate.customToolRisk` to override.

**Instant block rules** (regardless of R(t)):
- `sudo` / `chmod 777` — privilege escalation
- `rm -rf /` — destructive deletion
- `curl ... | sh` — remote code execution

> **Note:** Instant block rules (sudo, rm -rf, curl|sh) are enforced
> independently of the Safety Gate setting. Even with
> `safetyGate.enabled: false`, these rules remain active.

When a tool requires confirmation, the agent pauses and prompts:
```
⚠️ [P-MATRIX] Safety Gate — Confirmation Required
Tool: bash | Risk: HIGH | Mode: Caution (R(t)=0.22)
👉 To allow: /pmatrix allow once
Timeout: auto-block after 20s
```

---

## Credential Protection

Detects and blocks 11 credential types before they are sent:

- OpenAI API keys (`sk-proj-...`)
- Anthropic API keys (`sk-ant-...`)
- AWS Access Keys (`AKIA...`)
- GitHub tokens (`ghp_...`, `github_pat_...`)
- Private keys (`-----BEGIN PRIVATE KEY-----`)
- Database URLs (`postgresql://user:pass@...`)
- Passwords (`password: "..."`)
- Bearer tokens
- Google AI keys (`AIza...`)
- Stripe keys (`sk_live_...`, `sk_test_...`)

Code blocks in messages are excluded from scanning to prevent false positives.

---

## Autonomy Escalation

Tracks consecutive tool calls within a single turn without user interaction. When the count exceeds the threshold (default: 5), the plugin:

1. Applies a `norm` penalty (-0.10 per event)
2. Emits an `autonomy_escalation` signal to the server
3. Logs a warning in the agent console

This prevents agents from executing long chains of actions autonomously without human oversight.

---

## Chain-Risk Detection

Monitors tool call sequences for dangerous patterns:

| Pattern | Example | Risk |
|---------|---------|------|
| `READ_WRITE_EXEC` | read file → write file → bash | Data exfiltration |
| `READ_EXEC` | read file → bash | Direct execution after read |
| `WRITE_EXEC` | write file → bash | Execute after file modification |

When a pattern is matched:
- `norm` axis receives a penalty (-0.05)
- A `chain_risk_detected` signal is emitted with the matched pattern name
- The agent console displays a warning

---

## Drift Detection

At each turn boundary (`agent_end`), the plugin captures a behavioral snapshot (axes values, tool usage, duration) and compares it against the previous turn:

| Drift Level | Score Threshold | Stability Delta |
|-------------|-----------------|-----------------|
| Moderate | ≥ 0.5 | +0.05 |
| Significant | ≥ 1.0 | +0.10 |

Higher `stability` values indicate more drift (lower safety). When drift is detected, a `drift_detected` signal is emitted with the drift score and level.

---

## R(t) Formula

```
R(t) = 1 - (BASELINE + NORM + (1 - STABILITY) + META_CONTROL) / 4
```

| Axis | Field | Meaning |
|------|-------|---------|
| BASELINE | `baseline` | Initial config integrity — higher = safer |
| NORM | `norm` | Behavioral normalcy — higher = safer |
| STABILITY | `stability` | Trajectory stability — lower = more drift |
| META_CONTROL | `meta_control` | Self-control capacity — higher = safer |

P-Score = `round(100 × (1 - R(t)), 2)`
Trust Grade: A (≥80) · B (≥60) · C (≥40) · D (≥20) · E (<20)

---

## Server-side Setup

The plugin sends signals to `POST /v1/inspect/stream` on your P-MATRIX server.

Production server: `https://api.pmatrix.io`

---

## Configuration Reference

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `serverUrl` | string | — | P-MATRIX server URL |
| `agentId` | string | — | Agent ID from P-MATRIX dashboard |
| `apiKey` | string | — | API key (`pm_live_...`). Use env var. |
| `safetyGate.enabled` | boolean | `true` | Enable Safety Gate |
| `safetyGate.confirmTimeoutMs` | number | `20000` | User confirm timeout (10,000–30,000ms) |
| `safetyGate.serverTimeoutMs` | number | `2500` | Server query timeout (fail-open) |
| `safetyGate.customToolRisk` | object | `{}` | Override tool risk tier |
| `credentialProtection.enabled` | boolean | `true` | Enable credential scanning |
| `credentialProtection.blockTranscript` | boolean | `true` | Also block transcript writes |
| `credentialProtection.customPatterns` | string[] | `[]` | Additional regex patterns |
| `killSwitch.autoHaltOnRt` | number | `0.75` | Auto-halt R(t) threshold |
| `killSwitch.safeModel` | string | `"claude-opus-4-6"` | Model to switch to on Halt |
| `dataSharing` | boolean | `false` | Send safety signals to P-MATRIX server (opt-in). When false, instant block rules (sudo, rm -rf, curl\|sh) and credential scanning still work fully locally. However, R(t)-based Safety Gate decisions use the last known server value (or 0.0 if never connected) — grade tracking and dashboard are disabled. Run `npx @pmatrix/openclaw-monitor setup` to enable live grading and adaptive Safety Gate. Prompts and responses are never transmitted regardless of this setting. |
| `outboundAllowlist.enabled` | boolean | `false` | Enable outbound message allowlist |
| `outboundAllowlist.allowedChannels` | string[] | `[]` | Permitted outbound channels (e.g. `"slack:#ops"`) |
| `batch.maxSize` | number | `10` | Buffer flush threshold |
| `batch.flushIntervalMs` | number | `2000` | Periodic flush interval (ms) |
| `batch.retryMax` | number | `3` | Send retry count |
| `debug` | boolean | `false` | Verbose logging |

---

## Offline / Server-Down Behavior

- **No cache (initial)**: R(t) = 0.0 (fail-open, no blocking before first connection)
- **Cache exists + server down**: Last known R(t) is kept indefinitely — Safety Gate continues using it
- Failed signals are saved to `~/.pmatrix/unsent/` and can be replayed later

---

## License

Apache-2.0 © 2026 P-MATRIX
