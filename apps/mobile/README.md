# Polso app

The iPhone app. It's built with Expo and runs on iOS only, because HealthKit is iOS only.

```sh
pnpm dev:app    # Expo dev server for a development build
```

Expo generates the `ios/` project from the app configuration and native dependencies. Keep native
changes in the config or config plugins so a clean checkout can build them. The generated project
and bundle exports are ignored by Git.

## App identities

`POLSO_APP_VARIANT` picks the app identity. Each variant has its own bundle ID, so all three can be
installed on one phone, each with its own Health permissions.

| App           | iOS bundle ID          | `POLSO_APP_VARIANT`     |
| ------------- | ---------------------- | ----------------------- |
| Polso Dev     | `app.polso.dev`        | `development` (default) |
| Polso Preview | `app.polso.preview`    | `preview`               |
| Polso         | `app.polso.production` | `production`            |

If you distribute a fork, give it its own bundle IDs, name and icon, as described in the
[branding terms](../../TRADEMARKS.md).
