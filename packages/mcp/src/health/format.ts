import { type HealthType, valueLabel } from "./catalog.ts";

const whole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const precise = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 3 });
// Three significant digits keep small values, such as 0.0004 S, from rounding to zero.
const number = (n: number) => (Math.abs(n) >= 100 ? whole : precise).format(n);

// Effort scores are plain 1-10 numbers; the others are HealthKit unit strings people don't read.
const DISPLAY_UNITS: Record<string, string> = { degC: "°C", dBASPL: "dB", appleEffortScore: "" };

const HEART_RATES = new Set([
  "HKQuantityTypeIdentifierHeartRate",
  "HKQuantityTypeIdentifierRestingHeartRate",
  "HKQuantityTypeIdentifierWalkingHeartRateAverage",
  "HKQuantityTypeIdentifierHeartRateRecoveryOneMinute",
]);

/** Formats a quantity of the type `id`, read in the HealthKit unit string `unit`. */
export function formatQuantity(quantity: number, unit: string, id = ""): string {
  // Rates are read per second or per minute; people know them per minute.
  if (unit === "count/s" || unit === "count/min") {
    const perMinute = number(unit === "count/s" ? quantity * 60 : quantity);
    return HEART_RATES.has(id) ? `${perMinute} bpm` : `${perMinute}/min`;
  }
  // HealthKit's percent unit runs from 0 to 1.
  if (unit === "%") return `${number(quantity * 100)}%`;
  // Micronutrients are logged in grams but are thousandths or millionths of one.
  if (unit === "g" && quantity !== 0 && Math.abs(quantity) < 1) {
    return Math.abs(quantity) >= 0.001
      ? `${number(quantity * 1e3)} mg`
      : `${number(quantity * 1e6)} mcg`;
  }
  const shown = unit === "count" ? "" : (DISPLAY_UNITS[unit] ?? unit);
  return shown ? `${number(quantity)} ${shown}` : number(quantity);
}

/** Names a category value, falling back to the raw number for values the schema doesn't know. */
export function formatCategory(type: HealthType, value: number): string {
  const name = type.values?.[String(value)];
  if (name === undefined) return `Value ${value}`;
  // Types such as mindful sessions have no values; a record is just an occurrence.
  if (name === "notApplicable") return "Recorded";
  return valueLabel(name);
}

export function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** The ISO calendar date in the phone's time zone, e.g. "2026-11-25". */
export function formatDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const year = String(date.getFullYear()).padStart(4, "0");
  return `${year}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
