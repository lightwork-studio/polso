// Node stand-in for @kingstinct/react-native-healthkit, which needs the native module.
// Enum values match HealthKit's raw values.
import { vi } from "vitest";

export enum AuthorizationRequestStatus {
  unknown = 0,
  shouldRequest = 1,
  unnecessary = 2,
}
export enum BiologicalSex {
  notSet = 0,
  female = 1,
  male = 2,
  other = 3,
}
export enum BloodType {
  notSet = 0,
  aPositive = 1,
  aNegative = 2,
  bPositive = 3,
  bNegative = 4,
  abPositive = 5,
  abNegative = 6,
  oPositive = 7,
  oNegative = 8,
}
export enum FitzpatrickSkinType {
  notSet = 0,
  I = 1,
  II = 2,
  III = 3,
  IV = 4,
  V = 5,
  VI = 6,
}
export enum WheelchairUse {
  notSet = 0,
  notUsingWheelchair = 1,
  usingWheelchair = 2,
}
export enum WorkoutActivityType {
  cycling = 13,
  running = 37,
  traditionalStrengthTraining = 50,
}

export const isHealthDataAvailable = vi.fn(() => true);
export const areObjectTypesAvailable = vi.fn((ids: readonly string[]) =>
  Object.fromEntries(ids.map((id) => [id, true])),
);
export const getRequestStatusForAuthorization = vi.fn(
  async (_: unknown) => AuthorizationRequestStatus.shouldRequest,
);
export const requestAuthorization = vi.fn(async (_: unknown) => true);
export const getMostRecentQuantitySample = vi.fn(
  async (_id: string, _unit?: string): Promise<unknown> => undefined,
);
export const getMostRecentCategorySample = vi.fn(
  async (_id: string): Promise<unknown> => undefined,
);
export const queryWorkoutSamples = vi.fn(async (_: unknown): Promise<unknown[]> => []);
export const queryCorrelationSamples = vi.fn(
  async (_id: string, _: unknown): Promise<unknown[]> => [],
);
export const queryElectrocardiogramSamples = vi.fn(async (_: unknown): Promise<unknown[]> => []);
export const queryHeartbeatSeriesSamples = vi.fn(async (_: unknown): Promise<unknown[]> => []);
export const queryStateOfMindSamples = vi.fn(async (_: unknown): Promise<unknown[]> => []);
export const getBiologicalSexAsync = vi.fn(async () => BiologicalSex.notSet);
export const getBloodTypeAsync = vi.fn(async () => BloodType.notSet);
export const getFitzpatrickSkinTypeAsync = vi.fn(async () => FitzpatrickSkinType.notSet);
export const getWheelchairUseAsync = vi.fn(async () => WheelchairUse.notSet);
export const getDateOfBirthAsync = vi.fn(async (): Promise<Date | undefined> => undefined);
export const queryQuantitySamples = vi.fn(
  async (_id: string, _options: unknown): Promise<unknown[]> => [],
);
export const queryCategorySamples = vi.fn(
  async (_id: string, _options: unknown): Promise<unknown[]> => [],
);
export const queryStatisticsCollectionForQuantity = vi.fn(
  async (
    _id: string,
    _statistics: unknown,
    _anchor: Date,
    _interval: unknown,
    _options: unknown,
  ): Promise<unknown[]> => [],
);
