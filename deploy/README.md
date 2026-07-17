# Local server deployment (NUC7i3BNB, Ubuntu Server 24.04 LTS)

The app + Modbus poller run as two systemd services on the NUC. No Vercel, no Home Assistant.
This guide is written against the reference deployment's own hardware/network — any small
dedicated Linux box with two NICs (or one NIC + a USB adapter) works the same way; substitute
your own IPs/hostnames/device names throughout.

```
┌─ solinteg-poller.service ─┐   reads inverter over Modbus TCP every 30 s,
│  scripts/services/modbus_poller.py │   writes /opt/solinteg/live.json
└───────────┬───────────────┘
            │ live.json
            ▼
┌─ solinteg-web.service ────┐   Next.js reads live.json (lib/inverter.ts),
│  npm run start (port 3000)│   feeds live SoC into the optimizer
└───────────────────────────┘
```

## 1. Base OS

After the Ubuntu Server 24.04 install (on the new WD Blue SN550), update and create a service user:

```bash
sudo apt update && sudo apt upgrade -y
sudo useradd --system --create-home --home-dir /opt/solinteg --shell /usr/sbin/nologin solinteg
sudo mkdir -p /opt/solinteg/app
```

## 2. Node.js 24 LTS

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node --version   # expect v24.x
```

## 3. Deploy the app

```bash
# copy the repo to /opt/solinteg/app (git clone, scp, or rsync), then:
cd /opt/solinteg/app
npm ci
npm run build
```

## 4. Python poller venv

```bash
sudo apt install -y python3-venv
cd /opt/solinteg/app
python3 -m venv .venv
.venv/bin/pip install -r scripts/requirements.txt
```

## 5. Environment file

```bash
sudo cp deploy/solinteg.env.example /opt/solinteg/solinteg.env
sudo nano /opt/solinteg/solinteg.env      # set SOLINTEG_HOST etc.
sudo chmod 600 /opt/solinteg/solinteg.env
sudo chown -R solinteg:solinteg /opt/solinteg
```

## 6. Install + start services

```bash
sudo cp deploy/solinteg-poller.service /etc/systemd/system/
sudo cp deploy/solinteg-web.service    /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now solinteg-poller solinteg-web

# verify
systemctl status solinteg-poller
journalctl -u solinteg-poller -f          # watch live SoC readings
curl localhost:3000/api/inverter          # should return live JSON once the inverter is on LAN
```

## 7. Automated telemetry capture

The dashboard render logs the price curve + optimizer run to `telemetry.db`. To capture
this without relying on someone opening the page, a timer renders it on a schedule (hourly, plus 00:03 and 13:22/13:42 Stockholm — the timer file says why):

```bash
sudo cp deploy/solinteg-telemetry.service /etc/systemd/system/
sudo cp deploy/solinteg-telemetry.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now solinteg-telemetry.timer

systemctl list-timers solinteg-telemetry.timer   # confirm next run
sudo systemctl start solinteg-telemetry.service   # fire once now to test
```

The poller logs inverter `readings` continuously on its own; this timer only covers the
web-app side (`price_snapshots`, `optimizer_runs`), which otherwise fires only on page view.

## 8. Weather poller (Ecowitt)

Logs local solar irradiance (W/m²), temperature, wind, etc. from the Ecowitt GW1000 into the
same `telemetry.db`, for calibrating the solar forecast against measured site conditions.

```bash
sudo cp deploy/solinteg-weather.service /etc/systemd/system/
# set ECOWITT_APPLICATION_KEY / ECOWITT_API_KEY / ECOWITT_MAC in /opt/solinteg/solinteg.env
sudo systemctl daemon-reload
sudo systemctl enable --now solinteg-weather
journalctl -u solinteg-weather -f     # watch: solar=... W/m2  temp=... C  wind=...
```

Uses the Ecowitt cloud API (the gateway isn't reachable on the wired subnet). Stdlib-only,
so no extra pip installs. Rows are keyed by station observation time and deduped.

## 9. Alerting (watchdog, healthcheck, dead-man's switch)

Three more timer-triggered services, none of them long-running:

```bash
sudo cp deploy/solinteg-watchdog.service      deploy/solinteg-watchdog.timer \
        deploy/solinteg-healthcheck.service   deploy/solinteg-healthcheck.timer \
        deploy/solinteg-heartbeat-ping.service deploy/solinteg-heartbeat-ping.timer \
        /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now solinteg-watchdog.timer solinteg-healthcheck.timer \
        solinteg-heartbeat-ping.timer
```

**solinteg-watchdog** (every 2 min) is the safety-critical one: if `dispatch_loop.py`'s
heartbeat goes stale while control is armed, it connects to the inverter directly and
forces it back to auto — a hard crash (power loss, OOM kill) skips `dispatch_loop.py`'s own
clean-exit fail-safe entirely, so this is a second, independent process watching for exactly
that. It needs no external setup; it just needs to be running.

**solinteg-healthcheck** (every 5 min) and **solinteg-heartbeat-ping** (every 10 min) need
two accounts, both free, both one-time setup done in their own app/website — nothing to
install:

1. **ntfy** (push alerts) — install the [ntfy app](https://ntfy.sh/) on your phone (iOS/
   Android), open it, and subscribe to the topic you put in `NTFY_TOPIC` in
   `solinteg.env` (see the comment there for generating an unguessable one). That's it — no
   account, no signup. Test it once the services are running:
   ```bash
   curl -d "test alert" https://ntfy.sh/<your-topic>
   ```
   You should get a phone notification within a few seconds.

2. **healthchecks.io** (optional — detects a fully silent/powered-off NUC, which nothing
   running on the NUC itself can ever notice). Sign up free at
   [healthchecks.io](https://healthchecks.io/), create a check with a period of ~15 min and
   a grace time of ~10 min (comfortably above the 10-min ping interval), add a notification
   integration for it (they support ntfy directly, or a plain webhook to
   `https://ntfy.sh/<your-topic>` — either points the same alert at your phone), then copy
   its "ping URL" into `HEALTHCHECKS_PING_URL` in `solinteg.env`. Skip this and leave it
   blank if you'd rather not set up a third-party account right now — the other three
   alerting layers work independently of it.

The thresholds above are sane defaults — tune them from real data once you have some: query
`control_actions`/`readings` for your own timing and staleness distribution rather than guessing.

## 10. Passwordless read-only telemetry checks

Passwordless sudo was deliberately removed on the reference deployment, so
every `sudo -u solinteg sqlite3 ...` health check needs the login password typed in.
`scripts/services/telemetry-ro.sh` is a narrow exception: a root-owned wrapper that only implements a
few read-only shapes (a single validated `SELECT`, `journalctl` on an allowlisted `solinteg-*`
unit, or reading the heartbeat file) — everything else it rejects. One-time setup:

```bash
sudo cp scripts/services/telemetry-ro.sh /usr/local/bin/solinteg-telemetry-ro
sudo chown root:root /usr/local/bin/solinteg-telemetry-ro
sudo chmod 755 /usr/local/bin/solinteg-telemetry-ro

sudo cp deploy/solinteg-telemetry-ro.sudoers /etc/sudoers.d/solinteg-telemetry-ro
sudo chmod 440 /etc/sudoers.d/solinteg-telemetry-ro
sudo visudo -c   # must report "parsed OK" before trusting the new file
```

Usage (no password prompt):

```bash
sudo solinteg-telemetry-ro sql "SELECT outcome, COUNT(*) FROM control_actions GROUP BY outcome;"
sudo solinteg-telemetry-ro logs solinteg-dispatch "-24 hours"
sudo solinteg-telemetry-ro heartbeat
```

If `scripts/services/telemetry-ro.sh` changes, re-copy it to `/usr/local/bin/solinteg-telemetry-ro` and
re-apply the chown/chmod above — the sudoers rule points at that installed path, not the repo.

## 11. Remote access (Tailscale)

The dashboard is reachable off-LAN via Tailscale only — no router ports are open, and
`tailscale funnel` must never be enabled (the app has no auth). Setup on the NUC:
tailscaled installed from the official apt repo, node joined to your tailnet
(key expiry disabled in the admin console), and

```bash
sudo tailscale serve --bg 3000
```

serves `https://<your-node>.<your-tailnet>.ts.net` (e.g. `nuc.tailabc123.ts.net` —
run `tailscale status` to find yours) → `localhost:3000` for tailnet
devices only. MagicDNS + HTTPS Certificates are enabled in the admin console. LAN access
(`http://<nuc-ip>:3000`) is unchanged. The inverter and Modbus stay LAN-only: no
subnet routes are advertised. Check state with `tailscale status` and
`tailscale serve status`; disable with `sudo tailscale serve --https=443 off`.

## 12. Resilience (boot recovery, auto-reboot, hardware watchdog, backups, SMART)

Added 2026-07-07 so the NUC needs less hands-on tuning over time and recovers from a short
power outage on its own. This section assumes §1-11 are already done.

**Precondition — BIOS power-on behaviour is not set from software and must be checked once,
physically, at the machine:** power it off, enter your board's BIOS/UEFI setup (F2 at the
splash screen on Intel NUCs — the key and menu wording vary by board/vendor, often called
"Power On After Power Failure" or "AC Recovery"; on this reference board it's **Power →
Secondary Power Settings → After Power Failure**), and set it to **Power On** (not "Stay Off"
or "Last State" - "Last State" looks safe but replays whatever state it was in *when the power
cut*, which after an outage is "off"). Save and exit. Without this, everything below only helps
once the NUC is manually switched back on. While in there, if your board has a CMOS/RTC
coin-cell battery and it's more than a few years old, consider replacing it (any electronics
shop, a few minutes, no tools beyond a screwdriver for the base panel) — a dead one loses the
real-time clock on every real power loss (harmless here since NTP recovers it once the network
is back, but check your BIOS's firmware update page for a newer release while it's open
regardless). After all that, do a real test: pull the power cable for 10 seconds while nobody's
home-ish, plug back in, and confirm the "Solinteg: NUC booted" ntfy alert (below) arrives.

**12a. Boot notification** - proves the above worked, every time, not just once:
```bash
sudo cp deploy/solinteg-boot-notify.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable solinteg-boot-notify   # do NOT --now; it should fire once, at the next real boot
sudo systemctl start solinteg-boot-notify    # fire it once now anyway, just to confirm ntfy works
```

**12b. Auto-reboot after security updates** - unattended-upgrades already installs security
patches (confirmed already active on this box), but a kernel/libc update that needs a reboot
was otherwise sitting installed-but-inactive indefinitely:
```bash
sudo cp deploy/51unattended-upgrades-solinteg /etc/apt/apt.conf.d/
sudo unattended-upgrade --dry-run --debug   # sanity-check it parses with no errors
```
Reboots only happen when a pending update actually needs one, at 03:30, and won't be blocked
by a forgotten SSH session (see the file's own comments for why).

**12c. Hardware watchdog** - a kernel/systemd hang (not just a crashed service) gets a hard
reset with no software involved. `iTCO_wdt` is the Intel chipset watchdog module — if you're on
AMD hardware, use `sp5100_tco` instead (or your board's equivalent; check
`ls /sys/class/watchdog` or your chipset's datasheet if unsure) everywhere `iTCO_wdt` appears
below, including inside `deploy/solinteg-hwwatchdog-load.service`.

**This module is blacklisted by Ubuntu's kernel package by default**
(`grep -r iTCO_wdt /lib/modprobe.d/`), and **`systemd-modules-load.service` (which reads
`/etc/modules-load.d/*.conf`) explicitly honors that blacklist** — confirmed on-device
2026-07-10, it logs `Module 'iTCO_wdt' is deny-listed (by kmod)` and does nothing. A bare
`sudo modprobe iTCO_wdt`, by contrast, ignores the blacklist and loads it fine (verified the
same day) — the standard `/etc/modules-load.d/` approach documented by most guides silently does
NOT work for a blacklisted module, which is exactly what caused this to appear fixed during
initial setup (a manual `modprobe`) and then silently stop working on every subsequent boot:

```bash
sudo cp deploy/99-solinteg-hwwatchdog.conf /etc/systemd/system.conf.d/
sudo cp deploy/solinteg-hwwatchdog-load.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now solinteg-hwwatchdog-load.service
ls /dev/watchdog                       # should now exist
systemctl show -p RuntimeWatchdogUSec  # confirm systemd picked it up (expect ~1min)
```
(`/etc/systemd/system.conf.d/` doesn't exist yet on this box - `cp` creates the file fine,
just note there's no directory to `ls` beforehand.)

**Verify this survives a REBOOT, not just this session** — that's the whole point of making it
a service instead of a one-off manual command: `sudo reboot`, then once it's back up, re-run
`ls /dev/watchdog` and `systemctl show -p RuntimeWatchdogUSec`. If either is missing, check
`systemctl status solinteg-hwwatchdog-load.service` and `journalctl -u solinteg-hwwatchdog-load`
for why the modprobe step failed on your hardware.

**12d. Nightly backups of telemetry.db + solinteg.env**, local rotation (default: last 21
nightly snapshots, ~3 weeks):
```bash
sudo cp deploy/solinteg-backup.service deploy/solinteg-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now solinteg-backup.timer
sudo systemctl start solinteg-backup.service   # fire once now to test
ls -la /opt/solinteg/backups                   # should show telemetry-*.db + solinteg.env-*.bak
```
This is LOCAL-only - it protects against DB corruption or a bad query, not a dead disk. If you
have another always-on machine (a NAS, another PC), the simplest offsite option is periodically
pulling the backups directory over Tailscale, e.g.:
```bash
rsync -av <you>@<your-node>.<your-tailnet>.ts.net:/opt/solinteg/backups/ ./solinteg-backups/
```

**No other always-on machine? `solinteg-backup-offsite.timer` mirrors to a cloud remote
instead**, via `rclone` — free and automated, no second machine needed. Backblaze B2's free tier
(10 GB storage, 1 GB/day download) is the recommended backend: nightly backups here run tens of
MB with 21 kept locally, so 10 GB is years of headroom, and its auth is a plain key ID + key (no
interactive OAuth flow, unlike Google Drive — important since this runs headless).

Setup:
1. Create a free Backblaze B2 account, a bucket, and an "application key" scoped to that bucket
   (backblaze.com — a few minutes, no card required for the free tier).
2. `sudo apt install rclone`
3. Add to `/opt/solinteg/solinteg.env` (see the commented-out example block there):
   ```
   RCLONE_OFFSITE_DEST=b2:your-bucket-name
   RCLONE_CONFIG_B2_TYPE=b2
   RCLONE_CONFIG_B2_ACCOUNT=<application key id>
   RCLONE_CONFIG_B2_KEY=<application key>
   ```
   No `rclone.conf` file is used — these env vars are rclone's own supported way to configure a
   remote, so the credentials live only in `solinteg.env` (600-permissioned) like every other
   secret here.
4. Install and enable:
   ```bash
   sudo cp deploy/solinteg-backup-offsite.service deploy/solinteg-backup-offsite.timer /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now solinteg-backup-offsite.timer
   sudo systemctl start solinteg-backup-offsite.service   # fire once now to test
   rclone ls b2:your-bucket-name                          # confirm files landed
   ```
It runs at 03:35, after the local backup (03:15) — `rclone sync`, so the remote mirrors
`BACKUP_DIR`'s own rotation rather than accumulating forever. Alerts via the existing ntfy setup
on failure (`notify.py`, same as every other unit here). Leave `RCLONE_OFFSITE_DEST` unset to
skip this layer entirely; the local-only backup still runs either way.

**Restore from the offsite copy** (if the machine itself is gone, not just its disk):
```bash
rclone copy b2:your-bucket-name ./solinteg-backups-restore/
# then follow the local restore steps below against the newest telemetry-*.db in that folder
```

**Restore** (only ever tested manually, do this once to be sure it actually works):
```bash
sudo systemctl stop solinteg-web solinteg-poller solinteg-dispatch solinteg-weather
sudo -u solinteg cp /opt/solinteg/backups/telemetry-<stamp>.db /opt/solinteg/telemetry.db
sudo systemctl start solinteg-poller solinteg-web solinteg-weather solinteg-dispatch
```

**12e. SMART disk monitoring** - alerts on the phone before the drive fails outright:
```bash
sudo apt install -y smartmontools
grep -n "^DEVICESCAN" /etc/smartd.conf   # confirm the default DEVICESCAN + smartd-runner line
                                          # is present and uncommented; Ubuntu ships it enabled
                                          # by default, but verify rather than assume
sudo install -m 755 scripts/services/smart-alert.sh /etc/smartmontools/run.d/10solinteg-ntfy
sudo systemctl enable --now smartd
lsblk                                    # find your own disk's device name — NVMe drives show as
                                          # /dev/nvme0n1, SATA/SSD as /dev/sda, etc.
sudo smartctl -t short /dev/nvme0n1      # run a real self-test once to confirm it all works
                                          # (substitute your own device from lsblk above)
sudo smartctl -a /dev/nvme0n1 | grep -i "test_result\|health"  # check the result a few min later
```

**12f. Disk-space alert** - already wired into `solinteg-healthcheck.timer` (see
`scripts/services/healthcheck.py`'s `check_disk_space`, added 2026-07-07) - no separate install step,
it runs with the next healthcheck cycle. Alerts if free space on `/` drops below
`DISK_FREE_MIN_PCT` (default 10%).

**Done since:** DHCP reservations for both the NUC and the inverter (see "Network notes" below -
the inverter's is now issued by the NUC's own `dnsmasq` rather than the router, see §13) and
Ubuntu Pro (attached 2026-07-07 - ESM Apps, ESM Infra, and Livepatch all enabled, confirm with
`pro status`).

**Not automated - still on the to-do list:**
- Optional, bigger project: a small UPS or battery-backed circuit isn't required (BIOS
  auto-power-on + all of the above already gets you self-healing through a short outage), but
  would remove even the brief downtime during an outage. Not pursued here since it's a
  physical purchase/install decision.

## 13. Inverter network isolation

Added 2026-07-08 to close a standing risk: Modbus TCP has no auth, so anyone on the home LAN
could write inverter registers directly, bypassing every app-level safety gate. Fix: the
inverter is no longer on the home LAN at all — it's on a point-to-point link reachable only
from the NUC.

**Architecture:** the NUC's built-in port (named `eno1` on this board — run `ip link` to find
your own onboard NIC name, predictable naming varies by board) is untouched — still DHCP on the
home LAN, still carries SSH/Tailscale/dashboard exactly as before. A second NIC — any USB/PCIe
Ethernet adapter Linux auto-detects works; a USB-C-to-Gigabit adapter with a Realtek RTL8153
chipset is called out here only because it needed no extra driver (the in-kernel `r8152` module
handled it), netplan-matched by MAC so it survives reboots/port changes — named `eth-inverter`
(your own choice of name) is the dedicated inverter link: `192.168.99.0/24` (pick any RFC1918
range that doesn't collide with your home LAN), NUC side `.1`, inverter `.2`. `SOLINTEG_HOST` in
`/opt/solinteg/solinteg.env` is then that inverter address, e.g. `192.168.99.2`. Example,
ready-to-adapt config files for the steps below (netplan/dnsmasq/ufw) live in
`deploy/network-isolation/` — copy them and replace the placeholder MAC/subnet with your own.

**The inverter has no reachable local web UI and can't be given a static IP** (only port 502 is
open on it), so the NUC runs `dnsmasq` as a DHCP-only server (`port=0` disables its DNS side, to
avoid conflicting with systemd-resolved), scoped strictly to `eth-inverter` via
`interface=`/`except-interface=`/`bind-dynamic` in `/etc/dnsmasq.d/eth-inverter.conf`, with a
single reservation keyed on the inverter's MAC (`dhcp-host=<inverter-mac>,192.168.99.2`).

**Firewall/NAT (ufw):** `net.ipv4.ip_forward=1` in `/etc/ufw/sysctl.conf`; a
`*nat`/`POSTROUTING MASQUERADE` block in `/etc/ufw/before.rules` for `192.168.99.0/24 -> eno1`
(so the inverter's own outbound cloud reporting still works); forwarding via
`sudo ufw route allow in on eth-inverter out on eno1` — deliberately one-directional, so nothing
on the LAN/internet can open a new connection *into* the inverter's subnet; plus
`sudo ufw allow in on eth-inverter to any port 67 proto udp` so dnsmasq can hear DHCP requests.

**After changing `SOLINTEG_HOST`,** restart every service that opens a Modbus connection —
`solinteg-poller`, `solinteg-dispatch`, **and `solinteg-watchdog`** (it also connects via
`inverter_control.py` to force auto on a stale heartbeat — see the "Updating" restart list below).

**Verify the isolation:** `nc -vz <old-inverter-ip> 502` must fail from any device on the home
LAN; the inverter's own cloud/phone app should still get fresh telemetry (proves outbound NAT
works without proving anything is reachable inbound).

**Physical:** the actual isolation boundary is the physical cable, not the firewall config — the
NUC and inverter should be linked by a direct patch cable with no switch in between if at all
possible.

## 14. Hindsight-oracle scoring (nightly)

Scores each completed day against the best dispatch a perfect-information oracle could have
achieved (the fairness design lives in `lib/oracle.ts`'s header). The
web app computes and writes `oracle_daily`; the timer just curls the route:

```bash
sudo cp deploy/solinteg-oracle.service deploy/solinteg-oracle.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now solinteg-oracle.timer

systemctl list-timers solinteg-oracle.timer    # confirm next run (04:40 nightly)
sudo systemctl start solinteg-oracle.service   # fire once now to test; JSON summary → journal
journalctl -u solinteg-oracle -n 20            # per-day regret summaries / skip reasons
```

A day D is scorable only once D+1 has completed (the oracle window needs the day-after's
actuals), so results lag two nights; each run sweeps the last 14 days, so missed nights
self-heal. Ad-hoc: `curl 'localhost:3000/api/oracle?date=YYYY-MM-DD&force=1'` to rescore a
day (e.g. after changing battery/price constants — rows carry the params they were computed
under in `params_json`).

## Network notes

- The inverter no longer takes a DHCP reservation from the router — see §13, it's now on an
  isolated NIC/subnet with its own reservation from the NUC's `dnsmasq`.
- The **NUC itself** has a DHCP reservation on the home LAN so its IP never changes.
- The poller needs TCP **502** to the inverter. Confirm with `nc -vz $SOLINTEG_HOST 502`.
- To reach the dashboard from your LAN, browse to `http://<nuc-ip>:3000`.

## Updating

```bash
cd /opt/solinteg/app && git pull && npm ci && npm run build
sudo systemctl restart solinteg-web solinteg-poller

# If any deploy/*.service or *.timer changed, reinstall and reload them too:
sudo cp deploy/solinteg-*.service deploy/solinteg-*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl restart solinteg-poller solinteg-web solinteg-weather solinteg-dispatch \
        solinteg-watchdog

# If scripts/services/telemetry-ro.sh changed (e.g. a new unit added to its ALLOWED_UNITS allowlist —
# see §10), the installed wrapper is a copy, not a symlink, so it needs reinstalling too:
sudo install -m 755 scripts/services/telemetry-ro.sh /usr/local/bin/solinteg-telemetry-ro
```

`solinteg-watchdog` also opens its own Modbus connection (via `inverter_control.py` — see §13) to
force auto on a stale heartbeat, so include it in any restart after a `solinteg.env` change
(`SOLINTEG_HOST`, credentials, etc.), not just after a code change.
