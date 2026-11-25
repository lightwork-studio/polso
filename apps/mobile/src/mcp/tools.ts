import { GROUP_ORDER, groupOf, type HealthGroup, type HealthType } from "../health/catalog";
import { formatDay } from "../health/format";
import { agentUnit, type DateRange, type HealthQueries, type Statistic } from "../health/queries";
import { summarizeNights } from "./sleep";

/** What a tool call needs: the types this phone has, the reads, and the current time. */
export interface ToolContext {
  readonly types: readonly HealthType[];
  readonly queries: HealthQueries;
  readonly now: Date;
}

/** A mistake in the arguments; reported to the agent so it can correct the call. */
export class ToolInputError extends Error {}

export interface ToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations: Record<string, unknown>;
}

const DAY = 24 * 60 * 60 * 1000;
const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

const typeArg = {
  type: "string",
  description:
    'A type from list_health_types, by its short name ("StepCount") or full HealthKit identifier.',
};
const startArg = {
  type: "string",
  description:
    "Start of the range: an ISO 8601 date-time, or a date (YYYY-MM-DD) meaning local midnight. Defaults to 7 days before the end.",
};
const endArg = {
  type: "string",
  description:
    "End of the range: an ISO 8601 date-time, or a date meaning the end of that local day. Defaults to now.",
};
const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

export const TOOLS: readonly ToolDefinition[] = [
  {
    name: "list_health_types",
    title: "List Health data types",
    description:
      "Lists the Apple Health data types this iPhone can read, with their short names, groups and units. Call it first to find the type to ask about. Polso can only read types the person allowed; others return no data.",
    inputSchema: object({
      group: { type: "string", enum: GROUP_ORDER, description: "Only list types in this group." },
    }),
    annotations: readOnly,
  },
  {
    name: "get_latest",
    title: "Get the latest value",
    description:
      "Returns the most recent record of a measurement or event (such as resting heart rate, weight or a sleep stage), or a profile value such as blood type.",
    inputSchema: object({ type: typeArg }, ["type"]),
    annotations: readOnly,
  },
  {
    name: "get_samples",
    title: "Get records",
    description:
      "Returns individual records of a measurement or event type in a time range, newest first, with their source app or device.",
    inputSchema: object(
      {
        type: typeArg,
        start: startArg,
        end: endArg,
        limit: { type: "integer", minimum: 1, maximum: 1000, description: "Defaults to 100." },
      },
      ["type"],
    ),
    annotations: readOnly,
  },
  {
    name: "get_daily_stats",
    title: "Get daily statistics",
    description:
      "Returns one value per local day for a measurement: the day's total for types that add up (steps, active energy), or its average, minimum or maximum for the others (heart rate, weight). Health removes duplicates between sources. At most 366 days.",
    inputSchema: object(
      {
        type: typeArg,
        start: {
          ...startArg,
          description:
            "The first local day to include. Defaults to six calendar days before the end date.",
        },
        end: endArg,
        statistic: {
          type: "string",
          enum: ["sum", "average", "min", "max"],
          description: "Defaults to sum for types that add up, average for the others.",
        },
      },
      ["type"],
    ),
    annotations: readOnly,
  },
  {
    name: "get_workouts",
    title: "Get workouts",
    description:
      "Returns workouts in a time range, newest first, with activity, duration, energy and distance.",
    inputSchema: object({
      start: startArg,
      end: endArg,
      limit: { type: "integer", minimum: 1, maximum: 200, description: "Defaults to 50." },
    }),
    annotations: readOnly,
  },
  {
    name: "get_sleep",
    title: "Get sleep by night",
    description:
      "Returns one summary per night: bedtime, wake time, minutes asleep and minutes per sleep stage. A night is named by the date it starts on and runs noon to noon, so sleep past noon counts for the next night. Bedtime and wake time are those of the night's main sleep; the minutes include naps. Each night uses one source so overlapping records aren't counted twice. At most 92 nights; defaults to the last 7.",
    inputSchema: object({
      start: { type: "string", description: "The first night, as a date (YYYY-MM-DD)." },
      end: { type: "string", description: "The last night, as a date. Defaults to last night." },
    }),
    annotations: readOnly,
  },
];

// --- Arguments ---

type Args = Record<string, unknown>;

function string(args: Args, name: string): string | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new ToolInputError(`"${name}" must be a string.`);
  return value;
}

function integer(args: Args, name: string, fallback: number, max: number): number {
  const value = args[name] ?? fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
    throw new ToolInputError(`"${name}" must be a whole number from 1 to ${max}.`);
  }
  return value;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)?$/;
const HOUR = 60 * 60 * 1000;

/** Local midnight (or `hour`) of a calendar date plus `days`; years below 100 work too. */
function localDay(year: number, month: number, day: number, days = 0, hour = 0): Date {
  const date = new Date(0);
  date.setHours(hour, 0, 0, 0);
  date.setFullYear(year, month - 1, day + days);
  return date;
}
const dayOf = (date: Date) => localDay(date.getFullYear(), date.getMonth() + 1, date.getDate());
const addDays = (date: Date, days: number, hour = 0) =>
  localDay(date.getFullYear(), date.getMonth() + 1, date.getDate(), days, hour);

function calendarDay(year: number, month: number, day: number): Date {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date;
}

/** Calendar days from one local date to another, unaffected by daylight saving. */
const dayNumber = (date: Date) =>
  calendarDay(date.getFullYear(), date.getMonth() + 1, date.getDate()).getTime() / DAY;

function parseDate(text: string, name: string, endOfDay: boolean, dateOnly = false): Date {
  const invalid = () =>
    new ToolInputError(`"${name}" must be an ISO 8601 ${dateOnly ? "date" : "date or date-time"}.`);
  const day = DATE_ONLY.exec(text);
  const match = day ?? (dateOnly ? null : DATE_TIME.exec(text));
  if (!match) throw invalid();
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const calendarDate = calendarDay(y, m, d);
  if (calendarDate.getUTCMonth() !== m - 1 || calendarDate.getUTCDate() !== d) throw invalid();
  if (day) {
    return endOfDay ? new Date(localDay(y, m, d, 1).getTime() - 1) : localDay(y, m, d);
  }
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw invalid();
  return date;
}

function range(args: Args, ctx: ToolContext, maxDays: number): DateRange {
  const endText = string(args, "end");
  const startText = string(args, "start");
  const end = endText === undefined ? ctx.now : parseDate(endText, "end", true);
  const start =
    startText === undefined
      ? new Date(end.getTime() - 7 * DAY)
      : parseDate(startText, "start", false);
  if (start >= end) throw new ToolInputError('"start" must be before "end".');
  // An hour of slack, so a range across a daylight saving change still fits.
  if (end.getTime() - start.getTime() > maxDays * DAY + HOUR) {
    throw new ToolInputError(`The range can be at most ${maxDays} days.`);
  }
  return { start, end };
}

const PREFIXES = [
  "HKQuantityTypeIdentifier",
  "HKCategoryTypeIdentifier",
  "HKCorrelationTypeIdentifier",
  "HKCharacteristicTypeIdentifier",
];

const OTHER_NAMES: Record<string, string> = {
  HKWorkoutTypeIdentifier: "Workout",
  HKWorkoutRouteTypeIdentifier: "WorkoutRoute",
  HKElectrocardiogramType: "Electrocardiogram",
  HKDataTypeIdentifierHeartbeatSeries: "HeartbeatSeries",
  HKAudiogramSampleType: "Audiogram",
  HKStateOfMindTypeIdentifier: "StateOfMind",
  HKActivitySummaryTypeIdentifier: "ActivitySummary",
};

/** The name agents use for a type: its identifier without HealthKit's prefix. */
export function shortName(id: string): string {
  const prefix = PREFIXES.find((p) => id.startsWith(p));
  return prefix ? id.slice(prefix.length) : (OTHER_NAMES[id] ?? id);
}

function findType(args: Args, ctx: ToolContext, kinds?: readonly string[]): HealthType {
  const name = string(args, "type");
  if (!name) throw new ToolInputError('"type" is required.');
  const wanted = name.toLowerCase();
  const type = ctx.types.find(
    (t) => t.id.toLowerCase() === wanted || shortName(t.id).toLowerCase() === wanted,
  );
  if (!type) {
    throw new ToolInputError(`Unknown type "${name}". Call list_health_types for the names.`);
  }
  if (kinds && !kinds.includes(type.kind)) {
    const tools = toolsFor(type);
    throw new ToolInputError(
      tools.length > 0
        ? `"${shortName(type.id)}" doesn't work with this tool; use ${tools.join(" or ")}.`
        : `Polso can't read "${shortName(type.id)}" yet.`,
    );
  }
  return type;
}

const SLEEP_ID = "HKCategoryTypeIdentifierSleepAnalysis";

/** The tools that can read a type, so agents know where to go. */
export function toolsFor(type: HealthType): string[] {
  switch (type.kind) {
    case "quantity":
      return ["get_latest", "get_samples", "get_daily_stats"];
    case "category":
      return type.id === SLEEP_ID
        ? ["get_sleep", "get_latest", "get_samples"]
        : ["get_latest", "get_samples"];
    case "characteristic":
      return ["get_latest"];
    case "workout":
      return ["get_workouts"];
    default:
      return [];
  }
}

const iso = (date: Date) => date.toISOString();

// --- Tools ---

async function listTypes(args: Args, ctx: ToolContext) {
  const group = string(args, "group") as HealthGroup | undefined;
  if (group && !GROUP_ORDER.includes(group)) {
    throw new ToolInputError(`"group" must be one of ${GROUP_ORDER.join(", ")}.`);
  }
  const types = ctx.types
    .filter((t) => !group || groupOf(t) === group)
    .map((t) => ({
      type: shortName(t.id),
      label: t.label,
      group: groupOf(t),
      tools: toolsFor(t),
      ...(t.kind === "quantity" && { unit: agentUnit(t), aggregation: t.aggregation }),
      // Records name the "notApplicable" value "recorded" (see the HealthKit adapter); match them.
      ...(t.kind === "category" &&
        t.values && {
          values: Object.values(t.values).map((v) => (v === "notApplicable" ? "recorded" : v)),
        }),
    }));
  return { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, types };
}

async function getLatest(args: Args, ctx: ToolContext) {
  const type = findType(args, ctx, ["quantity", "category", "characteristic"]);
  if (type.kind === "characteristic") {
    return { type: shortName(type.id), value: (await ctx.queries.characteristic(type)) ?? null };
  }
  const [record] = await ctx.queries.samples(type, { start: new Date(0), end: ctx.now }, 1);
  if (!record) return { type: shortName(type.id), latest: null };
  return {
    type: shortName(type.id),
    latest: { ...record, start: iso(record.start), end: iso(record.end) },
  };
}

async function getSamples(args: Args, ctx: ToolContext) {
  const type = findType(args, ctx, ["quantity", "category"]);
  const limit = integer(args, "limit", 100, 1000);
  const r = range(args, ctx, 3660);
  const records = await ctx.queries.samples(type, r, limit);
  return {
    type: shortName(type.id),
    start: iso(r.start),
    end: iso(r.end),
    records: records.map((s) => ({ ...s, start: iso(s.start), end: iso(s.end) })),
    truncated: records.length === limit,
  };
}

async function getDailyStats(args: Args, ctx: ToolContext) {
  const type = findType(args, ctx, ["quantity"]);
  const cumulative = type.aggregation === "cumulative";
  const statistic = (string(args, "statistic") ?? (cumulative ? "sum" : "average")) as Statistic;
  if (!["sum", "average", "min", "max"].includes(statistic)) {
    throw new ToolInputError('"statistic" must be sum, average, min or max.');
  }
  if (cumulative !== (statistic === "sum")) {
    throw new ToolInputError(
      cumulative
        ? `"${shortName(type.id)}" adds up over a day, so only "sum" applies.`
        : `"${shortName(type.id)}" doesn't add up over a day; use average, min or max.`,
    );
  }
  const endText = string(args, "end");
  const startText = string(args, "start");
  const end = endText === undefined ? ctx.now : parseDate(endText, "end", true);
  const start = startText === undefined ? addDays(end, -6) : parseDate(startText, "start", false);
  if (start > end) throw new ToolInputError('"start" must not be after "end".');
  if (dayNumber(end) - dayNumber(start) >= 366) {
    throw new ToolInputError("The range can be at most 366 days.");
  }
  const r = { start: dayOf(start), end };
  const days = await ctx.queries.dailyStats(type, r, statistic);
  return {
    type: shortName(type.id),
    statistic,
    unit: agentUnit(type),
    days: days.map((d) => ({ date: formatDay(d.day), value: d.value })),
  };
}

async function getWorkouts(args: Args, ctx: ToolContext) {
  const limit = integer(args, "limit", 50, 200);
  const r = range(args, ctx, 3660);
  const workouts = await ctx.queries.workouts(r, limit);
  return {
    workouts: workouts.map((w) => ({ ...w, start: iso(w.start), end: iso(w.end) })),
    truncated: workouts.length === limit,
  };
}

export const SLEEP_RECORD_LIMIT = 20_000;

/**
 * Sleep is asked for by night: `start` and `end` name the first and last night by the date it
 * starts on, and each night runs from noon to noon, so no night is cut off at either end.
 */
async function getSleep(args: Args, ctx: ToolContext) {
  const startText = string(args, "start");
  const endText = string(args, "end");
  const lastNight =
    endText === undefined ? addDays(ctx.now, -1) : parseDate(endText, "end", false, true);
  const firstNight =
    startText === undefined ? addDays(lastNight, -6) : parseDate(startText, "start", false, true);
  const count = dayNumber(lastNight) - dayNumber(firstNight) + 1;
  if (count < 1) throw new ToolInputError('"start" must not be after "end".');
  if (count > 92) throw new ToolInputError("The range can be at most 92 nights.");

  const window = { start: addDays(firstNight, 0, 12), end: addDays(lastNight, 1, 12) };
  const records = await ctx.queries.sleep(window, SLEEP_RECORD_LIMIT);
  const [first, last] = [formatDay(firstNight), formatDay(lastNight)];
  const nights = summarizeNights(records).filter((n) => n.night >= first && n.night <= last);
  // Records come oldest first, so a cut-off read ends inside its last night: leave that one out.
  const truncated = records.length === SLEEP_RECORD_LIMIT;
  if (truncated) nights.pop();
  return { nights, truncated };
}

const HANDLERS: Record<string, (args: Args, ctx: ToolContext) => Promise<unknown>> = {
  list_health_types: listTypes,
  get_latest: getLatest,
  get_samples: getSamples,
  get_daily_stats: getDailyStats,
  get_workouts: getWorkouts,
  get_sleep: getSleep,
};

export const isTool = (name: string) => Object.hasOwn(HANDLERS, name);

/** Runs a tool. Throws ToolInputError for bad arguments and passes on HealthKit errors. */
export async function callTool(name: string, args: Args, ctx: ToolContext): Promise<unknown> {
  const handler = HANDLERS[name];
  const tool = TOOLS.find((t) => t.name === name);
  if (!handler || !tool) throw new Error(`Unknown tool ${name}`);
  const known = Object.keys(tool.inputSchema.properties as object);
  const unknown = Object.keys(args).filter((key) => !known.includes(key));
  if (unknown.length > 0) {
    const list = (keys: string[]) => keys.map((k) => `"${k}"`).join(", ");
    throw new ToolInputError(
      `Unknown argument ${list(unknown)}. This tool takes ${list(known) || "no arguments"}.`,
    );
  }
  return handler(args, ctx);
}
