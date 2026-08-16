'use strict';

const { Device } = require('homey');

/**
 * Base class for every device that belongs to a TrueNAS system but is not the
 * system itself (pools, disks, services, apps, VMs).
 *
 * These devices never talk to the NAS on their own schedule. They attach to the
 * hub owned by their system device and re-render whenever it publishes data.
 */
class ChildDevice extends Device {

  /** Capabilities to drop from existing installs. Subclasses may override. */
  get removedCapabilities() {
    return [];
  }

  /** Capabilities to add to existing installs. Subclasses may override. */
  get addedCapabilities() {
    return [];
  }

  /** Short label used in log lines, e.g. `pool`. */
  get entityType() {
    return 'entity';
  }

  async onInit() {
    this.systemId = this.getStoreValue('systemId');
    this.entityKey = this.getStoreValue('entity');

    if (!this.systemId) {
      // Devices paired before the store was written can recover from data.id.
      const parts = String(this.getData().id || '').split(':');
      if (parts.length >= 3) {
        this.systemId = parts[0];
        this.entityKey = parts.slice(2).join(':');
      }
    }

    await this._migrateCapabilities();
    await this.onDeviceInit();

    this._hub = await this.homey.app.waitForHub(this.systemId);
    if (!this._hub) {
      this.error(`No hub for system ${this.systemId}`);
      await this.setUnavailable(this.homey.__('error.no_system')).catch(() => {});
      return;
    }

    this._onData = () => {
      this.handleData(this._hub).catch((err) => this.error('Update failed:', err.message));
    };
    this._onUnavailable = (i18n) => {
      this.setUnavailable(this.homey.__(i18n || 'error.unreachable')).catch(() => {});
    };

    this._hub.on('data', this._onData);
    this._hub.on('unavailable', this._onUnavailable);

    if (this._hub.available) this._onData();
    else this._onUnavailable(this._hub.lastErrorI18n);
  }

  /** Hook for subclasses that need setup before the hub is attached. */
  async onDeviceInit() {}

  async _migrateCapabilities() {
    for (const capability of this.removedCapabilities) {
      if (this.hasCapability(capability)) {
        await this.removeCapability(capability).catch((err) => {
          this.error(`Could not remove ${capability}:`, err.message);
        });
      }
    }
    for (const capability of this.addedCapabilities) {
      if (!this.hasCapability(capability)) {
        await this.addCapability(capability).catch((err) => {
          this.error(`Could not add ${capability}:`, err.message);
        });
      }
    }
  }

  get hub() {
    return this._hub;
  }

  /**
   * Returns the hub, or throws a translated error when the NAS is unreachable.
   * Use this in flow actions and capability listeners.
   */
  requireHub() {
    if (!this._hub) throw new Error(this.homey.__('error.no_system'));
    if (!this._hub.available) throw new Error(this.homey.__('error.unreachable'));
    return this._hub;
  }

  /**
   * Subclasses implement this to map the hub's cached data onto capabilities.
   */
  async handleData(_hub) {}

  /**
   * Writes a capability only when the value actually changed, and never writes
   * null over an existing reading.
   */
  async setCapability(capability, value) {
    if (!this.hasCapability(capability)) return;
    if (value === null || value === undefined) return;
    if (this.getCapabilityValue(capability) === value) return;

    await this.setCapabilityValue(capability, value).catch((err) => {
      this.error(`Could not set ${capability}:`, err.message);
    });
  }

  /** Marks the device available and logs the transition once. */
  async markAvailable() {
    if (!this.getAvailable()) await this.setAvailable().catch(() => {});
  }

  /** Marks the device unavailable because its entry vanished from the NAS. */
  async markMissing() {
    await this.setUnavailable(this.homey.__('error.not_found')).catch(() => {});
  }

  _detach() {
    if (this._hub && this._onData) this._hub.removeListener('data', this._onData);
    if (this._hub && this._onUnavailable) this._hub.removeListener('unavailable', this._onUnavailable);
    this._onData = null;
    this._onUnavailable = null;
  }

  async onUninit() {
    this._detach();
  }

  async onDeleted() {
    this._detach();
  }

}

module.exports = ChildDevice;
