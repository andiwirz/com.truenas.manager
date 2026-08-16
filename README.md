# TrueNAS Manager for Homey

Monitor and control a TrueNAS SCALE system from Homey: system health, storage pools,
disks, services, Docker apps and virtual machines.

## Requirements

- **TrueNAS SCALE 25.04 (Fangtooth) or newer.** The app speaks JSON-RPC 2.0 over the
  WebSocket endpoint `/api/current`, which was introduced in 25.04.
- An API key from **Credentials → API Keys** in the TrueNAS web interface.
- Homey Pro on the same local network as the NAS.

### Why not the REST API

TrueNAS has two APIs, and only one has a future:

| | REST `/api/v2.0` | JSON-RPC `/api/current` |
| --- | --- | --- |
| 24.10 ElectricEel | yes | no |
| 25.04 Fangtooth | yes | yes |
| 25.10 Goldeye | yes | yes |
| 26.0 and later | **removed** | yes |

`src/middlewared/middlewared/restful.py` is present in the `stable/goldeye` branch of
[truenas/middleware](https://github.com/truenas/middleware) and absent from `master`.
This app therefore targets JSON-RPC only.

## Architecture

```
lib/TrueNasClient.js   JSON-RPC 2.0 over ws/wss, auth.login_with_api_key, heartbeat
lib/TrueNasHub.js      one connection and one poll cycle per NAS, cached data
lib/ChildDevice.js     base for devices that attach to a hub
lib/ChildDriver.js     base for two-step pairing (pick system, then entries)
app.js                 hub registry, flow conditions and actions
```

One **hub** per TrueNAS system owns the socket. Every device of that NAS subscribes to
it, so twenty devices still produce one request per poll tier rather than twenty.

Poll tiers:

| Tier | Default | Contents |
| --- | --- | --- |
| fast | 60 s | `system.info`, pools, services, apps, VMs, alerts, interfaces, reporting graphs |
| slow | 300 s | `disk.query`, `disk.temperatures` |
| daily | 12 h | `update.check_available` |

Disk temperatures sit on the slow tier deliberately: `disk.temperatures` queries SMART,
which can prevent drives from spinning down.

### Version drift

Method names move between releases. `TrueNasHub.callFirst()` takes a list of
`[method, params]` candidates and falls through only when the server reports the method
as unknown — for example `service.control` (26.0) with `service.start` as the fallback.

## Drivers

| Driver | Class | Notes |
| --- | --- | --- |
| `truenas-system` | sensor | The anchor. Owns the hub. Paired with host, port and API key. |
| `truenas-pool` | sensor | Includes the boot pool. Scrub control. |
| `truenas-disk` | sensor | One device per disk, multi-select at pairing. |
| `truenas-service` | other | `onoff` maps to start/stop. |
| `truenas-app` | other | Docker apps. Redeploy and upgrade. |
| `truenas-vm` | other | Graceful stop or forced power-off. |

Child devices carry `{ systemId, entity }` in their store and
`<systemId>:<type>:<key>` as their data id. `systemId` comes from `system.host_id`,
so it survives an IP change.

## Development

```bash
npm install
```

```bash
npx homey app validate
```

```bash
npx homey app run
```

Regeneration scripts for capabilities, flow cards and images live outside the repo; the
generated files are committed.

## Verifying readings

The app settings page has a **Data** tab that dumps the raw hub cache for a system.
Use it to confirm units and field names before filing an issue — reporting graph
layouts differ between netdata versions.

## Licence

MIT
