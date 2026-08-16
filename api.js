'use strict';

module.exports = {

  /** Overview of every paired TrueNAS system and its live counters. */
  async getSystems({ homey }) {
    const app = homey.app;
    const driver = homey.drivers.getDriver('truenas-system');
    const devices = driver ? driver.getDevices() : [];

    return devices.map((device) => {
      const systemId = device.getData().id;
      const hub = app.getHub(systemId);
      const settings = device.getSettings();

      return {
        systemId,
        name: device.getName(),
        host: settings.host,
        port: settings.port,
        protocol: settings.use_ssl ? 'https' : 'http',
        available: hub ? hub.available : false,
        lastError: hub ? hub.lastError : 'Not initialized',
        lastSuccess: hub ? hub.lastSuccess : 0,
        version: hub ? hub.data.system.version : null,
        hostname: hub ? hub.data.system.hostname : null,
        uptime: hub ? hub.data.system.uptime : null,
        counts: hub ? {
          pools: hub.data.pools.length,
          disks: hub.data.disks.length,
          services: hub.data.services.length,
          apps: hub.data.apps.length,
          vms: hub.data.vms.length,
          alerts: hub.data.alerts.length,
        } : null,
      };
    });
  },

  /** Raw hub data, so users can verify readings before reporting an issue. */
  async getDebug({ homey, query }) {
    const hub = homey.app.getHub(query.systemId);
    if (!hub) throw new Error('Unknown system');

    return {
      system: hub.data.system,
      update: hub.data.update,
      pools: hub.data.pools,
      disks: hub.data.disks,
      diskTemperatures: hub.data.diskTemperatures,
      services: hub.data.services,
      apps: hub.data.apps,
      vms: hub.data.vms,
      interfaces: hub.data.interfaces,
      alerts: hub.data.alerts,
    };
  },

  async refreshSystem({ homey, query }) {
    const hub = homey.app.getHub(query.systemId);
    if (!hub) throw new Error('Unknown system');
    await hub.refreshNow();
    return { ok: true };
  },

  async getLog({ homey }) {
    return homey.app.getLog();
  },

  async clearLog({ homey }) {
    homey.app.clearLog();
    return { ok: true };
  },

};
