import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { parseChanges } from "../src/changes.ts";
import { DATABASE_FILE, MIGRATIONS, Store } from "../src/store.ts";
import { heartRate, run, tempDirectory, tempStore, UUID } from "./support.ts";

const NOW = new Date("2026-11-27T12:00:00.000Z");
const apply = (store: Store, body: unknown) => store.apply(parseChanges(body), NOW);
const rows = (store: Store, sql: string) => store.db.prepare(sql).all();

describe("store", () => {
  it("creates its schema, and refuses a database from a newer server", () => {
    const directory = tempDirectory();
    const path = join(directory, DATABASE_FILE);
    Store.open(path).close();
    const raw = new DatabaseSync(path);
    expect(raw.prepare("PRAGMA user_version").get()).toEqual({ user_version: MIGRATIONS.length });
    raw.exec("PRAGMA user_version = 99");
    raw.close();
    expect(() => Store.open(path)).toThrow("newer Polso server");
  });

  it("keeps data across reopening", () => {
    const path = join(tempDirectory(), DATABASE_FILE);
    const first = Store.open(path);
    apply(first, { samples: [heartRate(1)] });
    const generation = first.generation();
    first.close();
    const again = Store.open(path);
    expect(again.counts().samples).toBe(1);
    expect(again.generation()).toBe(generation);
    again.close();
  });

  it("stores records by id, replacing a resent one", () => {
    const store = tempStore();
    apply(store, { samples: [heartRate(1, 60), heartRate(2)], workouts: [run(3)] });
    apply(store, { samples: [heartRate(1, 64)] });
    expect(rows(store, "SELECT id, number_value FROM samples ORDER BY id")).toEqual([
      { id: UUID(1), number_value: 64 },
      { id: UUID(2), number_value: 60 },
    ]);
    expect(store.counts()).toMatchObject({ workouts: 1, lastUploadAt: NOW.toISOString() });
  });

  it("deletes samples and workouts, after storing the same upload's records", () => {
    const store = tempStore();
    apply(store, { samples: [heartRate(1)], workouts: [run(2)] });
    apply(store, { samples: [heartRate(3)], deleted: [UUID(1), UUID(2), UUID(3), UUID(99)] });
    expect(store.counts()).toMatchObject({ samples: 0, workouts: 0 });
  });

  it("replaces daily statistics across the sent range only", () => {
    const store = tempStore();
    const stats = (from: string, to: string, values: [string, number][]) => ({
      dailyStats: [
        {
          type: "HKQuantityTypeIdentifierStepCount",
          statistic: "sum",
          from,
          to,
          values: values.map(([day, value]) => ({ day, value })),
        },
      ],
    });
    apply(
      store,
      stats("2026-11-01", "2026-11-03", [
        ["2026-11-01", 1],
        ["2026-11-02", 2],
        ["2026-11-03", 3],
      ]),
    );
    // Day 2 lost its data on the phone; day 3 changed. Day 1 lies outside and stays.
    apply(store, stats("2026-11-02", "2026-11-03", [["2026-11-03", 30]]));
    expect(rows(store, "SELECT day, value FROM daily_stats ORDER BY day")).toEqual([
      { day: "2026-11-01", value: 1 },
      { day: "2026-11-03", value: 30 },
    ]);
  });

  it("sets and clears characteristics, and keeps the time zone", () => {
    const store = tempStore();
    const type = "HKCharacteristicTypeIdentifierBloodType";
    apply(store, { timeZone: "Europe/Berlin", characteristics: { [type]: "A+" } });
    expect(rows(store, "SELECT value FROM characteristics")).toEqual([{ value: "A+" }]);
    apply(store, { characteristics: { [type]: null } });
    expect(rows(store, "SELECT value FROM characteristics")).toEqual([]);
    expect(store.setting("timeZone")).toBe("Europe/Berlin");
  });

  it("stores nothing from an upload that fails partway", () => {
    const store = tempStore();
    apply(store, { samples: [heartRate(1)] });
    const changes = parseChanges({ samples: [heartRate(2)], deleted: [UUID(1)] });
    // A deletion that can't be applied, after the sample was written.
    const broken = { ...changes, deleted: [Symbol("bad") as unknown as string] };
    expect(() => store.apply(broken, NOW)).toThrow();
    expect(rows(store, "SELECT id FROM samples")).toEqual([{ id: UUID(1) }]);
  });

  it("erases Health data, keeps devices paired, and starts a new generation", () => {
    const store = tempStore();
    store.addPairingCode("code", new Date(NOW.getTime() + 60_000));
    expect(store.pair("code", "iPhone", "token", NOW)).toBe(true);
    apply(store, {
      timeZone: "Europe/Berlin",
      samples: [heartRate(1)],
      workouts: [run(2)],
      characteristics: { HKCharacteristicTypeIdentifierBloodType: "A+" },
    });
    const before = store.generation();
    store.eraseHealthData();
    expect(store.counts()).toEqual({ samples: 0, workouts: 0, dailyStats: 0 });
    expect(rows(store, "SELECT * FROM characteristics")).toEqual([]);
    expect(store.setting("timeZone")).toBeUndefined();
    expect(store.generation()).not.toBe(before);
    expect(store.devices()).toHaveLength(1);
  });
});

describe("pairing and devices", () => {
  it("pairs once per code, and not after the code expires", () => {
    const store = tempStore();
    store.addPairingCode("a", new Date(NOW.getTime() + 60_000));
    store.addPairingCode("b", new Date(NOW.getTime() + 60_000));
    expect(store.pair("a", "iPhone", "t1", NOW)).toBe(true);
    expect(store.pair("a", "iPhone", "t2", NOW)).toBe(false);
    expect(store.pair("b", "iPhone", "t3", new Date(NOW.getTime() + 60_000))).toBe(false);
    expect(store.pair("unknown", "iPhone", "t4", NOW)).toBe(false);
    expect(store.devices().map((d) => d.name)).toEqual(["iPhone"]);
  });

  it("finds a device by its token hash until it is revoked", () => {
    const store = tempStore();
    store.addPairingCode("a", new Date(NOW.getTime() + 60_000));
    store.addPairingCode("b", new Date(NOW.getTime() + 60_000));
    store.pair("a", "First", "t1", NOW);
    store.pair("b", "Second", "t2", NOW);
    const first = store.deviceFor("t1", NOW);
    expect(first).toMatchObject({ name: "First", lastSeenAt: NOW });
    expect(store.revoke(first?.id)).toBe(1);
    expect(store.deviceFor("t1", NOW)).toBeUndefined();
    expect(store.deviceFor("t2", NOW)).toBeDefined();
    expect(store.revoke()).toBe(1);
    expect(store.deviceFor("t2", NOW)).toBeUndefined();
  });
});

describe("upgrading", () => {
  it("keeps a schema-1 database's data and devices when it gains agent tokens", () => {
    const path = join(tempDirectory(), DATABASE_FILE);
    // A database as the first server version left it, with a device and Health data.
    const old = new DatabaseSync(path);
    old.exec("PRAGMA journal_mode = WAL");
    old.exec(MIGRATIONS[0] as string);
    old.exec("PRAGMA user_version = 1");
    old
      .prepare("INSERT INTO devices (name, token_hash, paired_at) VALUES (?, ?, ?)")
      .run("iPhone", "hash", NOW.getTime());
    old
      .prepare(
        "INSERT INTO samples (id, type, start_ms, end_ms, number_value, unit, source) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(UUID(1), "HKQuantityTypeIdentifierHeartRate", 1, 2, 61, "count/min", "Watch");
    old.prepare("INSERT INTO settings (key, value) VALUES ('generation', 'g1')").run();
    old.close();

    const store = Store.open(path);
    expect(store.counts().samples).toBe(1);
    expect(store.devices().map((d) => d.name)).toEqual(["iPhone"]);
    expect(store.generation()).toBe("g1");
    expect(store.agents()).toEqual([]);
    // The longest record per type is filled in from the records already there.
    expect(store.maxSpan("HKQuantityTypeIdentifierHeartRate")).toBe(1);
    store.addAgent("Claude", "agent-hash", NOW);
    expect(store.agentFor("agent-hash", NOW)).toBe(true);
    store.close();
  });
});
