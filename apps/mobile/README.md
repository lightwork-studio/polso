# Polso app

The iPhone app. It's built with Expo and runs on iOS only, because HealthKit is iOS only.

```sh
pnpm exec expo run:ios    # from apps/mobile on a Mac: build and install Polso Dev
pnpm dev:app              # then start the dev server it connects to
```

Without a Mac, build Polso Dev on EAS with `eas build --profile development` from this directory.

Expo generates the `ios/` project from the app configuration and native dependencies. Keep native
changes in the config or config plugins so a clean checkout can build them. The generated project
and bundle exports are ignored by Git.

## App identities

`POLSO_APP_VARIANT` picks the app identity. Each variant has its own bundle ID, so all three can be
installed on one phone, each with its own Health permissions.

Only Polso Dev is linked to an EAS project so far (`@webertim/polso-dev`), so EAS builds of the
TestFlight and App Store apps stop at project linking until they get projects of their own.

| App           | iOS bundle ID          | `POLSO_APP_VARIANT`     |
| ------------- | ---------------------- | ----------------------- |
| Polso Dev     | `app.polso.dev`        | `development` (default) |
| Polso Preview | `app.polso.preview`    | `preview`               |
| Polso         | `app.polso.production` | `production`            |

If you distribute a fork, give it its own bundle IDs, name and icon, as described in the
[branding terms](../../TRADEMARKS.md).

## Health access

Polso asks to read every type in [`src/health/catalog.ts`](src/health/catalog.ts) that the phone's
iOS version has, and never asks to write. Blood pressure and food are read through their
component types (systolic and diastolic pressure, nutrients) rather than named in the request.
Medications, vision prescriptions and clinical records need their own authorization and aren't
requested yet. Background delivery is off until Polso syncs.

HealthKit doesn't tell apps which types a person declined, so the app can't tell "no access"
from "nothing recorded" and shows both as No data.

The quantity and category types come from the schema in `@kingstinct/react-native-healthkit`.
After upgrading that library, run `node scripts/health-types.mts` from this directory to refresh
`src/health/types.generated.ts`; a test fails until you do.
