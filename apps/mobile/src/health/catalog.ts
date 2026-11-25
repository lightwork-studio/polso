import { CATEGORY_TYPES, QUANTITY_TYPES } from "./types.generated";

/** How Polso reads a type, which decides the HealthKit query behind it. */
export type HealthKind =
  | "quantity"
  | "category"
  | "correlation"
  | "workout"
  | "workoutRoute"
  | "electrocardiogram"
  | "heartbeatSeries"
  | "audiogram"
  | "stateOfMind"
  | "activitySummary"
  | "characteristic";

export interface HealthType {
  /** The HealthKit identifier Polso requests read access to. */
  readonly id: string;
  readonly kind: HealthKind;
  readonly label: string;
  /** Canonical unit for quantity types. */
  readonly unit?: string;
  /** Category value names, by raw value. */
  readonly values?: Readonly<Record<string, string>>;
}

export type HealthGroup =
  | "Measurements"
  | "Events and symptoms"
  | "Workouts"
  | "Records"
  | "Profile";

export const GROUP_ORDER: readonly HealthGroup[] = [
  "Measurements",
  "Events and symptoms",
  "Workouts",
  "Records",
  "Profile",
];

const GROUP_BY_KIND: Record<HealthKind, HealthGroup> = {
  quantity: "Measurements",
  category: "Events and symptoms",
  workout: "Workouts",
  workoutRoute: "Workouts",
  correlation: "Records",
  electrocardiogram: "Records",
  heartbeatSeries: "Records",
  audiogram: "Records",
  stateOfMind: "Records",
  activitySummary: "Records",
  characteristic: "Profile",
};

export const groupOf = (type: HealthType): HealthGroup => GROUP_BY_KIND[type.kind];

const PREFIXES = [
  "HKQuantityTypeIdentifier",
  "HKCategoryTypeIdentifier",
  "HKCorrelationTypeIdentifier",
  "HKCharacteristicTypeIdentifier",
];

/**
 * Turns a HealthKit identifier into a readable label: "HKQuantityTypeIdentifierVO2Max" becomes
 * "VO2 max". Words in capitals, such as SDNN, keep their case.
 */
export function labelFor(id: string): string {
  const prefix = PREFIXES.find((p) => id.startsWith(p));
  const name = prefix ? id.slice(prefix.length) : id;
  const words = name
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(" ");
  return words
    .map((word, i) => {
      if (/^[A-Z\d]{2,}$/.test(word)) return word;
      return i === 0 ? word : word.toLowerCase();
    })
    .join(" ");
}

/** Turns a value name such as "asleepREM" into "Asleep REM". */
export function valueLabel(name: string): string {
  const label = labelFor(name);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

const other = (id: string, kind: HealthKind, label: string): HealthType => ({ id, kind, label });

/**
 * Every type Polso asks to read: all current quantity and category types, plus the other kinds
 * HealthKit grants through the same permission sheet. Types that need their own per-object
 * authorization (medications, vision prescriptions) and clinical records are not included.
 */
export const HEALTH_TYPES: readonly HealthType[] = [
  ...QUANTITY_TYPES.map(
    (q): HealthType => ({
      id: q.id,
      kind: "quantity",
      label: labelFor(q.id),
      ...(q.unit ? { unit: q.unit } : {}),
    }),
  ),
  ...CATEGORY_TYPES.map(
    (c): HealthType => ({ id: c.id, kind: "category", label: labelFor(c.id), values: c.values }),
  ),
  other("HKCorrelationTypeIdentifierBloodPressure", "correlation", "Blood pressure"),
  other("HKCorrelationTypeIdentifierFood", "correlation", "Food"),
  other("HKWorkoutTypeIdentifier", "workout", "Workouts"),
  other("HKWorkoutRouteTypeIdentifier", "workoutRoute", "Workout routes"),
  other("HKElectrocardiogramType", "electrocardiogram", "Electrocardiograms"),
  other("HKDataTypeIdentifierHeartbeatSeries", "heartbeatSeries", "Heartbeat series"),
  other("HKAudiogramSampleType", "audiogram", "Audiograms"),
  other("HKStateOfMindTypeIdentifier", "stateOfMind", "State of mind"),
  other("HKActivitySummaryTypeIdentifier", "activitySummary", "Activity rings"),
  other("HKCharacteristicTypeIdentifierBiologicalSex", "characteristic", "Biological sex"),
  other("HKCharacteristicTypeIdentifierBloodType", "characteristic", "Blood type"),
  other("HKCharacteristicTypeIdentifierDateOfBirth", "characteristic", "Date of birth"),
  other("HKCharacteristicTypeIdentifierFitzpatrickSkinType", "characteristic", "Skin type"),
  other("HKCharacteristicTypeIdentifierWheelchairUse", "characteristic", "Wheelchair use"),
  other("HKCharacteristicTypeIdentifierActivityMoveMode", "characteristic", "Activity move mode"),
];
