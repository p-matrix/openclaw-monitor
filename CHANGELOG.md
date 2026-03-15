# Changelog

All notable changes to `@pmatrix/openclaw-monitor` will be documented in this file.

---

## [0.4.0] — 2026-03-15

### Added

- **4.0 Field Integration** — FieldNode in-process 연동, 실측 4축 State Vector 전송
- ACP Provenance sessionKey fallback (upstream 2026-03-13 대응)
- sessionTarget 인식 — cron-bound 세션 stale skip 방어

### Changed

- `@pmatrix/field-node-runtime@^0.2.0` 의존성 추가
- FieldNode 생성 try/catch fail-open (3.5 모니터링 보호)

## [0.3.5] — 2026-03-13

### Fixed

- Credential scanner: 16 patterns (synced with CC/Cursor)
- Safety Gate check order fix
- framework_tag config-driven

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
