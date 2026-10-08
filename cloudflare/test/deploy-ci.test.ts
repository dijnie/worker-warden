import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { spawnSync } from "node:child_process";
import { SECRET_NAMES } from "../src/environment.ts";

const settings = {
  DATABASE_URL: "postgresql://warden:test-only-password@db.example.com/vaultwarden?sslmode=require",
  DOMAIN: "https://vault.example.com",
  R2_BUCKET: "test-warden-data",
  R2_ENDPOINT: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
  AWS_ACCESS_KEY_ID: "test-access-key",
  AWS_SECRET_ACCESS_KEY: "test-secret-key",
  ADMIN_TOKEN: "test-random-token-with-at-least-32-characters",
};

for (const exitCode of [0, 23]) {
  test(`web deploy uploads only app secrets and cleans up after exit ${exitCode}`, () => {
    const folder = mkdtempSync(join(tmpdir(), "warden-ci-test-"));
    try {
      const record = join(folder, "result.json");
      writeFileSync(join(folder, "cf"), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const file = args[2];
fs.writeFileSync(process.env.TEST_RECORD, JSON.stringify({ args, file,
  mode: fs.statSync(file).mode & 0o777, secrets: JSON.parse(fs.readFileSync(file, 'utf8')) }));
process.exit(Number(process.env.TEST_EXIT));
`, { mode: 0o700 });
      const result = spawnSync(process.execPath, ["scripts/deploy-ci.mjs"], {
        encoding: "utf8",
        env: { ...process.env, ...settings, CLOUDFLARE_API_TOKEN: "cloudflare-test-token",
          PATH: `${folder}${delimiter}${process.env.PATH}`, TEST_RECORD: record, TEST_EXIT: String(exitCode) },
      });
      assert.equal(result.status, exitCode, result.stderr);
      const captured = JSON.parse(readFileSync(record, "utf8"));
      assert.deepEqual(captured.args.slice(0, 2), ["deploy", "--secrets-file"]);
      assert.deepEqual(Object.keys(captured.secrets).sort(), [...SECRET_NAMES].sort());
      assert.deepEqual(captured.secrets, settings);
      assert.equal(captured.mode, 0o600);
      assert.equal(existsSync(captured.file), false);
      for (const value of [...Object.values(settings), "cloudflare-test-token"]) {
        assert.ok(!(result.stdout + result.stderr).includes(value));
      }
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });
}

test("web deploy rejects missing build secrets before invoking cf", () => {
  const result = spawnSync(process.execPath, ["scripts/deploy-ci.mjs"], {
    encoding: "utf8", env: { ...process.env, ...settings, DATABASE_URL: "" },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing or invalid DATABASE_URL/);
});
