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

## Agent access

The **Agents** screen switches on the MCP endpoint on the phone. It's off every time Polso
starts, and it serves only while Polso is open and in front. Control Center, Notification Center
and incoming calls don't count as leaving. The screen stays awake while it serves, because iOS
suspends apps soon after they leave the screen.

- **Address:** `http://<phone>:8765/mcp` on every network interface, IPv4 and IPv6, including
  cellular. On any network that gives the phone a public IPv6 address, cellular or Wi-Fi, the
  endpoint can be reachable from the internet while it serves; the token still guards it.
  Devices on the phone's Personal Hotspot can reach it too. The screen shows the Wi-Fi address.
  Over Tailscale, use the phone's Tailscale address.
- **Token:** every request needs `Authorization: Bearer <token>`. The token is 256 random bits,
  kept in the Keychain on this device only. It's readable only while the phone is unlocked, and
  a backup restores it only to the same phone. **New token** stops serving and deletes the old
  token at once, locking out every agent that had it. Copied tokens stay on the clipboard until
  something else is copied, and Universal Clipboard can pass them to your other Apple devices.
- **Web pages** can't send the token, and requests that carry an `Origin` header are refused even
  with it, so a site open in a browser can't reach the endpoint.
- **Limits:**
  - one request per connection, which closes after the answer;
  - the head must arrive within 5 seconds and the whole request within 15;
  - Health data must be read within 60 seconds, and the answer taken within 30;
  - at most 8 open connections, so anyone on the network can keep agents out for as long as they
    hold them, and a flood of connections can also slow the app down; leaving Polso stops it;
  - requests are answered one at a time. A Health read that times out can't be cancelled, so
    until it finishes, other requests get 503.
- **Plain HTTP:** requests travel unencrypted, so anyone who can watch the network can see the
  token and the answers. Use agent access on your own Wi-Fi, or through Tailscale, which
  encrypts the traffic.

To turn it off, flip the switch, or leave Polso. Nothing listens while access is off.

The TCP server comes from `react-native-tcp-socket`, with a patch in `patches/` that stops a
connection reset at the wrong moment, or a flood of connections, from crashing the app.
