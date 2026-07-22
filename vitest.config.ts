import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const fromRoot = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

// Alias workspace packages straight to their TypeScript sources so tests run
// without a build step. Real dist builds (for the Node verifier) come later.
export default defineConfig({
  resolve: {
    alias: {
      "@sim/contracts/grading": fromRoot("./packages/contracts/src/grading.ts"),
      "@sim/contracts": fromRoot("./packages/contracts/src/index.ts"),
      "@sim/sim-core": fromRoot("./packages/sim-core/src/index.ts"),
      "@sim/cli-engine": fromRoot("./packages/cli-engine/src/index.ts"),
      "@sim/lab-format": fromRoot("./packages/lab-format/src/index.ts"),
      "@sim/sim-worker": fromRoot("./packages/sim-worker/src/index.ts"),
      "@sim/grading-core": fromRoot("./packages/grading-core/src/index.ts"),
      "@sim/db": fromRoot("./packages/db/src/index.ts"),
      "@sim/authz": fromRoot("./packages/authz/src/index.ts"),
      "@simulatornet/verifier": fromRoot("./apps/verifier/src/index.ts"),
    },
  },
  test: {
    fileParallelism: false,
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "apps/**/*.test.tsx"],
    environment: "node",
  },
});
