import { DurableObject } from "cloudflare:workers";
import { containerEnvironment, forwardRequest } from "./environment.ts";

const INSTANCE = "primary";
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;

export class Vaultwarden extends DurableObject<Env> {
  private starting: Promise<void> | undefined;
  private ready = false;

  async keepAlive(): Promise<void> {
    this.starting ??= this.ensureReady().finally(() => { this.starting = undefined; });
    await this.starting;
  }

  private async ensureReady(): Promise<void> {
    const container = this.ctx.container;
    if (!container) throw new Error("Container binding is missing");
    if (!container.running) {
      this.ready = false;
      container.start({ enableInternet: true, env: containerEnvironment(this.env) });
    }
    await container.setInactivityTimeout(IDLE_TIMEOUT_MS);
    if (this.ready) return;

    const port = container.getTcpPort(80);
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      try {
        // /alive acquires a database connection, so this also checks PostgreSQL.
        const response = await port.fetch("http://container/alive", { signal: AbortSignal.timeout(2_000) });
        await response.body?.cancel();
        if (response.ok) {
          this.ready = true;
          console.log(JSON.stringify({ event: "vaultwarden_ready" }));
          return;
        }
      } catch {
        // Connection refusal is expected while migrations/startup are running.
      }
      await scheduler.wait(500);
    }
    throw new Error("Vaultwarden readiness timed out");
  }

  async fetch(request: Request): Promise<Response> {
    await this.keepAlive();
    try {
      // Stream uploads/downloads and preserve native WebSocket upgrade responses.
      return await this.ctx.container!.getTcpPort(80).fetch(forwardRequest(request, this.env.DOMAIN));
    } catch {
      this.ready = false;
      // Do not retry a vault mutation after an ambiguous network failure.
      throw new Error("Vaultwarden connection failed");
    }
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    try {
      if (new URL(request.url).origin !== new URL(env.DOMAIN).origin) {
        return new Response("Not found", { status: 404 });
      }
      return await env.VAULTWARDEN.getByName(INSTANCE).fetch(request);
    } catch {
      console.error(JSON.stringify({ event: "vaultwarden_unavailable" }));
      return new Response("Vaultwarden is temporarily unavailable", {
        status: 503,
        headers: { "Retry-After": "30", "Cache-Control": "no-store" },
      });
    }
  },
  async scheduled(_controller, env): Promise<void> {
    // Keep the process alive for its native purge/email/emergency-access jobs.
    const response = await env.VAULTWARDEN.getByName(INSTANCE).fetch(new Request(new URL("/alive", env.DOMAIN)));
    await response.body?.cancel();
    if (!response.ok) throw new Error("Vaultwarden scheduled health check failed");
  },
} satisfies ExportedHandler<Env>;
