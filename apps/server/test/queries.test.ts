import { HEALTH_TYPES, type HealthType } from "@polso/mcp/health/catalog";
import { describe, expect, it } from "vitest";
import {
  LONG_SLEEP_SQL,
  LONG_SQL,
  LONG_WORKOUTS_SQL,
  SAMPLES_SQL,
  SLEEP_SQL,
  storeQueries,
  WORKOUTS_SQL,
} from "../src/queries.ts";
import { LONG_RECORD_MS } from "../src/store.ts";
import { tempStore } from "./support.ts";

const HR = HEALTH_TYPES.find((t) => t.id === "HKQuantityTypeIdentifierHeartRate") as HealthType;
const SLEEP = "HKCategoryTypeIdentifierSleepAnalysis";
const DAY = 86_400_000;
const L = LONG_RECORD_MS;
const T0 = Date.UTC(2026, 0, 1);

/** A small seeded generator, so a failure can be replayed. */
function random(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const pick = <T>(next: () => number, items: readonly T[]) =>
  items[Math.floor(next() * items.length)] as T;

describe("records queries", () => {
  it("return exactly what one unbounded query would, for samples, sleep and workouts", async () => {
    const lengths = [0, 1, 3_600_000, L - 1, L, L + 1, 3 * DAY, 10 * DAY, 40 * DAY];
    for (let seed = 1; seed <= 20; seed++) {
      const next = random(seed);
      const store = tempStore();
      const db = store.db;
      const sample = db.prepare(
        "INSERT INTO samples (id, type, start_ms, end_ms, number_value, source) VALUES (?, ?, ?, ?, ?, 'x')",
      );
      const workout = db.prepare(
        "INSERT INTO workouts (id, activity, start_ms, end_ms, duration_minutes, source) VALUES (?, 'run', ?, ?, 1, 'x')",
      );
      const starts: number[] = [];
      for (let i = 0; i < 60; i++) {
        // Some records share a start time, to exercise the tie-break.
        const start =
          starts.length > 0 && next() < 0.2
            ? pick(next, starts)
            : T0 + Math.floor(next() * 60) * (DAY / 4);
        starts.push(start);
        const end = start + pick(next, lengths);
        sample.run(`hr${i}`, HR.id, start, end, i);
        sample.run(`sl${i}`, SLEEP, start, end, i);
        workout.run(`w${i}`, start, end);
      }
      const queries = storeQueries(store);
      for (let q = 0; q < 25; q++) {
        // Range edges on record edges, on the two-day boundary, or anywhere.
        const anchor = pick(next, starts);
        const start = pick(next, [anchor, anchor - L, anchor + L, anchor + 1, anchor - 1]);
        const end = start + pick(next, [0, 1, DAY, 5 * DAY, 30 * DAY]);
        const limit = 1 + Math.floor(next() * 15);
        const range = { start: new Date(start), end: new Date(end) };
        const brute = (table: string, type: string | null, order: "DESC" | "ASC") =>
          (
            db
              .prepare(
                `SELECT start_ms, end_ms FROM ${table}
                 WHERE ${type ? "type = ? AND " : ""}start_ms < ? AND end_ms >= ?
                 ORDER BY start_ms ${order}, rowid ${order} LIMIT ?`,
              )
              .all(...(type ? [type] : []), end, start, limit) as {
              start_ms: number;
              end_ms: number;
            }[]
          ).map((r) => [r.start_ms, r.end_ms]);
        const spans = (rows: { start: Date; end: Date }[]) =>
          rows.map((r) => [r.start.getTime(), r.end.getTime()]);
        const where = `seed ${seed}, query ${q}`;
        expect(spans(await queries.samples(HR, range, limit)), where).toEqual(
          brute("samples", HR.id, "DESC"),
        );
        expect(spans(await queries.sleep(range, limit)), where).toEqual(
          brute("samples", SLEEP, "ASC"),
        );
        expect(spans(await queries.workouts(range, limit)), where).toEqual(
          brute("workouts", null, "DESC"),
        );
      }
    }
  }, 60_000);

  it("read only their index ranges and never sort", () => {
    const store = tempStore();
    const plan = (sql: string) =>
      (store.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[])
        .map((p) => p.detail)
        .join(" | ");
    for (const sql of [SAMPLES_SQL, SLEEP_SQL]) {
      expect(plan(sql)).toMatch(
        /samples_by_type_and_start \(type=\? AND start_ms>\? AND start_ms<\?\)/,
      );
    }
    for (const sql of [LONG_SQL, LONG_SLEEP_SQL]) expect(plan(sql)).toMatch(/INDEX samples_long/);
    expect(plan(WORKOUTS_SQL)).toMatch(/workouts_by_start \(start_ms>\? AND start_ms<\?\)/);
    expect(plan(LONG_WORKOUTS_SQL)).toMatch(/INDEX workouts_long/);
    for (const sql of [
      SAMPLES_SQL,
      SLEEP_SQL,
      LONG_SQL,
      LONG_SLEEP_SQL,
      WORKOUTS_SQL,
      LONG_WORKOUTS_SQL,
    ]) {
      expect(plan(sql)).not.toMatch(/TEMP B-TREE/);
    }
  });
});
