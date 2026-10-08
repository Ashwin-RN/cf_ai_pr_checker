import { defineConfig } from "vitest/config";

// Tests cover pure functions only, so they run in Node without the Vite
// plugins that start a Workers runtime.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"]
  }
});
