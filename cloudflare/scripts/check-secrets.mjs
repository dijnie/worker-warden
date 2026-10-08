import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateSettings } from "../src/environment.ts";

try {
  const path = resolve(process.argv[2] ?? ".secrets.json");
  const contents = readFileSync(path, "utf8");
  let secrets;
  try { secrets = JSON.parse(contents); } catch { throw new Error("Secrets file must contain valid JSON"); }
  validateSettings(secrets);
  console.log("Secret configuration is valid; values were not printed.");
} catch (error) {
  console.error(error.code === "ENOENT" ? "Create .secrets.json from .secrets.json.example first." : error.message);
  process.exitCode = 1;
}
