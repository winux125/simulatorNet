import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./apps/web/e2e",
  fullyParallel: false,
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
    command: "pnpm --filter @sim/web dev --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: process.env.CI !== "true",
    timeout: 120_000,
  },
});
