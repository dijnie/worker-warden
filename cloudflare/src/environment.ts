type Settings = Pick<Env,
  "DATABASE_URL" | "DOMAIN" | "R2_BUCKET" | "R2_ENDPOINT" |
  "AWS_ACCESS_KEY_ID" | "AWS_SECRET_ACCESS_KEY" | "ADMIN_TOKEN"
>;

export const SECRET_NAMES = [
  "DATABASE_URL", "DOMAIN", "R2_BUCKET", "R2_ENDPOINT",
  "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "ADMIN_TOKEN",
] as const;

// Never put values in validation errors: these errors can reach build logs.
export function validateSettings(input: unknown): asserts input is Settings {
  if (typeof input !== "object" || input === null) throw new Error("Expected a secrets object");
  for (const name of SECRET_NAMES) {
    const value = Reflect.get(input, name);
    if (typeof value !== "string" || !value.trim() || /[\0\r\n]/.test(value) || value.includes("REPLACE_ME")) {
      throw new Error(`Missing or invalid ${name}`);
    }
  }
  const values = input as Settings;
  const parse = (value: string, name: string) => {
    try { return new URL(value); } catch { throw new Error(`Invalid ${name}`); }
  };
  const database = parse(values.DATABASE_URL, "DATABASE_URL");
  if (!["postgres:", "postgresql:"].includes(database.protocol) || !database.hostname || database.pathname === "/") {
    throw new Error("DATABASE_URL must identify a PostgreSQL database");
  }
  if (!["require", "verify-ca", "verify-full"].includes(database.searchParams.get("sslmode") ?? "")) {
    throw new Error("DATABASE_URL must explicitly require TLS (sslmode=require or verify-full)");
  }
  const domain = parse(values.DOMAIN, "DOMAIN");
  if (domain.protocol !== "https:" || domain.pathname !== "/" || domain.search || domain.hash || domain.username || domain.password) {
    throw new Error("DOMAIN must be an HTTPS origin without a path or credentials");
  }
  const endpoint = parse(values.R2_ENDPOINT, "R2_ENDPOINT");
  if (endpoint.protocol !== "https:" || endpoint.pathname !== "/" || endpoint.search || endpoint.hash || endpoint.username || endpoint.password ||
      !/^[a-f0-9]{32}(?:\.(?:eu|fedramp))?\.r2\.cloudflarestorage\.com$/.test(endpoint.hostname)) {
    throw new Error("R2_ENDPOINT must be the account's HTTPS R2 S3 endpoint");
  }
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(values.R2_BUCKET)) throw new Error("Invalid R2_BUCKET");
  if (values.ADMIN_TOKEN.length < 32) throw new Error("ADMIN_TOKEN must be an Argon2 hash or a random token of at least 32 characters");
}

export function containerEnvironment(input: unknown): Record<string, string> {
  validateSettings(input);
  const data = new URL(`s3://${input.R2_BUCKET}/vaultwarden`);
  data.searchParams.set("endpoint", input.R2_ENDPOINT);
  data.searchParams.set("region", "auto");
  // Upstream's S3 defaults target AWS; R2 needs these explicit overrides.
  data.searchParams.set("enable_virtual_host_style", "false");
  data.searchParams.set("default_storage_class", "STANDARD");

  return {
    DATABASE_URL: input.DATABASE_URL,
    DATABASE_MAX_CONNS: "7",
    DATABASE_MIN_CONNS: "1",
    DOMAIN: new URL(input.DOMAIN).origin,
    ADMIN_TOKEN: input.ADMIN_TOKEN,
    DATA_FOLDER: data.toString(),
    AWS_ACCESS_KEY_ID: input.AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: input.AWS_SECRET_ACCESS_KEY,
    AWS_REGION: "auto",
    AWS_DEFAULT_REGION: "auto",
    AWS_EC2_METADATA_DISABLED: "true",
    // Only temporary files and compiled-in template overrides stay on disk.
    TMP_FOLDER: "/tmp/vaultwarden",
    TEMPLATES_FOLDER: "/tmp/vaultwarden-templates",
    ROCKET_ADDRESS: "0.0.0.0",
    ROCKET_PORT: "80",
    IP_HEADER: "X-Real-IP",
    SIGNUPS_ALLOWED: "false",
    INVITATIONS_ALLOWED: "true",
    ENABLE_WEBSOCKET: "true",
    // Avoid access logs that contain query tokens used by Bitwarden clients.
    LOG_LEVEL: "warn",
  };
}

export function forwardRequest(request: Request, domain: string): Request {
  const url = new URL(request.url);
  url.protocol = "http:";
  url.host = "container";
  const forwarded = new Request(url, request);
  forwarded.headers.delete("host");
  forwarded.headers.delete("forwarded");
  forwarded.headers.delete("x-forwarded-for");
  forwarded.headers.delete("x-real-ip");
  const clientIp = request.headers.get("cf-connecting-ip");
  if (clientIp) forwarded.headers.set("x-real-ip", clientIp);
  forwarded.headers.set("x-forwarded-proto", "https");
  forwarded.headers.set("x-forwarded-host", new URL(domain).host);
  return forwarded;
}
