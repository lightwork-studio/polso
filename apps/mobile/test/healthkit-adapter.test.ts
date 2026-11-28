import * as HK from "@kingstinct/react-native-healthkit";
import { HEALTH_TYPES, type HealthType } from "@polso/mcp/health/catalog";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { healthKit, healthQueries } from "../src/health/healthkit";

// The alias in vitest.config.mts swaps the library for test/support/healthkit.ts.
const fake = HK as unknown as typeof import("./support/healthkit");
const byId = (id: string) => HEALTH_TYPES.find((t) => t.id === id) as HealthType;
const ended = new Date(2026, 10, 24, 7, 30);

beforeEach(() => vi.clearAllMocks());

describe("permissions", () => {
  it("asks only to read, never to write", async () => {
    await healthKit.requestRead(["HKQuantityTypeIdentifierStepCount"]);
    expect(fake.requestAuthorization).toHaveBeenCalledWith({
      toRead: ["HKQuantityTypeIdentifierStepCount"],
    });
    const [request] = fake.requestAuthorization.mock.calls[0] as [Record<string, unknown>];
    expect(request).not.toHaveProperty("toShare");
  });

  it("skips the permission sheet once HealthKit says it's unnecessary", async () => {
    fake.getRequestStatusForAuthorization.mockResolvedValueOnce(
      fake.AuthorizationRequestStatus.unnecessary,
    );
    expect(await healthKit.needsRequest(["HKQuantityTypeIdentifierStepCount"])).toBe(false);
    fake.getRequestStatusForAuthorization.mockResolvedValueOnce(
      fake.AuthorizationRequestStatus.unknown,
    );
    expect(await healthKit.needsRequest(["HKQuantityTypeIdentifierStepCount"])).toBe(true);
  });
});

describe("latest values", () => {
  it("reads a quantity in its canonical unit", async () => {
    fake.getMostRecentQuantitySample.mockResolvedValueOnce({
      quantity: 61.5,
      unit: "count/min",
      endDate: ended,
    });
    const preview = await healthKit.latest(byId("HKQuantityTypeIdentifierRestingHeartRate"));
    expect(fake.getMostRecentQuantitySample).toHaveBeenCalledWith(
      "HKQuantityTypeIdentifierRestingHeartRate",
      "count/min",
    );
    expect(preview).toEqual({ status: "value", text: "61.5 bpm", date: ended });
  });

  it("reads UV exposure, which has no canonical unit in the schema, as an index", async () => {
    await healthKit.latest(byId("HKQuantityTypeIdentifierUVExposure"));
    expect(fake.getMostRecentQuantitySample).toHaveBeenCalledWith(
      "HKQuantityTypeIdentifierUVExposure",
      "count",
    );
  });

  it.each([
    ["HKQuantityTypeIdentifierOxygenSaturation", 0.98, "%", "98%"],
    ["HKQuantityTypeIdentifierBloodAlcoholContent", 0.0008, "%", "0.08%"],
    ["HKQuantityTypeIdentifierHeartRate", 73 / 60, "count/s", "73 bpm"],
    ["HKQuantityTypeIdentifierRespiratoryRate", 16 / 60, "count/s", "16/min"],
    ["HKQuantityTypeIdentifierCyclingCadence", 85, "count/min", "85/min"],
    ["HKQuantityTypeIdentifierWorkoutEffortScore", 7, "appleEffortScore", "7"],
    ["HKQuantityTypeIdentifierHeadphoneAudioExposure", 72.3, "dBASPL", "72.3 dB"],
    ["HKQuantityTypeIdentifierDietaryVitaminD", 0.00001, "g", "10 mcg"],
    ["HKQuantityTypeIdentifierDietaryMagnesium", 0.35, "g", "350 mg"],
    ["HKQuantityTypeIdentifierDietaryProtein", 82.4, "g", "82.4 g"],
    ["HKQuantityTypeIdentifierElectrodermalActivity", 0.0000043, "S", "0.0000043 S"],
    ["HKQuantityTypeIdentifierActiveEnergyBurned", 1234.6, "kcal", "1,235 kcal"],
    ["HKQuantityTypeIdentifierBodyTemperature", 36.6, "degC", "36.6 °C"],
  ])("shows %s read as %s %s as %s", async (id, quantity, unit, text) => {
    fake.getMostRecentQuantitySample.mockResolvedValueOnce({ quantity, unit, endDate: ended });
    expect(await healthKit.latest(byId(id))).toMatchObject({ text });
  });

  it("shows counts without a unit", async () => {
    fake.getMostRecentQuantitySample.mockResolvedValueOnce({
      quantity: 8214,
      unit: "count",
      endDate: ended,
    });
    const preview = await healthKit.latest(byId("HKQuantityTypeIdentifierStepCount"));
    expect(preview).toMatchObject({ text: "8,214" });
  });

  it("names a category value, such as a sleep stage", async () => {
    fake.getMostRecentCategorySample.mockResolvedValueOnce({ value: 4, endDate: ended });
    const preview = await healthKit.latest(byId("HKCategoryTypeIdentifierSleepAnalysis"));
    expect(preview).toEqual({ status: "value", text: "Asleep deep", date: ended });
  });

  it("shows an occurrence for categories without values, and raw values it can't name", async () => {
    fake.getMostRecentCategorySample.mockResolvedValueOnce({ value: 0, endDate: ended });
    expect(await healthKit.latest(byId("HKCategoryTypeIdentifierMindfulSession"))).toMatchObject({
      text: "Recorded",
    });
    fake.getMostRecentCategorySample.mockResolvedValueOnce({ value: 99, endDate: ended });
    expect(await healthKit.latest(byId("HKCategoryTypeIdentifierSleepAnalysis"))).toMatchObject({
      text: "Value 99",
    });
  });

  it("reports no data when nothing is recorded or access was declined", async () => {
    expect(await healthKit.latest(byId("HKQuantityTypeIdentifierHeartRate"))).toEqual({
      status: "empty",
    });
  });

  it("describes the latest workout by activity and duration", async () => {
    fake.queryWorkoutSamples.mockResolvedValueOnce([
      {
        workoutActivityType: fake.WorkoutActivityType.running,
        duration: { quantity: 2700, unit: "s" },
        endDate: ended,
      },
    ]);
    const preview = await healthKit.latest(byId("HKWorkoutTypeIdentifier"));
    expect(fake.queryWorkoutSamples).toHaveBeenCalledWith({ limit: 1, ascending: false });
    expect(preview).toEqual({ status: "value", text: "Running, 45 min", date: ended });
  });

  it("dates records that have no single value", async () => {
    fake.queryCorrelationSamples.mockResolvedValueOnce([{ endDate: ended }]);
    const preview = await healthKit.latest(byId("HKCorrelationTypeIdentifierBloodPressure"));
    expect(fake.queryCorrelationSamples).toHaveBeenCalledWith(
      "HKCorrelationTypeIdentifierBloodPressure",
      { limit: 1, ascending: false },
    );
    expect(preview).toEqual({ status: "value", text: "Recorded", date: ended });
  });

  it("treats an unset profile value as no data", async () => {
    fake.getBloodTypeAsync.mockResolvedValueOnce(fake.BloodType.oNegative);
    expect(await healthKit.latest(byId("HKCharacteristicTypeIdentifierBloodType"))).toEqual({
      status: "value",
      text: "O−",
    });
    expect(await healthKit.latest(byId("HKCharacteristicTypeIdentifierBiologicalSex"))).toEqual({
      status: "empty",
    });
  });

  it("doesn't query kinds it can't preview yet", async () => {
    for (const id of ["HKAudiogramSampleType", "HKWorkoutRouteTypeIdentifier"]) {
      expect(await healthKit.latest(byId(id))).toEqual({ status: "notPreviewed" });
    }
    expect(fake.queryWorkoutSamples).not.toHaveBeenCalled();
  });
});

describe("reads for MCP tools", () => {
  const range = { start: new Date(2026, 10, 18, 9, 15), end: new Date(2026, 10, 25, 12) };
  const filter = { date: { startDate: range.start, endDate: range.end } };
  const source = (name: string) => ({ sourceRevision: { source: { name } } });

  it("reads heart rate per minute and percentages from 0 to 100", async () => {
    fake.queryQuantitySamples.mockResolvedValueOnce([
      { startDate: ended, endDate: ended, quantity: 72, unit: "count/min", ...source("Watch") },
    ]);
    const [record] = await healthQueries.samples(
      byId("HKQuantityTypeIdentifierHeartRate"),
      range,
      5,
    );
    expect(fake.queryQuantitySamples).toHaveBeenCalledWith("HKQuantityTypeIdentifierHeartRate", {
      filter,
      limit: 5,
      ascending: false,
      unit: "count/min",
    });
    expect(record).toEqual({
      start: ended,
      end: ended,
      value: 72,
      unit: "count/min",
      source: "Watch",
    });

    fake.queryQuantitySamples.mockResolvedValueOnce([
      { startDate: ended, endDate: ended, quantity: 0.97, unit: "%", ...source("Watch") },
    ]);
    const [spo2] = await healthQueries.samples(
      byId("HKQuantityTypeIdentifierOxygenSaturation"),
      range,
      1,
    );
    expect(spo2?.value).toBeCloseTo(97);
  });

  it("names category values and refuses kinds without records", async () => {
    fake.queryCategorySamples.mockResolvedValueOnce([
      { startDate: ended, endDate: ended, value: 0, ...source("iPhone") },
    ]);
    const [mindful] = await healthQueries.samples(
      byId("HKCategoryTypeIdentifierMindfulSession"),
      range,
      1,
    );
    expect(mindful?.value).toBe("recorded");
    await expect(healthQueries.samples(byId("HKWorkoutTypeIdentifier"), range, 1)).rejects.toThrow(
      "no individual records",
    );
  });

  it("asks HealthKit for daily statistics anchored at local midnight", async () => {
    fake.queryStatisticsCollectionForQuantity.mockResolvedValueOnce([
      { startDate: new Date(2026, 10, 18), sumQuantity: { quantity: 8214, unit: "count" } },
      { startDate: new Date(2026, 10, 19) },
    ]);
    const days = await healthQueries.dailyStats(
      byId("HKQuantityTypeIdentifierStepCount"),
      range,
      "sum",
    );
    expect(fake.queryStatisticsCollectionForQuantity).toHaveBeenCalledWith(
      "HKQuantityTypeIdentifierStepCount",
      ["cumulativeSum"],
      new Date(2026, 10, 18),
      { day: 1 },
      { filter, unit: "count" },
    );
    // A day without data is left out rather than reported as zero.
    expect(days).toEqual([{ day: new Date(2026, 10, 18), value: 8214 }]);
  });

  it("maps workouts with their totals", async () => {
    fake.queryWorkoutSamples.mockResolvedValueOnce([
      {
        workoutActivityType: fake.WorkoutActivityType.cycling,
        startDate: ended,
        endDate: ended,
        duration: { quantity: 3600, unit: "s" },
        totalEnergyBurned: { quantity: 512, unit: "kcal" },
        ...source("Apple Watch"),
      },
    ]);
    expect(await healthQueries.workouts(range, 10)).toEqual([
      {
        activity: "cycling",
        start: ended,
        end: ended,
        durationMinutes: 60,
        energy: { value: 512, unit: "kcal" },
        source: "Apple Watch",
      },
    ]);
    expect(fake.queryWorkoutSamples).toHaveBeenCalledWith({ filter, limit: 10, ascending: false });
  });

  it("passes the sleep record limit to HealthKit and maps stage names", async () => {
    fake.queryCategorySamples.mockResolvedValueOnce([
      { startDate: ended, endDate: ended, value: 4, ...source("Apple Watch") },
    ]);
    expect(await healthQueries.sleep(range, 20_000)).toEqual([
      { start: ended, end: ended, stage: "asleepDeep", source: "Apple Watch" },
    ]);
    expect(fake.queryCategorySamples).toHaveBeenCalledWith(
      "HKCategoryTypeIdentifierSleepAnalysis",
      { filter, limit: 20_000, ascending: true },
    );
  });
});
