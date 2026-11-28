# Polso server

The self-hosted half of Polso: one Node process and one SQLite database that keep a copy of
your Health data. Your phone sends what changed in HealthKit, as described in the
[sync protocol](../../docs/sync-protocol.md), and your agents read it over MCP at
`https://<server>/mcp`, around the clock.

One server serves one person. Pair your own phones with it, and nobody else's.

Development preview: nothing is ready to install yet.

## Agents

The server offers the same six read-only tools as the phone's own endpoint: the list of types,
the latest value, records, daily statistics, workouts and sleep by night. It answers from its
copy, so the data is as fresh as the phone's last sync. Days are the phone's days: the server
works in the time zone the phone last sent. `list_health_types` lists the types the server holds
data for.

Each agent gets its own token from `polso-server admin agents add <name>`. The command prints
the token once, with a ready-made `claude mcp add` command and a JSON config for other MCP
clients. The server keeps only the token's hash. `agents revoke` takes a token away at once.

Agents send the token as `Authorization: Bearer <token>`. Requests without a valid agent token,
including a phone's device token, get `401` before the server reads their body, and requests
from web pages (with an `Origin` header) get `403`.

Every records query reads the records it returns plus those starting in the two days before the
asked range, and the rare records longer than two days, so no question about any period scans the
whole history, whatever any one record's length. A paired phone can still slow agents down by
uploading masses of records; it's trusted with your data anyway.

Daily statistics cover whole days: asked for a range that ends partway through a day, the
server returns that whole day's value, where the phone would stop at the given time.

What agents read is text your phones sent, such as source names from the apps that wrote to
Health. The server tells agents to treat it as data, not as instructions.

To go back to the server version before agent tokens, which refuses a database it doesn't
know, stop the server and run this in the data directory with the `sqlite3` command-line tool
(`sqlite3 polso.db`). It deletes every agent token; the Health data and paired phones stay.

```sql
BEGIN;
DROP TABLE agents;
DROP INDEX samples_by_type_and_start;
DROP INDEX samples_long;
DROP INDEX workouts_by_start;
DROP INDEX workouts_long;
CREATE INDEX samples_by_type_and_end ON samples (type, end_ms);
CREATE INDEX workouts_by_end ON workouts (end_ms);
PRAGMA user_version = 1;
COMMIT;
```

## What it stores

A copy of the Health records your phone can read and syncs: quantity and category samples
(heart rate, steps, sleep stages and so on), workouts, HealthKit's daily statistics, and profile
values such as blood type. It also stores the hashes of pairing codes, device tokens and agent
tokens, never the codes or tokens themselves.

The server has to read the data to answer agents, so it can't be end-to-end encrypted. It's
protected by the server's disk and file permissions: the data directory and everything in it is
readable only by the server's user, and the server tightens them when it starts. Run the server
on a machine you control, with full-disk encryption: deleting data doesn't wipe the disk blocks
it was on.

Nothing caps how much a paired phone stores. Years of heart-rate data take a few hundred MB.

## Run

```sh
POLSO_DATA=./data POLSO_PUBLIC_URL=https://polso.example.com pnpm --filter @polso/server start
```

| Setting            | Meaning                                                                   |
| ------------------ | ------------------------------------------------------------------------- |
| `POLSO_DATA`       | Directory for the database (default `./data`)                             |
| `POLSO_PUBLIC_URL` | The server's https address, as phones reach it, for pairing links         |
| `POLSO_PAIRING`    | `off` stops pairing new phones; paired phones keep syncing (default `on`) |
| `POLSO_HOST`       | The address to listen on (default `127.0.0.1`). Put HTTPS in front of it  |
| `POLSO_PORT`       | The port to listen on (default `8788`)                                    |

The server speaks plain HTTP on the address it listens on. Put a reverse proxy with HTTPS in
front of it, or reach it over Tailscale (`tailscale serve`), so tokens and Health data never
cross a network unencrypted. Let the proxy pass request bodies up to 8 MB (in nginx,
`client_max_body_size 8m`). One server uses a data directory at a time, and a second refuses to
start while the first runs. Keep the data directory on a local disk.

## Pair a phone and manage the data

`polso-server admin` works on the same database while the server runs. Run it as the server's
user, with the same `POLSO_DATA`. It uses the public address and pairing setting the server last
started with, unless you set them for the command. It refuses to run where there's no database,
so a mistyped `POLSO_DATA` can't report success while doing nothing, and it leaves schema
changes to the server: after an upgrade, restart the server before running admin commands.

```sh
polso-server admin pair                  # one-time pairing link, valid 15 minutes
polso-server admin devices list          # paired phones and when each was last seen
polso-server admin devices revoke <id>   # unpair one phone; its token stops working at once
polso-server admin devices revoke --all  # every phone, and unused links
polso-server admin agents add <name>     # an agent's token for the MCP endpoint, shown once
polso-server admin agents list           # agents and when each last read
polso-server admin agents revoke <id>    # take one agent's token away (or --all)
polso-server admin status                # how much Health data the server holds
polso-server admin erase --yes           # delete every copied Health record
```

Open the pairing link on the iPhone, or show it as a QR code for the phone's camera
(`qrencode -t ansiutf8 '<link>'`). The link opens a page on the server that hands the code to
Polso. The code is in the link's fragment, which browsers don't send, so it stays out of access
logs.

**Erase** deletes the Health records, with SQLite's secure delete, and empties the write-ahead
log. Paired phones stay paired and send their whole history again on their next sync. To stop
that, revoke them first. To remove everything, stop the server and delete the data directory.

If you withdraw Polso's access to a Health type on the phone, iOS doesn't tell Polso, so the
server keeps that type's old records. Erase the data, and the phone sends what it can still read.

**Off switches:** `devices revoke --all` stops every phone from sending data, and
`agents revoke --all` stops every agent from reading it. Stopping the server stops both.

There's no Health data to back up: the phone holds the original, and a new or erased server gets
everything again from the phone. Agent tokens live only on the server; after losing it, add them
again.

## Install

`pnpm --filter @polso/server bundle` builds one file, `dist/polso-server.mjs`, that runs with
Node 22.18 or later and nothing else:

```sh
useradd --system --user-group --home-dir /var/lib/polso --shell /usr/sbin/nologin polso
install -m 0755 apps/server/dist/polso-server.mjs /usr/local/bin/polso-server
```

Save as `/etc/systemd/system/polso.service`:

```ini
[Unit]
Description=Polso server
Wants=network-online.target
After=network-online.target

[Service]
User=polso
Group=polso
Environment=POLSO_DATA=/var/lib/polso
Environment=POLSO_PUBLIC_URL=https://polso.example.com
ExecStart=/usr/local/bin/polso-server serve
StateDirectory=polso
StateDirectoryMode=0700
UMask=0077
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Then `systemctl enable --now polso`, and run admin commands with
`sudo -u polso POLSO_DATA=/var/lib/polso polso-server admin <command>`.

## License

The server is under the [GNU Affero General Public License v3.0 only](../../LICENSES/AGPL-3.0-only.txt).
If you run a modified version for others, offer them its source.
