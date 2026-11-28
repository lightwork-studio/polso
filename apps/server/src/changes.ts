import type { Statistic } from "@polso/mcp/health/queries";

/*
 * Checks an upload from a phone (docs/sync-protocol.md) and turns it into typed changes. Any
 * problem rejects the whole upload, so nothing half-checked reaches the database.
 */

export const LIMITS = {
  records: 5_000,
  deleted: 20_000,
  dailyStats: 500,
  dailyValues: 4_000,
  characteristics: 50,
  text: 200,
} as const;

export interface SampleChange {
  readonly id: string;
  readonly type: string;
  readonly start: Date;
  readonly end: Date;
  readonly value: number | string;
  readonly unit?: string;
  readonly source: string;
}

export interface Amount {
  readonly value: number;
  readonly unit: string;
}

export interface WorkoutChange {
  readonly id: string;
  readonly activity: string;
  readonly start: Date;
  readonly end: Date;
  readonly durationMinutes: number;
  readonly energy?: Amount;
  readonly distance?: Amount;
  readonly source: string;
}

export interface DailyStatsChange {
  readonly type: string;
  readonly statistic: Statistic;
  readonly from: string;
  readonly to: string;
  /** The unit of the values, such as "count" or "kcal". */
  readonly unit?: string;
  readonly values: readonly { readonly day: string; readonly value: number }[];
}

export interface Changes {
  readonly timeZone?: string;
  readonly samples: readonly SampleChange[];
  readonly workouts: readonly WorkoutChange[];
  readonly deleted: readonly string[];
  readonly dailyStats: readonly DailyStatsChange[];
  readonly characteristics: readonly (readonly [string, string | null])[];
}

export class ChangesError extends Error {
  override name = "ChangesError";
}

const STATISTICS: readonly Statistic[] = ["sum", "average", "min", "max"];
const TYPE_ID = /^HK[A-Za-z]+TypeIdentifier[A-Za-z0-9]+$/;
const RECORD_ID = /^[A-Za-z0-9-]{1,64}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
// Instants as the phone writes them (Date.toISOString), which compare and parse unambiguously.
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

type Json = Record<string, unknown>;

const fail = (where: string, problem: string): never => {
  throw new ChangesError(`${where}: ${problem}`);
};

function object(value: unknown, where: string): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(where, "expected an object");
  }
  return value as Json;
}

function list(value: unknown, where: string, max: number): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(where, "expected a list");
  const items = value as unknown[];
  if (items.length > max) fail(where, `more than ${max} entries; split the upload`);
  return items;
}

function text(value: unknown, where: string): string {
  if (typeof value !== "string" || value.length === 0) fail(where, "expected text");
  const s = value as string;
  if (s.length > LIMITS.text) fail(where, `longer than ${LIMITS.text} characters`);
  return s;
}

function matching(value: unknown, pattern: RegExp, where: string, what: string): string {
  if (typeof value !== "string" || !pattern.test(value)) fail(where, `expected ${what}`);
  return value as string;
}

function finite(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(where, "expected a number");
  return value as number;
}

function instant(value: unknown, where: string): Date {
  const s = matching(value, INSTANT, where, "a UTC time such as 2026-11-27T07:01:00.000Z");
  const date = new Date(s);
  if (Number.isNaN(date.getTime())) fail(where, "not a valid time");
  return date;
}

function day(value: unknown, where: string): string {
  const s = matching(value, DAY, where, "a day such as 2026-11-27");
  // Rejects days that don't exist, such as 2026-02-30.
  if (new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) !== s) fail(where, "not a real day");
  return s;
}

function span(record: Json, where: string): { start: Date; end: Date } {
  const start = instant(record.start, `${where}.start`);
  const end = instant(record.end, `${where}.end`);
  if (end < start) fail(where, "ends before it starts");
  return { start, end };
}

function optionalText(value: unknown, where: string): string | undefined {
  return value === undefined ? undefined : text(value, where);
}

function amount(value: unknown, where: string): Amount | undefined {
  if (value === undefined) return undefined;
  const a = object(value, where);
  return { value: finite(a.value, `${where}.value`), unit: text(a.unit, `${where}.unit`) };
}

function sample(value: unknown, where: string): SampleChange {
  const s = object(value, where);
  const v = s.value;
  const unit = optionalText(s.unit, `${where}.unit`);
  return {
    id: matching(s.id, RECORD_ID, `${where}.id`, "a record id"),
    type: matching(s.type, TYPE_ID, `${where}.type`, "a HealthKit type identifier"),
    ...span(s, where),
    value: typeof v === "string" ? text(v, `${where}.value`) : finite(v, `${where}.value`),
    ...(unit !== undefined && { unit }),
    source: text(s.source, `${where}.source`),
  };
}

function workout(value: unknown, where: string): WorkoutChange {
  const w = object(value, where);
  const energy = amount(w.energy, `${where}.energy`);
  const distance = amount(w.distance, `${where}.distance`);
  const durationMinutes = finite(w.durationMinutes, `${where}.durationMinutes`);
  if (durationMinutes < 0) fail(`${where}.durationMinutes`, "is negative");
  return {
    id: matching(w.id, RECORD_ID, `${where}.id`, "a record id"),
    activity: text(w.activity, `${where}.activity`),
    ...span(w, where),
    durationMinutes,
    ...(energy && { energy }),
    ...(distance && { distance }),
    source: text(w.source, `${where}.source`),
  };
}

function dailyStats(value: unknown, where: string): DailyStatsChange {
  const d = object(value, where);
  const statistic = d.statistic as Statistic;
  if (!STATISTICS.includes(statistic))
    fail(`${where}.statistic`, "expected sum, average, min or max");
  const from = day(d.from, `${where}.from`);
  const to = day(d.to, `${where}.to`);
  if (to < from) fail(where, "to is before from");
  const values = list(d.values, `${where}.values`, LIMITS.dailyValues).map((entry, i) => {
    const at = `${where}.values[${i}]`;
    const e = object(entry, at);
    const date = day(e.day, `${at}.day`);
    if (date < from || date > to) fail(`${at}.day`, "outside from and to");
    return { day: date, value: finite(e.value, `${at}.value`) };
  });
  const unit = optionalText(d.unit, `${where}.unit`);
  if (new Set(values.map((v) => v.day)).size !== values.length) {
    fail(`${where}.values`, "a day appears twice");
  }
  return {
    type: matching(d.type, TYPE_ID, `${where}.type`, "a HealthKit type identifier"),
    statistic,
    from,
    to,
    ...(unit !== undefined && { unit }),
    values,
  };
}

// An IANA zone name such as Europe/Berlin or America/Argentina/Buenos_Aires. Checked for its form
// only: a zone newer than the server's time zone data mustn't stall the phone's uploads.
const ZONE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/;

function timeZone(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const zone = text(value, "timeZone");
  if (zone.length > 64 || !ZONE.test(zone))
    fail("timeZone", "expected a zone such as Europe/Berlin");
  return zone;
}

/** Checks a parsed JSON upload; throws ChangesError on the first problem. */
export function parseChanges(body: unknown): Changes {
  const b = object(body, "body");
  const samples = list(b.samples, "samples", LIMITS.records).map((s, i) =>
    sample(s, `samples[${i}]`),
  );
  const workouts = list(b.workouts, "workouts", LIMITS.records).map((w, i) =>
    workout(w, `workouts[${i}]`),
  );
  if (samples.length + workouts.length > LIMITS.records) {
    fail("body", `more than ${LIMITS.records} samples and workouts; split the upload`);
  }
  const deleted = list(b.deleted, "deleted", LIMITS.deleted).map((id, i) =>
    matching(id, RECORD_ID, `deleted[${i}]`, "a record id"),
  );
  const stats = list(b.dailyStats, "dailyStats", LIMITS.dailyStats).map((d, i) =>
    dailyStats(d, `dailyStats[${i}]`),
  );
  const characteristics: [string, string | null][] = [];
  if (b.characteristics !== undefined) {
    const c = object(b.characteristics, "characteristics");
    const entries = Object.entries(c);
    if (entries.length > LIMITS.characteristics) {
      fail("characteristics", `more than ${LIMITS.characteristics} entries`);
    }
    for (const [type, value] of entries) {
      const where = `characteristics.${type}`;
      matching(type, TYPE_ID, where, "a HealthKit type identifier as the key");
      characteristics.push([type, value === null ? null : text(value, where)]);
    }
  }
  const zone = timeZone(b.timeZone);
  return {
    ...(zone !== undefined && { timeZone: zone }),
    samples,
    workouts,
    deleted,
    dailyStats: stats,
    characteristics,
  };
}
