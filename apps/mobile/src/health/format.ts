import { type HealthType, valueLabel } from "./catalog";

const numberFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

export function formatQuantity(quantity: number, unit: string): string {
  return unit === "count"
    ? numberFormat.format(quantity)
    : `${numberFormat.format(quantity)} ${unit}`;
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
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
