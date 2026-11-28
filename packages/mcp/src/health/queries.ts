import type { HealthType } from "./catalog.ts";

export interface DateRange {
  readonly start: Date;
  readonly end: Date;
}

/** One quantity or category record, in the units agents get. */
export interface SampleRecord {
  readonly start: Date;
  readonly end: Date;
  /** A number for quantities; the value's name (e.g. "asleepDeep") for categories. */
  readonly value: number | string;
  readonly unit?: string;
  readonly source: string;
}

export type Statistic = "sum" | "average" | "min" | "max";

export interface DailyValue {
  /** Local midnight that starts the day. */
  readonly day: Date;
  readonly value: number;
}

export interface WorkoutRecord {
  readonly activity: string;
  readonly start: Date;
  readonly end: Date;
  readonly durationMinutes: number;
  readonly energy?: { readonly value: number; readonly unit: string };
  readonly distance?: { readonly value: number; readonly unit: string };
  readonly source: string;
}

export interface SleepRecord {
  readonly start: Date;
  readonly end: Date;
  /** The sleep analysis value name, such as "asleepCore" or "inBed". */
  readonly stage: string;
  readonly source: string;
}

/** The HealthKit reads behind the MCP tools, so they can be tested without a device. */
export interface HealthQueries {
  /** Records of a quantity or category type, newest first. */
  samples(type: HealthType, range: DateRange, limit: number): Promise<SampleRecord[]>;
  /** One value per local day in the range, for a quantity type; days without data are left out. */
  dailyStats(type: HealthType, range: DateRange, statistic: Statistic): Promise<DailyValue[]>;
  workouts(range: DateRange, limit: number): Promise<WorkoutRecord[]>;
  /** Sleep analysis records overlapping the range, oldest first, at most `limit`. */
  sleep(range: DateRange, limit: number): Promise<SleepRecord[]>;
  /** A profile value such as blood type, or undefined when it isn't set. */
  characteristic(type: HealthType): Promise<string | undefined>;
}

/**
 * The unit Polso asks HealthKit for when reading a quantity for agents. Rates stored per second
 * (heart rate, breathing) are read per minute, the way people state them.
 */
export function agentUnit(type: HealthType): string | undefined {
  return type.unit === "count/s" ? "count/min" : type.unit;
}

/** HealthKit's percent unit runs from 0 to 1; agents get 0 to 100. */
export function agentValue(quantity: number, unit: string | undefined): number {
  return unit === "%" ? quantity * 100 : quantity;
}
