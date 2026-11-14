# What BMW's Remote Software Upgrade teaches us

BMW flashes every module in the car **wirelessly, from the factory**, with no
external adapter — the Remote Software Upgrade (RSU / OTA). That is existence
proof that the topology we are targeting works. This note records what is
publicly known and what is directly useful for BeeM-Flash and the open-source
community. Sources are at the bottom; treat forum/anecdotal items as such.

## The architecture (public sources)

- **TCB (Telematics Communication Box)** has the cellular link. It *downloads*
  the signed update package during a normal drive. Download and install are
  separate phases — a 2025 bulletin notes install needs **no connectivity**
  because the package is already on the car.
- **The Central Gateway (ZGW / on newer cars folded into the BDC/body domain)
  is the hub.** Every major system talks through it, and it is *"the primary
  access point for diagnostic tools to communicate with the entire vehicle."*
  It bridges the buses, including **Ethernet on F/G platforms**, and speaks
  **DoIP (ISO 13400)** to the newer, Ethernet-connected ECUs.
- **Flashing underneath is ordinary UDS.** RSU puts the car in a programming
  mode and programs the relevant components; the bytes-on-the-wire are the same
  `0x27` SecurityAccess / `0x34`/`0x36`/`0x37` transfer we already implement.
  The difference is *who* initiates it and *that it is signed*.
- **The Security Gateway (SGW) is a diagnostic firewall between the OBD-II port
  and the modules.** An external tool at the OBD port is firewalled and must be
  authenticated for write functions. An **internal** master is on the *inside*
  of that firewall.

## Why this matters for us — the three real takeaways

1. **The head unit is already *inside* the security perimeter.** On this car the
   head unit sits on BMW's internal diagnostic Ethernet (`160.48.199.x` on
   vlan73 — an address range documented on BMW internal/CIC diagnostics). A tool
   plugged into the OBD port hits the SGW; the head unit does not. This is the
   same privileged position BMW's own internal flashing master occupies. It is
   the strongest argument that a head-unit-hosted path can reach all modules.

2. **The gateway answers a *directed* connection, not a broadcast.** ISTA/E-Sys
   open a TCP session to the gateway's IP on **6801 (HSFZ)** / **13400 (DoIP)**;
   the gateway is the server. Our first P7 probe only *broadcast* a vehicle-ID
   request and got silence — which proves nothing, because gateways commonly
   ignore broadcast and only answer a directed routing activation. **v-next adds
   a directed probe** of candidate gateway addresses on the unit's own subnets
   (the conventional `.1`, the BMW-historical `.99`, and the unit's neighbours).
   If P7 ever reads **GATEWAY REACHABLE**, a tool can be proxied straight to the
   real gateway with no translation — the ideal.

3. **Our SVK reading already matches BMW's model.** RSU/ISTA track what is
   installed via the **SVK / SWFL / CAFD** software-unit structure — exactly the
   `22 F1 01` SVK list we now read on INFO. The identity math is aligned; we are
   speaking BMW's own bookkeeping.

## What we cannot take from it (and must not pretend to)

- **The signing/PKI.** BMW packages are signed; the SGW/SFD enforces authenticated
  write access. We do not forge signatures or defeat SFD. BeeM-Flash targets an
  **already-unlocked / bench-tuned** ECU, where that enforcement is moot, and
  supplies SecurityAccess keys the owner already holds.
- **The cellular/TCB download path.** Not relevant and not reproducible.

## Concrete next steps this research justifies

- **Directed gateway probe (done):** P7 now tries directed TCP to candidate
  gateway IPs on the internal subnets, not just broadcast. The on-car P7 line is
  now a real test of "is the gateway reachable over IP from the head unit?"
- **If P7 reads GATEWAY REACHABLE:** add a straight TCP proxy (tool ↔ gateway)
  as a second bridge mode beside the TASU relay — this is the true ENET-adapter
  equivalent and needs no per-module addressing from us.
- **If it stays unreachable:** the TASU relay remains the working path, and the
  root helper's own access point remains the connectivity fix.

## Sources

- BMW SIB 09 02 20 — Remote Software Upgrade (NHTSA mirror):
  https://static.nhtsa.gov/odi/tsbs/2020/MC-10179809-9999.pdf
- "0-days & Mitigations: Roadways to Exploit and Secure Connected BMW Cars",
  Black Hat USA 2019 (TCB → Central Gateway remote diagnostic path).
- "Generic Remote Software Update for Vehicle ECUs Using a Telematics Device as
  a Gateway" (academic, generic model).
- Gateway Module Programming: ZGW, CGW, SGW —
  https://www.automodulelab.com/blog/gateway-module-programming-zgw-cgw-j533-guide/
- SGW diagnostic-firewall overview — https://autecs.com.au/sgw-access/
- BMW ENET/ZGW over TCP 6801 (forum) —
  https://www.bimmerfest.com/threads/enet-can-diagnostic-messages-for-bench-coding.1398888/
- 160.48.199.x internal diagnostic addressing (E-series CIC, forum/anecdotal) —
  BMW 3-Series forum E90post thread.
