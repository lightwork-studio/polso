import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const resolve = require("../app.config.js");
const { expo: base } = JSON.parse(readFileSync(new URL("../app.json", import.meta.url), "utf8"));
const resolveApp = () => resolve({ config: base });

afterEach(() => vi.unstubAllEnvs());

it("builds the Dev app when no variant is set, as on a fresh checkout", () => {
  vi.stubEnv("POLSO_APP_VARIANT", undefined);
  expect(resolveApp()).toMatchObject({
    name: "Polso Dev",
    scheme: "polso-dev",
    ios: { bundleIdentifier: "app.polso.dev" },
  });
});

it("builds the Dev app on its own EAS project and leaves the others unlinked", () => {
  vi.stubEnv("POLSO_APP_VARIANT", "development");
  expect(resolveApp()).toMatchObject({
    owner: "webertim",
    extra: { eas: { projectId: "e700bfb2-1592-4d37-a382-6055bff6b4b7" } },
  });
  // Without projects of their own, the App Store and TestFlight apps must not borrow Dev's.
  for (const variant of ["preview", "production"]) {
    vi.stubEnv("POLSO_APP_VARIANT", variant);
    const app = resolveApp();
    expect(app.owner).toBeUndefined();
    expect(app.extra?.eas).toBeUndefined();
  }
});

it("gives each variant its own bundle ID so they install side by side", () => {
  const ids = ["development", "preview", "production"].map((variant) => {
    vi.stubEnv("POLSO_APP_VARIANT", variant);
    return resolveApp().ios.bundleIdentifier;
  });
  expect(ids).toEqual(["app.polso.dev", "app.polso.preview", "app.polso.production"]);
});

it("names the App Store app Polso and keeps the shared iOS settings", () => {
  vi.stubEnv("POLSO_APP_VARIANT", "production");
  const app = resolveApp();
  expect(app).toMatchObject({ name: "Polso", slug: "polso", scheme: "polso" });
  expect(app.ios).toEqual({ ...base.ios, bundleIdentifier: "app.polso.production" });
  expect(app.platforms).toEqual(["ios"]);
});

it("matches app.json for the TestFlight preview", () => {
  vi.stubEnv("POLSO_APP_VARIANT", "preview");
  expect(resolveApp()).toEqual(base);
});

it("refuses an unknown variant instead of building under a default identity", () => {
  vi.stubEnv("POLSO_APP_VARIANT", "prodution");
  expect(resolveApp).toThrow("Unknown Polso app variant: prodution");
  vi.stubEnv("POLSO_APP_VARIANT", "toString");
  expect(resolveApp).toThrow("Unknown Polso app variant: toString");
  // An unset CI variable expands to an empty string; that must not fall back to Dev.
  vi.stubEnv("POLSO_APP_VARIANT", "");
  expect(resolveApp).toThrow("Unknown Polso app variant: ");
});
