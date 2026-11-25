import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { outputPath, readSchema, renderHealthTypes } from "../scripts/health-types.mts";
import { HEALTH_TYPES, labelFor, valueLabel } from "../src/health/catalog";

const schema = readSchema();
// The native bridge converts identifiers through this generated switch and throws on any other
// string, which would reject the whole permission request.
const bridge = readFileSync(
  fileURLToPath(
    new URL(
      "../node_modules/@kingstinct/react-native-healthkit/nitrogen/generated/shared/c++/ObjectTypeIdentifier.hpp",
      import.meta.url,
    ),
  ),
  "utf8",
);

describe("the type catalog", () => {
  it("matches the HealthKit schema of the installed library", () => {
    // Fails after a library upgrade until `node scripts/health-types.mts` is run again.
    expect(readFileSync(outputPath, "utf8")).toBe(renderHealthTypes(schema));
  });

  it("asks for every current quantity and category type, and no legacy ones", () => {
    const ids = new Set(HEALTH_TYPES.map((t) => t.id));
    const sampleTypes = [...schema.quantityIdentifiers, ...schema.categoryIdentifiers];
    for (const type of sampleTypes) expect(ids.has(type.name)).toBe(!type.legacy);
    expect(ids.has("HKCategoryTypeIdentifierAudioExposureEvent")).toBe(false);
  });

  it("lists each type once", () => {
    const ids = HEALTH_TYPES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("uses only identifiers the native bridge accepts", () => {
    const accepted = new Set(
      [...bridge.matchAll(/case hashString\("([^"]+)"\)/g)].map((m) => m[1]),
    );
    expect(accepted.size).toBeGreaterThan(200);
    expect(HEALTH_TYPES.filter((t) => !accepted.has(t.id)).map((t) => t.id)).toEqual([]);
  });

  it("keeps the names of category values, such as sleep stages", () => {
    const sleep = HEALTH_TYPES.find((t) => t.id === "HKCategoryTypeIdentifierSleepAnalysis");
    expect(sleep?.values).toMatchObject({ "0": "inBed", "3": "asleepCore", "5": "asleepREM" });
    // Raw value 1 also has the deprecated alias "asleep"; the current name wins.
    expect(sleep?.values?.["1"]).toBe("asleepUnspecified");
  });
});

describe("labels", () => {
  it.each([
    ["HKQuantityTypeIdentifierVO2Max", "VO2 max"],
    ["HKQuantityTypeIdentifierHeartRateVariabilitySDNN", "Heart rate variability SDNN"],
    ["HKQuantityTypeIdentifierUVExposure", "UV exposure"],
    ["HKQuantityTypeIdentifierDietaryVitaminB12", "Dietary vitamin B12"],
    ["HKCategoryTypeIdentifierSleepAnalysis", "Sleep analysis"],
    ["HKQuantityTypeIdentifierDietaryVitaminA", "Dietary vitamin A"],
    ["HKQuantityTypeIdentifierForcedExpiratoryVolume1", "Forced expiratory volume 1"],
  ])("labels %s as %s", (id, label) => {
    expect(labelFor(id)).toBe(label);
  });

  it("capitalizes value names", () => {
    expect(valueLabel("asleepREM")).toBe("Asleep REM");
    expect(valueLabel("traditionalStrengthTraining")).toBe("Traditional strength training");
  });
});
