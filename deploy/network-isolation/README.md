# Inverter network isolation — config templates

Example, ready-to-adapt config for deploy/README.md §13's inverter isolation setup — replace
every placeholder (MAC addresses, interface names, subnet) with your own before using. See §13
for the full explanation of why this exists (Modbus TCP has no auth, so the inverter needs to be
unreachable from anything except this box).

## Files here

- **`70-eth-inverter.yaml.example`** → copy to `/etc/netplan/70-eth-inverter.yaml`
- **`dnsmasq-eth-inverter.conf.example`** → copy to `/etc/dnsmasq.d/eth-inverter.conf`
- **`ufw-before.rules.snippet`** → insert into `/etc/ufw/before.rules` (don't overwrite the file,
  ufw's own rules are already in there)

## Full setup order

1. Physically connect the second NIC (or USB adapter), find its MAC via `ip link`.
2. Fill in `70-eth-inverter.yaml.example`'s MAC and subnet, install, `sudo netplan try` then
   `sudo netplan apply`.
3. Find the inverter's MAC (via `ip neigh` while it's still on your home LAN, or its label).
   Fill in `dnsmasq-eth-inverter.conf.example`, install, `sudo systemctl restart dnsmasq`.
4. Move the inverter's Ethernet cable to the new isolated NIC.
5. Enable IP forwarding: uncomment `net/ipv4/ip_forward=1` in `/etc/ufw/sysctl.conf`.
6. Insert `ufw-before.rules.snippet`'s NAT block into `/etc/ufw/before.rules` (with your own
   subnet/interface filled in).
7. Allow forwarding and DHCP on the isolated interface (one-directional — nothing can initiate
   a connection *into* the inverter's subnet, only its own outbound traffic is allowed out):
   ```bash
   sudo ufw route allow in on eth-inverter out on eno1   # <-- your interface names
   sudo ufw allow in on eth-inverter to any port 67 proto udp   # lets dnsmasq hear DHCP requests
   sudo ufw reload
   ```
8. Update `SOLINTEG_HOST` in `/opt/solinteg/solinteg.env` to the inverter's new isolated-subnet
   address, then restart every service that opens a Modbus connection: `solinteg-poller`,
   `solinteg-dispatch`, and `solinteg-watchdog` (see deploy/README.md's "Updating" section).
9. **Verify**: `nc -vz <old-inverter-ip> 502` must fail from any device on your home LAN; the
   inverter's own cloud/phone app should still get fresh telemetry (proves outbound NAT works
   without proving anything is reachable inbound).

**Physical note:** the real isolation boundary is the physical cable, not this config — link
the box and inverter with a direct patch cable and no switch in between if at all possible.

**Do not put this link over powerline/HomePlug.** On the reference deployment it ran that way
until 2026-08-22 and cost 14 ms average RTT with 107 ms spikes (vs 0.97 ms / 1.22 ms on direct
cable) plus roughly 200 slow-but-successful Modbus polls a day. It was misdiagnosed as a failing
inverter dongle for two weeks, because **the NIC's own error counters read a clean zero
throughout** — a bridged hop hides its loss and latency internally. If you must diagnose this
link, measure RTT and jitter (`ping -c 30 -i 1`), not `rx_errors`. Ping at 1 s, not faster: the
dongle rate-limits ICMP, so a fast ping manufactures fake packet loss (20% at 0.3 s vs 0% at 1 s
on the same link).

**Cabling gotcha, once two NICs are in play:** if the onboard and USB adapter cables get swapped,
the symptom is distinctive — the poller keeps working (the adapter is still on the inverter) while
the box is unreachable from your LAN (the onboard port is on a cable leading nowhere). Swapped the
other way is worse: `dnsmasq` starts offering the isolated subnet's leases onto your home LAN.
Netplan matches the adapter by MAC, so which USB port it occupies is irrelevant — only which
Ethernet cable is plugged into it matters.
