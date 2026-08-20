'use strict';

const { toGiB, toTiB, round, percent } = require('../../lib/util');

/**
 * Resolves the widget's bound device to a TrueNAS system id.
 *
 * The picker offers every device of the app, so the user may well have chosen
 * a pool or a disk rather than the system itself. Child devices carry their
 * system id in the store, so either choice works.
 */
function resolveSystemId(homey, deviceId) {
  if (deviceId) {
    for (const driver of Object.values(homey.drivers.getDrivers())) {
      for (const device of driver.getDevices()) {
        if (device.getId() !== deviceId) continue;
        return device.getStoreValue('systemId') || device.getData().id;
      }
    }
  }

  // No selection or the device is gone: fall back to the only paired NAS.
  const hubs = homey.app.listHubs();
  return hubs.length ? hubs[0].systemId : null;
}

/**
 * TrueNAS alert text is pre-formatted HTML. The widget renders through
 * textContent, so the markup has to go or the user reads the tags.
 */
function plain(text) {
  if (!text) return null;
  return String(text).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() || null;
}

/** Picks a sensible unit so a 100 GB boot pool does not read as 0.10 TB. */
function size(bytes) {
  const tib = toTiB(bytes, 2);
  if (tib !== null && Math.abs(tib) >= 1) return { value: tib, unit: 'TB' };
  return { value: toGiB(bytes, 0), unit: 'GB' };
}

module.exports = {

  async getOverview({ homey, query }) {
    const systemId = resolveSystemId(homey, query.deviceId);
    const hub = systemId ? homey.app.getHub(systemId) : null;

    if (!hub) {
      return { ok: false, reason: 'no_system' };
    }
    if (!hub.available) {
      return {
        ok: false,
        reason: 'unavailable',
        name: hub.data.system.hostname || null,
        error: hub.lastErrorI18n || 'error.unreachable',
      };
    }

    const includeBoot = query.includeBoot === 'true';
    const pools = hub.data.pools.filter((p) => includeBoot || !p.isBoot);

    const totalBytes = pools.reduce((sum, p) => sum + (p.size || 0), 0);
    const usedBytes = pools.reduce((sum, p) => sum + (p.allocated || 0), 0);

    const system = hub.data.system;
    const alerts = hub.data.alerts;
    const critical = hub.criticalAlerts;

    return {
      ok: true,
      name: system.hostname || 'TrueNAS',
      version: system.version || null,
      uptime: system.uptime || null,
      updateAvailable: hub.data.update.available === true,

      storage: {
        used: size(usedBytes),
        total: size(totalBytes),
        percent: percent(usedBytes, totalBytes, 0),
      },
      cpu: {
        percent: system.cpuUsage === undefined ? null : system.cpuUsage,
        temperature: system.cpuTemperature === undefined ? null : system.cpuTemperature,
      },
      memory: {
        percent: system.memoryUsage === undefined ? null : system.memoryUsage,
        totalGb: toGiB(system.memoryTotal, 0),
      },
      network: {
        // rx and tx arrive in Mbit/s.
        totalMbit: round((system.networkRx || 0) + (system.networkTx || 0), 1),
        rxMbit: system.networkRx === undefined ? null : system.networkRx,
        txMbit: system.networkTx === undefined ? null : system.networkTx,
      },
      alerts: {
        total: alerts.length,
        critical: critical.length,
        text: critical.length ? plain(critical[0].text) : null,
      },
      apps: hub.data.apps.map((app) => ({
        name: app.name,
        state: app.state,
        running: app.running,
        // Deliberately only the catalog version. A newer container image for
        // the same version is tracked separately and is not shown here.
        update: app.upgradeAvailable === true,
        latestVersion: app.latestVersion || null,
      })),

      pools: pools.map((pool) => ({
        name: pool.name,
        isBoot: pool.isBoot,
        healthy: pool.healthy,
        status: pool.status,
        percent: pool.usage,
        used: size(pool.allocated),
        total: size(pool.size),
        scrubbing: ['SCANNING', 'RUNNING'].includes(String(pool.scrubState || '').toUpperCase()),
      })),
    };
  },

  /**
   * Upgrades one app to the latest catalog version.
   *
   * This talks to the hub rather than to a paired device, because the widget
   * lists every app on the NAS, including those the user never added to Homey.
   */
  async upgradeApp({ homey, body }) {
    const name = body && body.app;
    if (!name) throw new Error('No app given');

    const systemId = resolveSystemId(homey, body.deviceId);
    const hub = systemId ? homey.app.getHub(systemId) : null;
    if (!hub) throw new Error(homey.__('error.no_system'));
    if (!hub.available) throw new Error(homey.__(hub.lastErrorI18n || 'error.unreachable'));

    const app = hub.getApp(name);
    if (!app) throw new Error(homey.__('error.not_found'));
    if (!app.upgradeAvailable) return { ok: true, skipped: true };

    await hub.call('app.upgrade', [app.name, { app_version: 'latest' }]);
    hub.scheduleRefresh(8000);
    return { ok: true, skipped: false };
  },

};
