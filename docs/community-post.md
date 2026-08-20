Hi everyone :wave:

I’m excited to share my Homey app for TrueNAS. If you run a TrueNAS SCALE server at home — for backups, photos, media or virtual machines — this app brings it into Homey as ordinary devices.

:floppy_disk: **What is this app?**

Your NAS sits in a cupboard and asks for nothing, which is exactly why a full pool or an overheating drive tends to go unnoticed until it is too late. TrueNAS Manager puts the state of your storage right next to your lights and sensors, and lets your NAS take part in the automations your home already runs.

Everything happens over your own network. The app speaks JSON-RPC directly to TrueNAS — no cloud, no account, no data leaving the house.

:point_right: **Install from the Homey App Store**

Test Version: _(link follows once the app is published)_

Live Version: _(link follows once the app is published)_

:electric_plug: **Supported devices (8 drivers)**

| Driver | Description |
| --- | --- |
| TrueNAS System | The server itself — processor, memory, network, alerts, updates |
| Storage Pool | One device per pool, including the boot pool |
| Dataset | Usage, quota and compression per dataset |
| Disk | Temperature, capacity, model and pool assignment |
| Service | SMB, NFS, SSH, iSCSI and the rest |
| App | Docker apps with version and update state |
| Virtual Machine | Status, memory and virtual CPUs |
| Backup Task | Cloud sync, replication and periodic snapshot tasks |

You add the system first and enter the address and API key once. Everything else is discovered from there and picked from a list — the key is never entered twice.

:bar_chart: **What can it read?**

**TrueNAS System**

Processor usage (%) and temperature (°C)

Load averages over 1, 5 and 15 minutes

Memory usage (%), used and free (GB)

ZFS ARC size (GB)

Network throughput received and sent (Mbit/s)

Uptime, TrueNAS version and hardware details

Active alert count and the most severe alert text, with an alarm flag from a level you choose

Update status — up to date, update available with version, download progress, or check failed

**Storage Pool**

Pool status and a health alarm on anything but healthy

Used, free and total space (TB) plus usage (%)

Scrub state and live scrub progress (%)

**Dataset**

Used and free space (GB), usage (%)

Quota and compression ratio

Pool, mount point and encryption state

**Disk**

Temperature (°C) with a configurable alarm threshold

Capacity (TB), model, serial and the pool it belongs to

**Service**

Running state and whether the service starts on boot

**App**

Running state, installed version and container count

Catalog update available — a newer version in the TrueNAS catalog

Container image update available — tracked separately by TrueNAS, so either can be pending on its own

Web address of the app’s own interface

**Virtual Machine**

Status, assigned memory (MB) and virtual CPUs

**Backup Task**

State, live progress and last run time

An alarm when the last run failed, errored or was aborted

:arrows_counterclockwise: **What can it control?**

**Services** — start, stop, restart, and reload. Reload re-reads the configuration without dropping existing connections, which a restart would.

**Apps** — start, stop, redeploy, and install a pending update. The update action picks the right path automatically: a catalog upgrade if one is available, otherwise a fresh pull of the container images.

**Virtual machines** — start, stop and restart. Stopping can be graceful or forced, and starting can allow memory overcommit.

**Pools** — start and stop a scrub. The boot pool uses its own method, which only starts.

**Datasets** — create a snapshot, named after a prefix and a timestamp so it sorts chronologically and never collides with your periodic snapshot tasks.

**Backup tasks** — run now, and abort a running cloud sync.

**The NAS itself** — check for updates, install a pending update, reboot and shut down. Installing without a reboot puts the update into a new boot environment, so the new version becomes active at the next restart. Install at midday, restart at night.

:repeat: **Flow Cards**

**15 Triggers**

| Card | Description |
| --- | --- |
| An alert was raised | System — tokens: level, message, category |
| A system update became available | System — token: version |
| Pool status changed | Pool — tokens: status, previous status |
| Pool became unhealthy | Pool — tokens: status, detail |
| Free space dropped below | Pool — threshold argument, tokens: free % and TB |
| Scrub started / Scrub finished | Pool — token: errors |
| Disk temperature rose above | Disk — threshold argument |
| App status changed | App — tokens: status, previous status, web address |
| An app update became available | App — token: version |
| A container image update became available | App |
| Virtual machine status changed | VM |
| A task finished | Task — tokens: task, result, type |
| A task failed | Task — fires only on a failed, errored or aborted run |
| Free space dropped below | Dataset — threshold argument |

Threshold triggers fire once when the value crosses the line, not on every reading past it — so a hot disk or a filling pool does not flood your timeline.

**15 Conditions**

Pool is healthy · free space below · scrub running · disk temperature above · CPU usage above · alert of a given level exists · system update available · service running · app running · app update available · container image update available · VM running · task running · last run failed · dataset free space below

**21 Actions**

Every control listed above, as a Flow action.

:framed_picture: **Dashboard Widget**

A NAS Overview widget puts storage, processor, memory and network throughput on your Homey dashboard, with a usage bar per pool and a list of your apps.

Bars turn amber and then red as a pool fills up, degraded pools are flagged and a running scrub is marked. Apps show a status dot, and any app with a pending update carries an update badge — **tapping it installs the update right there**. Apps waiting for an update are listed first so they stay visible even when the list is cut off.

Thresholds, which sections are shown and how many apps to list are all configurable.

:gear: **Setup**

Requirements:

TrueNAS SCALE 25.04 (Fangtooth) or newer — the app uses the JSON-RPC API, which older releases do not offer

Homey Pro with firmware 12.3.0 or newer

An API key from Credentials → API Keys in the TrueNAS web interface

Homey and TrueNAS on the same local network

Installation:

Install the app from the Homey App Store

Add device → TrueNAS Manager → TrueNAS System

Enter the address, port and API key

Add the pools, disks, services, apps, VMs, datasets and tasks you care about — they are discovered automatically

A tip from experience: use the **IP address** rather than a host name, and give the NAS a fixed address in your router. Homey resolves `.local` names unreliably, and a DNS hiccup will otherwise take the app offline.

Device settings (System):

| Setting | Default | Description |
| --- | --- | --- |
| Host / Port | — / 443 | Address of the NAS |
| Use HTTPS | on | Off only if the web interface runs on plain HTTP |
| Accept self-signed certificate | on | TrueNAS ships a self-signed certificate by default |
| Poll interval | 60 s | System, pools, services, apps, VMs, alerts, tasks |
| Disk poll interval | 300 s | Reading disk temperatures queries SMART, which can keep drives from spinning down — raise this if your drives should stay in standby |
| Alarm from level | Error | Which alert level sets the alarm flag |

All devices of one NAS share a single connection and a single poll cycle. Twenty devices still cost one request per interval, not twenty.

:robot: **About this app**

This app was developed with the help of Claude (Anthropic AI). All code, configuration and documentation were generated and iteratively refined through AI-assisted development.

One thing worth mentioning: TrueNAS removed its REST API in version 26, and reworked the update API in 25.10. The app was built against the JSON-RPC API from the start and every method it calls was verified against the TrueNAS source, so it should keep working as TrueNAS moves on.

The app is open source: :point_right: GitHub – com.truenas.manager

If you find this app useful, I’d appreciate a beer: :point_right: PayPal – Support development

:balloon: **Feedback welcome!**

I’m happy to hear from you:

Does it work with your TrueNAS version and hardware?

Are the processor, temperature and network readings plausible on your system? Those come from netdata, whose layout differs between versions — the app settings page has a Data tab showing the raw values if something looks off

Which values or controls are you missing?

Any bugs or unexpected behaviour?

Drop a comment below or open an issue on GitHub.
