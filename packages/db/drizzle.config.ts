import { existsSync } from "node:fs";
import { defineConfig } from "drizzle-kit";

const environmentFile = new URL("../../.env", import.meta.url);
if (!process.env.DATABASE_URL && existsSync(environmentFile)) {
  process.loadEnvFile(environmentFile);
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgresql://simulatornet:placeholder@127.0.0.1:5432/simulatornet",
  },
  migrations: { prefix: "index" },
  strict: true,
  verbose: true,
});
