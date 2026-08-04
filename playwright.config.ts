import { defineConfig, devices } from "@playwright/test";

const configuredWorkers = Number(process.env.PW_WORKERS ?? "1");
const workers = Number.isInteger(configuredWorkers) && configuredWorkers > 0
  ? configuredWorkers
  : 1;

export default defineConfig({
  testDir: "./apps/web/e2e",
  fullyParallel: false,
  workers,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: "pnpm --filter @sim/web dev --host 127.0.0.1 --port 4173 --strictPort",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: process.env.PW_REUSE_SERVER === "true" && process.env.CI !== "true",
    timeout: 120_000,
  },
});
