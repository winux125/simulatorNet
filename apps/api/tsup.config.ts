import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/server.ts"],
  format: ["esm"],
  target: "node24",
  platform: "node",
  clean: true,
  dts: true,
  sourcemap: true,
  noExternal: [/^@sim\//, /^@simulatornet\/verifier$/, "zod"],
});
