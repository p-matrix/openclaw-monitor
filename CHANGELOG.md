# Changelog

All notable changes to `@pmatrix/openclaw-monitor` will be documented in this file.

---

## [0.6.1] — 2026-05-21

### Changed

- **Migrate to `@pmatrix/core-sdk@^0.1.0`** — `PMatrixHttpClient` 와 공통 schema (5-layer Agent Host-Integration Adapter Contract v0.1)를 `@pmatrix/core-sdk` 로 위임. SDK 자체 substance 큰 폭 감소, API surface 변경 0 (consumer 영향 없음).

### Note (A19-2 partial application — honesty disclosure)

- A19-2 (credential-scanner core-sdk extract)는 **부분 적용**. openclaw는 자체 `src/credential-scanner.ts`를 보존 (vendor-specific surface divergence). Cross-SDK 일관성보다 openclaw vendor-specific behavior 우선. 차후 cycle에서 재평가 영역.

### Verification

- Fresh install: `node_modules/@pmatrix/core-sdk` 가 registry tarball 추출 confirmed (symlink=false / version=0.1.0)
- Tests: 507 PASS, regression 0 (R-X.4 lockstep verify, monorepo commit `d1a6d08`)

### Lockstep §6.3 v0.2

- `@pmatrix/core-sdk` 의존성을 caret range `^0.1.0` 으로 declared. Core SDK major bump 시 6 adapter SDK 동시 major bump 의무.

---

## [0.6.0] — 2026-04-27

### Added (Cross-cutting client 보강 — server Production Polish 정합)

- **Cross-cutting A — Error correlation logging**: HTTP 5xx 응답 body 의
  `error_id` 추출 (header `X-Error-ID` fallback) → stderr 안내 메시지
  ("Support 문의 시 Error ID 함께 제공해 주세요"). server Production
  Polish A error UX (commit `08a27e3`) 정합.
- **Cross-cutting B — X-Request-ID 헤더**: outgoing request 마다
  `crypto.randomUUID()` 송출 + response echo trace
  (`PMATRIX_DEBUG_TRACE=1` 시만 stderr). server middleware
  (commit `533781f` `app/middleware/request_id.py`) 정합.
- **Cross-cutting C — Burst 429 handling**: HTTP 429 응답 시 신규
  `BurstRateError` throw → `fetchWithRetry` 가 `Retry-After` 헤더 우선
  + escalating backoff (`BURST_RETRY_DELAYS = [1s, 5s, 30s]`). 일반
  retry budget 내에서 재시도, 최종 fail 시 기존 `backupToLocal` 경로.
  server `app/middleware/burst_rate_limit.py` (`BURST_RATE_PER_SEC=20`,
  Redis ZSET sliding window) 정합.

### Notes

- Spec public contract 변경 없음 — outgoing 헤더 + stderr 로깅 + 재시도
  schedule 만 추가.
- 기존 18 test suite (cost-tracker, safety-gate, credential-scanner,
  drift, autonomy 등) 그대로 유지. cross-cutting 동작은 잠재적 별도
  test 추가 가능 (현 사이클은 plugin test 0건 추가, regression 의존).

---

## [0.5.0] — 2026-04-27

### Changed (BREAKING — Mode literal rename)

- **Phase R-5 Mode naming Gen1 → Gen2 names** (server-side parity per Spec §❷):
  `'A+1'` → `'normal'` / `'A+0'` → `'caution'` / `'A-1'` → `'alert'` /
  `'A-2'` → `'critical'` / `'A-0'` → `'halt'`
- **Affected APIs**: `SafetyMode` union type (`src/types.ts`), `rtToMode()`
  return values + Safety Gate matrix mode comparisons (`src/safety-gate.ts`),
  session-state defaults, UI formatter mode display (`src/ui/formatter.ts`),
  4 test fixture files (37 occurrences)
- **Migration**: consumers must update mode string comparisons
  (`mode === 'A-0'` → `mode === 'halt'` 등). Server protocol output 도
  Gen2 names 로 통합 (Backend Spec v1.53)

### Fixed (Phase R-6 SDK build hygiene)

- **breach-support.ts**: `getApprovalStatus()` 의 `noUncheckedIndexedAccess`
  TypeScript narrowing 부재 → `Object is possibly 'undefined'` 3건 fix
  (explicit local const + null check pattern). 18 test suites + 493 tests
  PASS (이전 13 suites compile failed)
- **field-node-runtime dependency**: `node_modules/@pmatrix/field-node-runtime`
  symlink 정합 (`npm install` 로 npm registry 0.2.0 정상 fetch)

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
