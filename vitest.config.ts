import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// Root vitest config: find tests in every workspace and resolve the shared alias
// the same way tsc/vite do, so tests can `import ... from "@sb/shared"`.
export default defineConfig({
  resolve: {
    alias: {
      "@sb/shared": resolve(import.meta.dirname, "shared/src/index.ts"),
    },
  },
  test: {
    include: ["**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    environment: "node",
  },
});
