import assert from "node:assert/strict";
import { test } from "node:test";
import { containerEnvironment, forwardRequest, validateSettings } from "../src/environment.ts";

const settings = {
  DATABASE_URL: "postgresql://warden:p%40ss@db.example.com:5432/vaultwarden?sslmode=require",
  DOMAIN: "https://vault.example.com",
  R2_BUCKET: "warden-test-data",
  R2_ENDPOINT: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
  AWS_ACCESS_KEY_ID: "example-access-key",
  AWS_SECRET_ACCESS_KEY: "example-secret-key",
  ADMIN_TOKEN: "example-random-admin-token-at-least-32-characters",
};

test("rejects incomplete configuration without echoing credentials", () => {
  assert.throws(() => validateSettings({ ...settings, DATABASE_URL: "password-that-must-not-be-logged" }),
    { message: "Invalid DATABASE_URL" });
  assert.throws(() => validateSettings({ ...settings, AWS_SECRET_ACCESS_KEY: "REPLACE_ME" }),
    { message: "Missing or invalid AWS_SECRET_ACCESS_KEY" });
});

test("requires PostgreSQL and encrypted database transport", () => {
  for (const database of ["sqlite:///data/db.sqlite3", "mysql://u:p@db.example.com/vault", "postgres://u:p@db.example.com/vault?sslmode=disable"]) {
    assert.throws(() => validateSettings({ ...settings, DATABASE_URL: database }));
  }
  validateSettings({ ...settings, DATABASE_URL: settings.DATABASE_URL.replace("require", "verify-full") });
});

test("rejects an ambiguous public origin or non-R2 storage endpoint", () => {
  for (const domain of ["http://vault.example.com", "https://vault.example.com/prefix", "https://user:pass@vault.example.com"]) {
    assert.throws(() => validateSettings({ ...settings, DOMAIN: domain }));
  }
  assert.throws(() => validateSettings({ ...settings, R2_ENDPOINT: "https://not-r2.example.com" }));
});

test("persists the whole data directory on R2 with compatible S3 settings", () => {
  const env = containerEnvironment(settings);
  const data = new URL(env.DATA_FOLDER);
  assert.equal(data.protocol, "s3:");
  assert.equal(data.hostname, settings.R2_BUCKET);
  assert.equal(data.pathname, "/vaultwarden");
  assert.equal(data.searchParams.get("endpoint"), settings.R2_ENDPOINT);
  assert.equal(data.searchParams.get("region"), "auto");
  assert.equal(data.searchParams.get("enable_virtual_host_style"), "false");
  assert.equal(data.searchParams.get("default_storage_class"), "STANDARD");
  assert.equal(env.DATABASE_URL, settings.DATABASE_URL);
  assert.equal(env.SIGNUPS_ALLOWED, "false");
  assert.equal(env.DATABASE_MAX_CONNS, "7");
  assert.ok(!env.DATA_FOLDER.includes(settings.AWS_SECRET_ACCESS_KEY));
  assert.ok(!("I_REALLY_WANT_VOLATILE_STORAGE" in env));
});

test("forwards encrypted uploads without changing path, query, auth or content", async () => {
  const source = new Request("https://vault.example.com/api/ciphers/item/attachment?token=opaque", {
    method: "POST", body: "encrypted-content", headers: { authorization: "Bearer opaque", "content-type": "application/octet-stream" },
  });
  const forwarded = forwardRequest(source, settings.DOMAIN);
  assert.equal(forwarded.url, "http://container/api/ciphers/item/attachment?token=opaque");
  assert.equal(forwarded.method, "POST");
  assert.equal(forwarded.headers.get("authorization"), "Bearer opaque");
  assert.equal(await forwarded.text(), "encrypted-content");
});

test("replaces spoofed forwarding headers with the Cloudflare client address", () => {
  const source = new Request(settings.DOMAIN, { headers: {
    "cf-connecting-ip": "203.0.113.4", "x-real-ip": "spoofed", "x-forwarded-for": "spoofed",
    "x-forwarded-host": "spoofed", "x-forwarded-proto": "http", "forwarded": "for=spoofed",
  } });
  const headers = forwardRequest(source, settings.DOMAIN).headers;
  assert.equal(headers.get("x-real-ip"), "203.0.113.4");
  assert.equal(headers.get("x-forwarded-host"), "vault.example.com");
  assert.equal(headers.get("x-forwarded-proto"), "https");
  assert.equal(headers.get("x-forwarded-for"), null);
  assert.equal(headers.get("forwarded"), null);
});

test("preserves the Bitwarden notification WebSocket handshake", () => {
  const source = new Request(`${settings.DOMAIN}/notifications/hub?access_token=opaque`, { headers: {
    upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": "example", "sec-websocket-version": "13",
  } });
  const forwarded = forwardRequest(source, settings.DOMAIN);
  assert.equal(forwarded.headers.get("upgrade"), "websocket");
  assert.equal(forwarded.headers.get("sec-websocket-key"), "example");
  assert.equal(new URL(forwarded.url).searchParams.get("access_token"), "opaque");
});
