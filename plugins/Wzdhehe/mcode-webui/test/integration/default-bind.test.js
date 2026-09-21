// webui/test/integration/default-bind.test.js
// v2 security fix (PR #55 review point 2) — live-boot proof that the
// default bind is loopback and that LAN exposure is an explicit opt-in:
//
//   1. no env HOST, no settings.json → server listens on 127.0.0.1
//   2. persisted lanBind:true in settings.json → server listens on 0.0.0.0
//   3. env HOST=0.0.0.0 (explicit deploy config) → respected, zero surprise
//
// Asserts on the real server.js stdout "listening on http://<host>:<port>"
// line — the same signal test/server-startup.test.js gates on.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverJsPath = join(__dirname, "..", "..", "server.js");

function pickPort() {
  // 19700..19799 — disjoint from router-boot (19500s) and C08 (18080s)
  return 19700 + Math.floor(Math.random() * 100);
}

// Spawn server.js; resolve with the captured stdout once it prints the
// listening line (or reject after 4s). envOverrides may set/clear HOST;
// settingsJson may pre-write the isolated settings file.
function bootOnce({ envOverrides = {}, settingsJson } = {}) {
  const tmpDir = mkdtempSync(join(tmpdir(), "mcode-webui-bind-"));
  const port = pickPort();
  const env = {
    ...process.env,
    PORT: String(port),
    MCODE_WEBUI_SETTINGS_PATH: join(tmpDir, "settings.json"),
    MCODE_WEBUI_EVENTS_PATH: join(tmpDir, "events.ndjson"),
    MCODE_WEBUI_UPLOAD_DIR: join(tmpDir, "uploads"),
    MCODE_WEBUI_SESSIONS_DB: join(tmpDir, "sessions.json"),
    TOKEN: "",
    MCODE_WEBUI_TOKEN_STDOUT: "0",
    ...envOverrides,
  };
  delete env.HOST; // default unless an override re-adds it
  if (envOverrides.HOST !== undefined) env.HOST = envOverrides.HOST;
  if (settingsJson !== undefined) {
    writeFileSync(env.MCODE_WEBUI_SETTINGS_PATH, JSON.stringify(settingsJson), "utf8");
  }
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [serverJsPath], {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: join(__dirname, "..", ".."),
      env,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      reject(new Error(`no listening line within 4s. stdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 4000);
    const onChunk = () => {
      if (/listening on/.test(stdout)) {
        clearTimeout(timer);
        proc.kill("SIGTERM");
        resolve({ stdout, port });
      }
    };
    proc.stdout.on("data", onChunk);
    proc.on("exit", () => {
      clearTimeout(timer);
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

test("default bind: no env HOST + no settings file → listening on 127.0.0.1", async () => {
  const { stdout, port } = await bootOnce();
  assert.match(
    stdout,
    new RegExp(`listening on http://127\\.0\\.0\\.1:${port}`),
    `default bind must be loopback (PR #55 review point 2). stdout:\n${stdout}`,
  );
});

test("LAN opt-in: persisted lanBind:true → listening on 0.0.0.0", async () => {
  const { stdout, port } = await bootOnce({ settingsJson: { lanBind: true } });
  assert.match(
    stdout,
    new RegExp(`listening on http://0\\.0\\.0\\.0:${port}`),
    `persisted lanBind opt-in must bind all interfaces. stdout:\n${stdout}`,
  );
});

test("explicit env HOST=0.0.0.0 keeps winning over the persisted setting", async () => {
  // lanBind:false on disk + env HOST set → env must own the bind.
  const { stdout, port } = await bootOnce({
    envOverrides: { HOST: "0.0.0.0" },
    settingsJson: { lanBind: false },
  });
  assert.match(
    stdout,
    new RegExp(`listening on http://0\\.0\\.0\\.0:${port}`),
    `explicit deploy config must be respected (upgrading users zero surprise). stdout:\n${stdout}`,
  );
});
