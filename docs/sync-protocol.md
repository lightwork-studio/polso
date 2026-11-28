# Sync protocol

How Polso copies Health data from the phone to a self-hosted server (`apps/server`). Sync runs
one way: the phone sends what changed in HealthKit, and the server keeps a copy that agents read
over MCP. Nothing flows back, so there are no conflicts to merge.

Version 1. Every path starts with `/sync/v1/`. A change that an existing phone or server can't
handle gets a new version; the server keeps answering the old one until phones have moved on.

## Pairing

The server's operator makes a one-time pairing link (`polso-server admin pair`), of the form
`https://<server>/pair#<code>`. The page at that address hands the code and the server's address
to the app. The code sits in the fragment, which browsers don't send, so it never reaches the
server or a proxy log. It's valid for 15 minutes and works once.

```http
POST /sync/v1/pair
Content-Type: application/json

{ "code": "<pairing code>", "device": "iPhone" }
```

`200` answers `{ "token": "<device token>" }`. The phone keeps the token in its Keychain and sends
it as `Authorization: Bearer <token>` from then on. A wrong, used or expired code gets `401`.

Codes and device tokens are 32 random bytes in base64url. The server stores only their SHA-256
hashes. Revoking a device (`polso-server admin devices revoke`) makes its token fail at once.

## Changes

```http
POST /sync/v1/changes
Authorization: Bearer <device token>
Content-Type: application/json
```

The body holds what changed since the phone's last successful upload. Every field is optional:

```jsonc
{
  // The phone's time zone. Days in dailyStats are days in this zone.
  "timeZone": "Europe/Berlin",
  // Quantity and category records, by HealthKit's UUID. Sleep is a category.
  "samples": [
    {
      "id": "1F0E…",
      "type": "HKQuantityTypeIdentifierHeartRate",
      "start": "2026-11-27T07:01:00.000Z",
      "end": "2026-11-27T07:01:00.000Z",
      "value": 62, // A number for quantities, in "unit"
      "unit": "count/min",
      "source": "Apple Watch"
    },
    {
      "id": "8C2A…",
      "type": "HKCategoryTypeIdentifierSleepAnalysis",
      "start": "2026-11-26T22:40:00.000Z",
      "end": "2026-11-27T00:10:00.000Z",
      "value": "asleepCore", // The value's name for categories
      "source": "Apple Watch"
    }
  ],
  "workouts": [
    {
      "id": "51D7…",
      "activity": "running",
      "start": "2026-11-27T06:00:00.000Z",
      "end": "2026-11-27T06:41:00.000Z",
      "durationMinutes": 41,
      "energy": { "value": 402, "unit": "kcal" },
      "distance": { "value": 7.9, "unit": "km" },
      "source": "Apple Watch"
    }
  ],
  // UUIDs of records deleted in HealthKit: samples or workouts.
  "deleted": ["7AB0…"],
  // HealthKit's own daily statistics, which merge overlapping sources (an iPhone and a Watch
  // both counting steps), so the server never adds them up itself. Each entry replaces every
  // stored value of that type and statistic from "from" to "to"; days left out had no data.
  "dailyStats": [
    {
      "type": "HKQuantityTypeIdentifierStepCount",
      "statistic": "sum", // sum, average, min or max
      "from": "2026-11-20",
      "to": "2026-11-27",
      "values": [{ "day": "2026-11-27", "value": 8412 }]
    }
  ],
  // Profile values such as blood type. null clears one.
  "characteristics": { "HKCharacteristicTypeIdentifierBloodType": "A+" }
}
```

Values are in the units agents get, as the phone's MCP endpoint reports them: rates per minute,
percentages from 0 to 100.

The server applies a request in one transaction: records are stored or replaced by `id`, then
deletions remove records with those ids, so a record both sent and deleted ends up deleted. The
same request sent twice leaves the same result, so the phone retries any upload that didn't get
a `200`, and moves its HealthKit anchors on only after one.

`200` answers `{ "ok": true, "generation": "<id>" }`. The generation names the server's copy of
the data. It changes when the operator erases the data (`polso-server admin erase`). A phone
that gets a generation other than the one it last saw starts over: it resets its anchors and
sends its whole history again. That also covers a server restored from an older backup. Send
an empty body (`{}`) to learn the generation without changing anything.

A malformed request gets `400` with a message, and nothing from
it is stored. Type identifiers are checked for their form, not against the server's list of
types, so a phone that knows a newer type doesn't stall on an older server.

### Limits

| Limit                              | Value  |
| ---------------------------------- | ------ |
| Request body                       | 8 MB   |
| `samples` plus `workouts`          | 5,000  |
| `deleted`                          | 20,000 |
| `dailyStats` entries               | 500    |
| `values` in one `dailyStats` entry | 4,000  |
| Text fields (`source`, `unit`, …)  | 200    |

A phone with more to send splits it into several requests. A request over a limit gets `413` or
`400`.

## Requests from browsers

Requests that carry an `Origin` header are refused with `403`, so a web page can't send a stolen
token from someone's browser.
