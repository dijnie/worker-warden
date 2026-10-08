import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { SECRET_NAMES, validateSettings } from "../src/environment.ts";

let directory;
try {
  // Build secrets are not runtime bindings. Upload only the seven app secrets;
  // never upload Cloudflare credentials or the rest of the build environment.
  const secrets = Object.fromEntries(SECRET_NAMES.map(name => [name, process.env[name]]));
  validateSettings(secrets);
  directory = mkdtempSync(join(tmpdir(), "worker-warden-secrets-"));
  const file = join(directory, "secrets.json");
  writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
  const result = spawnSync("cf", ["deploy", "--secrets-file", file], { stdio: "inherit" });
  if (result.error) throw new Error("Could not start cf; run npm ci before deploying");
  process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (directory) rmSync(directory, { recursive: true, force: true });
}
