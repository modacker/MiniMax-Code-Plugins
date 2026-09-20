# mcode-webui CI

This document explains the continuous-integration pipeline that backs the
mcode-webui plugin. It exists so a future contributor can:

1. Read what each CI job does and why it exists.
2. Reproduce the same checks locally before opening a PR.
3. Diagnose a red CI run by following the failure path back to the
   script it exercises.

The pipeline is defined in `.github/workflows/ci.yml` and has three
jobs. It implements **criterion 5 (reproducibility — lockfile + SBOM +
CVE)** and **criterion 6 (testability — CI matrix)** from the refactor
plan's acceptance ledger. Lease `C02` is the canonical owner.

## High-level matrix

| Job | Node | OS | Runs | Purpose |
|---|---|---|---|---|
| `lint-and-format` | 22, 24 | macOS, Linux, Windows | 6 | Cross-version cross-OS install + check + test |
| `smoke-test` | 22 | macOS | 1 | Boots the HTTP server, hits `/api/health`, kills it |
| `sbom` | 22 | Linux | 1 | Generates `sbom.cdx.json`, gates on `npm audit` |

The matrix combines to **8 CI runs per push / PR** — six from the lint
job plus the two single-platform jobs.

## Job 1 — `lint-and-format`

Stresses the install + check + test pipeline across every supported
runtime combination.

```
┌────────────────┐
│ actions/checkout│
├────────────────┤
│ setup-node (22)│   ← matrix.node-version
│ setup-node (24)│
├────────────────┤
│ cache ~/.npm   │   ← keyed on package-lock.json hash
├────────────────┤
│ npm ci --no-audit│ ← lockfile-driven install (criterion 5)
├────────────────┤
│ npm run check  │   ← scripts/check-docs-alignment.mjs
├────────────────┤
│ npm test       │   ← node --test test/*.test.js
└────────────────┘
```

### What each step guarantees

- **`npm ci`** — uses the exact versions recorded in
  `package-lock.json`. If the lockfile is out of sync with
  `package.json`, this step errors out instead of silently widening
  the version range. This is the **reproducibility** spine.
- **`npm run check`** — runs `scripts/check-docs-alignment.mjs`
  (delivered by lease B05). Asserts that:
  - every capability in `plugin.json` appears in `README.md` and
    `docs/CAPABILITIES.md`,
  - every endpoint documented in `README.md` and `docs/API.md` is
    actually wired up in `server/router.js`,
  - every env var documented in `references/SECURITY-NOTES.md` is
    exported by `server/lib/config.js`,
  - `plugin.json` round-trips as valid JSON and each capability
    carries a `description` field (≥ 30 chars),
  - the §AP11 known-drift endpoint (`cleanup-orphans`) is consistent.
- **`npm test`** — runs `node --test test/*.test.js`. CI uses
  `--experimental-test-module-mocks` to keep parity with the local
  invocation (Node 22 ≥ 22.19 supports it by default).

## Job 2 — `smoke-test`

The unit test suite exercises pure logic. It does **not** confirm
that `node server.js` actually boots, listens, or responds over a
real TCP socket. Job 2 fills that gap with a thin shell pipeline:

```
nohup npm start > smoke.log 2>&1 &  # background
sleep 5                             # boot window
curl /api/health                    # smoke check
kill $pid                           # teardown
```

The `/api/health` endpoint is the canonical probe because it does not
require authentication and ships a 200 response on a healthy
bootstrap.

### Why only one combination

A 6-way matrix of `nohup` + `sleep` + `curl` + `kill` would add 5
boots per push without discovering any cross-platform regression that
the `lint-and-format` matrix doesn't already catch. The
`lint-and-format` job is sufficient to flush out cross-OS install
path issues; `smoke-test` only needs to verify that the runtime
listens.

### Local reproduction

```bash
PORT=31877 HOST=127.0.0.1 TOKEN=dummy nohup npm start > smoke.log 2>&1 &
echo $! > smoke.pid
sleep 5
curl -v http://127.0.0.1:31877/api/health
kill $(cat smoke.pid) || true
```

## Job 3 — `sbom`

Generates the CycloneDX 1.5 SBOM and gates the build on CVE-free
production dependencies. Single combination (Node 22 / Linux) because
the SBOM is a function only of the lockfile and `node_modules/`.

```
npm ci            ← install (idempotent with the lockfile)
npm audit ...     ← CVE gate (§5 reproducibility)
npm run sbom      ← scripts/gen-sbom.mjs → sbom.cdx.json
node -e require() ← round-trip parse to fail loudly on malformed output
upload-artifact   ← persists sbom.cdx.json as a build artifact
```

### CycloneDX schema

The output is JSON, `bomFormat: "CycloneDX"`, `specVersion: "1.5"`,
with two distinguishing fields:

- `metadata.component` — the root `mcode-webui` application.
- `components[]` — every entry under `node_modules/<pkg>/` (115
  packages in the current tree), each with `name`, `version`,
  `licenses`, `hashes` (SHA-512 over the on-disk `package.json`),
  and a `purl` of the form `pkg:npm/<name>@<version>`.

`scripts/gen-sbom.mjs` is zero-dep — it uses only `node:fs`,
`node:crypto`, and `node:url`/`node:path`. Reproducibility is
therefore a function of the on-disk tree alone; no `npm` call is
required at SBOM-generation time.

### CVE gate and the waiver file

`npm audit --omit=dev --audit-level=low` is the gate. Production
dependencies are not eligible for waiver — mcode-webui ships **zero**
runtime dependencies by design (`engines.locked` deps are all dev
tooling), so a non-zero exit is treated as a hard failure.

If a transitive **dev** dependency gains a CVE that we cannot
immediately upgrade (for example, waiting on an upstream fix), the
waiver mechanism is `.cve-ignore.json`. Each waiver entry must
carry:

- `advisory_id` — GHSA-… or CVE-… identifier from `npm audit`,
- `waived_until` — ISO date 30 days from when the waiver was filed,
- `reason` — short human note ("waiting on upstream
  `<upstream-issue>`", "local mirror divergence", etc.).

The gate intentionally ignores transitive dev CVEs — that's the
purpose of the waiver file. **Production-runtime CVEs
(artifacts of adding to `dependencies`) are not waivable; the gate
fails the build on any non-empty production audit.**

## Operating the pipeline

### Triggering it manually

```bash
gh workflow run ci.yml
```

Or open the GitHub Actions tab and click **Run workflow** on the
desired branch.

### Reproducing locally

```bash
# Step 1: install (lockfile-driven)
npm ci

# Step 2: run the docs alignment check
npm run check

# Step 3: run the unit tests
npm test

# Step 4: boot the server and probe it
PORT=31877 HOST=127.0.0.1 TOKEN=dummy npm start &
sleep 5
curl http://127.0.0.1:31877/api/health
kill %1 || true

# Step 5: regenerate the SBOM
npm run sbom
ls sbom.cdx.json
```

### Adding a new dependency

1. Add it to `dependencies` or `devDependencies` in `package.json`,
   **then** run `npm install` locally to regenerate `package-lock.json`.
2. Do **not** commit only `package.json` — both files must move
   together. `npm ci` will error out otherwise.
3. If you added a **runtime** dep, the CVE gate is now stricter.
   Check `npm audit --omit=dev` before opening the PR.

### When CI is red

| Failing step | Likely cause | Direction |
|---|---|---|
| `npm ci` | `package.json` and `package-lock.json` drift | Run `npm install` locally and commit both files together |
| `npm run check` | Docs / code drift — see B05 task report | Read the offending check in `scripts/check-docs-alignment.mjs` and reconcile |
| `npm test` | Unit test regression | Run `node --experimental-test-module-mocks --test test/<name>.test.js` locally |
| `Smoke-test GET /api/health` | Server does not boot, or `/api/health` is missing | `npm start` locally, check `[webui] listening on ...` log |
| `CVE gate` | Production-dep transitive CVE | Investigate upstream; production CVEs are not waivable |
| `Generate CycloneDX SBOM` | Manifest missing or malformed | Run `node scripts/gen-sbom.mjs` locally; check `package.json` |
| `Validate SBOM round-trip parse` | `sbom.cdx.json` incomplete or malformed | Same as above |

## Relationship to the refactor plan

This pipeline implements two acceptance criteria from
`SiHankor/.tmp/mcode-webui-refactor/PLAN-webui-v2-refactor.DRAFT.md`:

- **Criterion 5 — Reproducibility (lockfile + SBOM + CVE):** `npm ci`
  pins the install. `sbom` job walks `node_modules/` after
  `npm ci`, emits CycloneDX 1.5, and gates on a production-only
  `npm audit`. The CVE waiver file is `.cve-ignore.json`.
- **Criterion 6 — Testability (CI matrix):** `lint-and-format`
  exercises `npm ci` → `npm run check` → `npm test` across Node 22 /
  24 × macOS / Linux / Windows (6 runs). `smoke-test` adds a single
  runtime-bootstrapping run for HTTP-level coverage.

Both criteria feed the §AP11 "docs/code drift can never silently
regress" anti-pattern guard that the `scripts/check-docs-alignment.mjs`
script from lease B05 enforces.

## Versioning

The workflow itself does not auto-bump. When the matrix is updated
(new Node, new OS) it is a substantive change to criterion 6 and
should be accompanied by an update to this document and to lease
C02's task report. The waiver file has a 30-day ceiling; any
extension requires a fresh entry plus a one-line explanation of why
the upstream fix is still pending.
