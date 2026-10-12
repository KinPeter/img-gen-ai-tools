import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.mjs"],
    isolate: true,
    setupFiles: ["./test/support/setup.mjs"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      exclude: [
        "**/node_modules/**",
        "**/test/**",
        "**/output/**",
        "**/dist/**",
        "**/.tmp/**",
        "**/workflows/*.json",
      ],
    },
  },
});
