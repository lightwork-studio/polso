import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";

const support = (file: string) => fileURLToPath(new URL(`./test/support/${file}`, import.meta.url));

export default defineProject({
  resolve: {
    // The HealthKit library needs its native module, so tests get a Node stand-in.
    alias: [
      { find: /^@kingstinct\/react-native-healthkit$/, replacement: support("healthkit.ts") },
    ],
  },
  test: { name: "mobile", include: ["test/**/*.test.ts"] },
});
