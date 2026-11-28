# Polso server

The self-hosted half of Polso: one Node process and one SQLite database that keep a copy of
your Health data. Your phone sends what changed in HealthKit, as described in the
[sync protocol](../../docs/sync-protocol.md).

One server serves one person. Pair your own phones with it, and nobody else's.

Development preview: nothing is ready to install yet, and the MCP endpoint for agents isn't
here yet.

## What it stores

A copy of the Health records your phone can read and syncs: quantity and category samples
(heart rate, steps, sleep stages and so on), workouts, HealthKit's daily statistics, and profile
values such as blood type. It also stores the hashes of pairing codes and device tokens, never
the codes or tokens themselves.

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
polso-server admin devices revoke --all  # the off switch: every phone, and unused links
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

There's nothing to back up: the phone holds the original data, and a new or erased server gets
everything again from the phone.

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
