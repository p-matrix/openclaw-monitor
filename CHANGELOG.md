# Changelog

All notable changes to `@pmatrix/openclaw-monitor` will be documented in this file.

---

## [0.3.4] — 2026-03-11

### Fixed

- `clamp01()` NaN/Infinity guard in session-state
- `framework_tag` hardcode → config-driven
- `|| undefined` → `?? undefined` (preserves valid zero values)
- Credential scanner: 11 → 16 patterns (synced with CC/Cursor monitors)
- Safety Gate: HIGH_RISK_TOOLS +3, MEDIUM_RISK_TOOLS +3, check order fix
- All-zero payload guard: `{0,0,0,0}` → `{0.5,0.5,0.5,0.5}` neutral

## [0.3.0] — 2026-03-07

### Added

- Safety Gate (PreToolUse deny) with 3-tier tool risk classification
- Kill Switch (auto-halt on R(t) threshold)
- Credential Scanner (16 pattern types)
- Session lifecycle management (SessionStart/End)
- Batch signal sender with retry + local backup

## [0.1.0] — 2026-02-28

### Added

- Initial release — OpenClaw plugin runtime monitoring
