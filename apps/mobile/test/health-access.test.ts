// Polso reads Health data and never writes it, and it doesn't wake in the background until it
// syncs. These tests guard those promises in the native config and in the source.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const appDir = fileURLToPath(new URL("..", import.meta.url));
const expoCli = createRequire(import.meta.url).resolve("expo/bin/cli");

/** The iOS config Expo resolves after running every config plugin, as prebuild sees it. */
function introspect(variant: string) {
  const result = spawnSync(
    process.execPath,
    [expoCli, "config", "--type", "introspect", "--json"],
    {
      cwd: appDir,
      encoding: "utf8",
      env: { ...process.env, POLSO_APP_VARIANT: variant, EXPO_NO_TELEMETRY: "1" },
    },
  );
  if (result.status !== 0) throw new Error(result.stderr || "expo config failed");
  return JSON.parse(result.stdout).ios as {
    entitlements: Record<string, unknown>;
    infoPlist: Record<string, unknown>;
  };
}

describe.each(["development", "production"])(
  "the %s app's native config",
  (variant) => {
    const ios = introspect(variant);

    it("has HealthKit with no background delivery or clinical records", () => {
      expect(ios.entitlements).toEqual({ "com.apple.developer.healthkit": true });
    });

    it("explains reading and has no write permission text", () => {
      expect(ios.infoPlist.NSHealthShareUsageDescription).toEqual(expect.any(String));
      expect(ios.infoPlist).not.toHaveProperty("NSHealthUpdateUsageDescription");
      expect(ios.infoPlist).not.toHaveProperty(
        "NSHealthClinicalHealthRecordsShareUsageDescription",
      );
      expect(ios.infoPlist).not.toHaveProperty("UIBackgroundModes");
    });
  },
  60_000,
);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|js|jsx|mts)$/.test(entry.name) ? [path] : [];
  });
}

describe("app source", () => {
  const files = ["app", "src"].flatMap((dir) => sourceFiles(join(appDir, dir)));
  // Static and dynamic imports and requires of the library or any of its subpaths.
  const importsLibrary =
    /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["']@(?:kingstinct\/react-native-healthkit|react-native-healthkit\/)/;

  it("talks to HealthKit only through src/health/healthkit.ts", () => {
    const importers = files
      .filter((file) => importsLibrary.test(readFileSync(file, "utf8")))
      .map((file) => relative(appDir, file).replaceAll("\\", "/"));
    expect(importers).toEqual(["src/health/healthkit.ts"]);
  });

  it("uses no HealthKit call that writes, deletes or enables background delivery", () => {
    const adapter = readFileSync(join(appDir, "src/health/healthkit.ts"), "utf8");
    expect(adapter).not.toMatch(/\b(save\w*|delete\w*|\w*BackgroundDelivery|\w*BackgroundTypes)\b/);
    expect(adapter).not.toMatch(/\btoShare\b/);
  });
});
