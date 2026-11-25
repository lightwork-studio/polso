import {
  AuthorizationRequestStatus,
  areObjectTypesAvailable,
  BiologicalSex,
  BloodType,
  type CategoryTypeIdentifier,
  type CorrelationTypeIdentifier,
  FitzpatrickSkinType,
  getBiologicalSexAsync,
  getBloodTypeAsync,
  getDateOfBirthAsync,
  getFitzpatrickSkinTypeAsync,
  getMostRecentCategorySample,
  getMostRecentQuantitySample,
  getRequestStatusForAuthorization,
  getWheelchairUseAsync,
  isHealthDataAvailable,
  type ObjectTypeIdentifier,
  type QuantityTypeIdentifier,
  queryCorrelationSamples,
  queryElectrocardiogramSamples,
  queryHeartbeatSeriesSamples,
  queryStateOfMindSamples,
  queryWorkoutSamples,
  requestAuthorization,
  WheelchairUse,
  WorkoutActivityType,
} from "@kingstinct/react-native-healthkit";
import { type HealthType, valueLabel } from "./catalog";
import { formatCategory, formatDay, formatDuration, formatQuantity } from "./format";
import type { HealthSource, Preview } from "./reader";

// The catalog holds plain strings; HealthKit's identifier types are unions of the same strings.
const asIds = (ids: readonly string[]) => ids as readonly ObjectTypeIdentifier[];
const newest = { limit: 1, ascending: false } as const;
const empty: Preview = { status: "empty" };

/** A record known only by its date, such as an ECG or a blood pressure reading. */
function recordedOn(samples: readonly { endDate: Date }[]): Preview {
  const sample = samples[0];
  return sample ? { status: "value", text: "Recorded", date: sample.endDate } : empty;
}

/** An enum value with a name, where 0 means the person hasn't set it. */
function enumValue(names: Record<number, string>, value: number): Preview {
  const name = names[value];
  return value === 0 || !name ? empty : { status: "value", text: valueLabel(name) };
}

// Blood types read better as "AB+" than as the enum's "abPositive".
const BLOOD_TYPES: Record<number, string> = {
  [BloodType.aPositive]: "A+",
  [BloodType.aNegative]: "A−",
  [BloodType.bPositive]: "B+",
  [BloodType.bNegative]: "B−",
  [BloodType.abPositive]: "AB+",
  [BloodType.abNegative]: "AB−",
  [BloodType.oPositive]: "O+",
  [BloodType.oNegative]: "O−",
};

async function latest(type: HealthType): Promise<Preview> {
  switch (type.kind) {
    case "quantity": {
      const sample = await getMostRecentQuantitySample(
        type.id as QuantityTypeIdentifier,
        type.unit as never,
      );
      if (!sample) return empty;
      return {
        status: "value",
        text: formatQuantity(sample.quantity, sample.unit, type.id),
        date: sample.endDate,
      };
    }
    case "category": {
      const sample = await getMostRecentCategorySample(type.id as CategoryTypeIdentifier);
      if (!sample) return empty;
      return {
        status: "value",
        text: formatCategory(type, Number(sample.value)),
        date: sample.endDate,
      };
    }
    case "workout": {
      const [workout] = await queryWorkoutSamples(newest);
      if (!workout) return empty;
      const activity = WorkoutActivityType[workout.workoutActivityType] ?? "workout";
      return {
        status: "value",
        text: `${valueLabel(activity)}, ${formatDuration(workout.duration.quantity)}`,
        date: workout.endDate,
      };
    }
    case "correlation":
      return recordedOn(
        await queryCorrelationSamples(type.id as CorrelationTypeIdentifier, newest),
      );
    case "electrocardiogram":
      return recordedOn(await queryElectrocardiogramSamples(newest));
    case "heartbeatSeries":
      return recordedOn(await queryHeartbeatSeriesSamples(newest));
    case "stateOfMind":
      return recordedOn(await queryStateOfMindSamples(newest));
    case "characteristic":
      return characteristic(type.id);
    case "workoutRoute":
    case "audiogram":
    case "activitySummary":
      return { status: "notPreviewed" };
  }
}

async function characteristic(id: string): Promise<Preview> {
  switch (id) {
    case "HKCharacteristicTypeIdentifierBiologicalSex":
      return enumValue(BiologicalSex, await getBiologicalSexAsync());
    case "HKCharacteristicTypeIdentifierBloodType":
      return enumValue(BLOOD_TYPES, await getBloodTypeAsync());
    case "HKCharacteristicTypeIdentifierFitzpatrickSkinType":
      return enumValue(FitzpatrickSkinType, await getFitzpatrickSkinTypeAsync());
    case "HKCharacteristicTypeIdentifierWheelchairUse":
      return enumValue(WheelchairUse, await getWheelchairUseAsync());
    case "HKCharacteristicTypeIdentifierDateOfBirth": {
      const date = await getDateOfBirthAsync();
      return date ? { status: "value", text: formatDay(date) } : empty;
    }
    default:
      return { status: "notPreviewed" };
  }
}

export const healthKit: HealthSource = {
  isHealthDataAvailable,
  availability: (ids) => areObjectTypesAvailable(asIds(ids)),
  needsRequest: async (ids) =>
    (await getRequestStatusForAuthorization({ toRead: asIds(ids) })) !==
    AuthorizationRequestStatus.unnecessary,
  requestRead: async (ids) => {
    await requestAuthorization({ toRead: asIds(ids) });
  },
  latest,
};
