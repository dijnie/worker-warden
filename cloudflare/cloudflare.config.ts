import { bindings, defineConfig, defineContainer, exports, triggers } from "cf/config";

const vaultwarden = defineContainer({
  name: "worker-warden-container",
  image: {
    dockerfile: "../docker/Dockerfile.debian",
    buildContext: "..",
    buildVars: { DB: "postgresql,s3" },
  },
  instanceType: "basic",
  // Vaultwarden's notification connections and scheduler are process-local.
  maxInstances: 1,
  observability: { enabled: true, logs: { enabled: true } },
});

export default defineConfig({
  worker: {
    name: "worker-warden",
    entrypoint: "./src/index.ts",
    compatibilityDate: "2026-10-08",
    workersDev: true,
    previewUrls: false,
    observability: {
      enabled: true,
      redactQueryString: true,
      traces: { enabled: true, headSamplingRate: 0.1 },
    },
    exports: {
      Vaultwarden: exports.durableObject({ storage: "sqlite", container: vaultwarden }),
    },
    env: {
      VAULTWARDEN: bindings.durableObject({ worker: "worker-warden", exportName: "Vaultwarden" }),
      DATABASE_URL: bindings.secret(),
      DOMAIN: bindings.secret(),
      R2_BUCKET: bindings.secret(),
      R2_ENDPOINT: bindings.secret(),
      AWS_ACCESS_KEY_ID: bindings.secret(),
      AWS_SECRET_ACCESS_KEY: bindings.secret(),
      ADMIN_TOKEN: bindings.secret(),
    },
    // Keep the native scheduler running even when no clients are connected.
    triggers: [triggers.scheduled({ schedule: "* * * * *" })],
  },
  containers: [vaultwarden],
});
