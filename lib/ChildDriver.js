'use strict';

const { Driver } = require('homey');

/**
 * Base class for the drivers whose devices belong to an already-paired TrueNAS
 * system.
 *
 * Pairing is a single `list_devices` step. Entries from every paired NAS are
 * gathered into one list, so the API key is only ever entered once (on the
 * system device) and the user does not have to pick a NAS first. When more than
 * one NAS is paired, entries are prefixed with the system name.
 */
class ChildDriver extends Driver {

  /** Segment used in the device data id, e.g. `pool`. */
  get entityType() {
    return 'entity';
  }

  async onPair(session) {
    session.setHandler('list_devices', async () => this.discoverDevices());
  }

  async onRepair(session) {
    session.setHandler('list_devices', async () => this.discoverDevices());
  }

  async discoverDevices() {
    const systems = this.listSystems();

    if (!systems.length) {
      throw new Error(this.homey.__('pair.no_system'));
    }

    const showSystemName = systems.length > 1;
    const results = [];
    const errors = [];

    for (const system of systems) {
      const hub = this.homey.app.getHub(system.id);
      if (!hub) {
        errors.push(`${system.name}: ${this.homey.__('error.no_system')}`);
        continue;
      }

      // Force a full cycle so the slow tier (disks) is populated too.
      await hub.refreshNow().catch((err) => {
        this.error(`Refresh of ${system.name} during pairing failed:`, err.message);
      });

      if (!hub.available) {
        errors.push(`${system.name}: ${this.homey.__(hub.lastErrorI18n || 'error.unreachable')}`);
        continue;
      }

      const devices = await this.buildDeviceList(hub, system.id);
      for (const device of devices) {
        if (showSystemName) device.name = `${system.name} · ${device.name}`;
        results.push(device);
      }
    }

    // Only surface an error when nothing at all could be listed; a single
    // unreachable NAS should not block the ones that do respond.
    if (!results.length && errors.length) {
      throw new Error(errors.join('\n'));
    }

    return results;
  }

  listSystems() {
    let driver;
    try {
      driver = this.homey.drivers.getDriver('truenas-system');
    } catch (_err) {
      return [];
    }
    if (!driver) return [];

    return driver.getDevices().map((device) => ({
      id: device.getData().id,
      name: device.getName(),
      available: device.getAvailable(),
    }));
  }

  /** Subclasses return the pairable entries found on the given hub. */
  async buildDeviceList(_hub, _systemId) {
    return [];
  }

  /** Builds a Homey device descriptor with a stable, system-scoped id. */
  makeDevice(systemId, key, name, extra = {}) {
    return {
      name,
      data: { id: `${systemId}:${this.entityType}:${key}` },
      store: { systemId, entity: String(key) },
      ...extra,
    };
  }

}

module.exports = ChildDriver;
