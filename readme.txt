Bring your TrueNAS server into Homey.

TrueNAS Manager connects to your TrueNAS SCALE system over your local network and turns it into Homey devices you can watch and automate. Add only what you care about: the system itself, individual storage pools, individual disks, system services, Docker apps and virtual machines.

WHAT YOU CAN MONITOR

System: CPU usage and temperature, load averages, memory usage, ZFS ARC size, network throughput, uptime, TrueNAS version, pending system updates and active alerts.

Storage pools: pool status, used and free space in TB and percent, and live scrub progress. A pool that leaves the healthy state raises an alarm.

Disks: temperature per disk, capacity, model and the pool it belongs to, with a configurable temperature alarm.

Services: whether SMB, NFS, SSH, iSCSI and the rest are running and whether they start on boot.

Apps: status and version of every Docker app, and whether an update is waiting.

Virtual machines: status, assigned memory and virtual CPUs.

WHAT YOU CAN CONTROL

Start, stop and restart services. Start, stop, redeploy and upgrade apps. Start, stop and restart virtual machines. Start and stop a pool scrub. Reboot or shut down the whole NAS.

FLOW CARDS

Triggers for new alerts, available system and app updates, pool status changes, a pool becoming unhealthy, free space dropping below a threshold you choose, scrubs starting and finishing, disk temperature rising above a threshold, and app or VM status changes.

Conditions for pool health, free space, running scrubs, disk temperature, CPU usage, running services, apps and virtual machines, and pending updates.

Actions for every control listed above.

Threshold triggers fire once when the value crosses the line, not on every reading past it, so a hot disk or a full pool does not flood your timeline.

REQUIREMENTS

- TrueNAS SCALE 25.04 (Fangtooth) or newer. The app uses the JSON-RPC API, which older releases do not offer.
- An API key, created in the TrueNAS web interface under Credentials, API Keys. The account behind the key needs read access, plus write access for the actions you want to use.
- Homey and TrueNAS on the same local network. A fixed address for the NAS is recommended.

HOW IT WORKS

Add the TrueNAS System device first and enter the address and API key. Everything else is discovered from there, so you never enter the key twice. All devices of one NAS share a single connection and a single poll cycle, so twenty devices still cost one request per interval.

Disk temperatures are read on a separate, slower schedule because reading them queries SMART, which can keep drives from spinning down. You can raise that interval in the system device settings.

PRIVACY

The app talks only to your NAS on your local network. No data leaves your home.
