'use strict';

const { Device } = require('homey');

const HUB_RETRY_INTERVAL = 30000;

/**
 * Homey destroys a device's Insights logs before it calls onDeleted, so a write
 * already in flight comes back as a missing LogLocal. That is the device going
 * away, not a fault worth reporting.
 */
function isGoneError(err) {
  const message = String((err && err.message) || err);
  return /not found|loglocal|invalid_device|no such device/i.test(message);
}

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

    await this._attachHub();
  }

  /**
   * Attaches to the system device's hub. A system device that is slow to
   * initialise — or one that is itself still retrying a connection — must not
   * leave this device stranded, so a failed attempt is retried until it works
   * or the device goes away.
   */
  async _attachHub() {
    if (this._destroyed) return;

    this._hub = await this.homey.app.waitForHub(this.systemId);

    if (!this._hub) {
      this.error(`No hub for system ${this.systemId} yet, retrying`);
      await this.setUnavailable(this.homey.__('error.no_system')).catch(() => {});
      this._retryTimer = this.homey.setTimeout(() => {
        this._retryTimer = null;
        this._attachHub().catch((err) => this.error('Hub attach failed:', err.message));
      }, HUB_RETRY_INTERVAL);
      return;
    }

    this._onData = () => {
      if (this.isGone()) return;
      this.handleData(this._hub).catch((err) => {
        if (isGoneError(err)) return;
        this.error('Update failed:', err.message);
      });
    };
    this._onUnavailable = (i18n) => {
      if (this.isGone()) return;
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

  /**
   * Homey removes a device from its driver and destroys the Insights logs
   * before it calls onDeleted, so `_destroyed` alone is set too late. Any write
   * landing in that window is reported by Homey itself as a missing LogLocal,
   * which no catch of ours can suppress — the write simply must not happen.
   */
  isGone() {
    if (this._destroyed) return true;
    try {
      const { driver } = this;
      if (!driver || typeof driver.getDevices !== 'function') return false;
      // Instance identity, not the data id: Homey hands back the very same
      // Device objects, and comparing ids would match a different instance.
      return !driver.getDevices().includes(this);
    } catch (_err) {
      // Cannot tell: assume it is still there rather than going silent.
      return false;
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
    // handleData writes a whole run of values in sequence. If the device is
    // deleted part way through, the remaining writes would land on a device
    // Homey has already torn down.
    if (this.isGone()) return;
    if (!this.hasCapability(capability)) return;
    if (value === null || value === undefined) return;
    if (this.getCapabilityValue(capability) === value) return;

    await this.setCapabilityValue(capability, value).catch((err) => {
      if (isGoneError(err)) {
        // Stop the rest of this run rather than repeating the failure.
        this._destroyed = true;
        return;
      }
      this.error(`Could not set ${capability}:`, err.message);
    });
  }

  /** Marks the device available and logs the transition once. */
  async markAvailable() {
    if (this.isGone()) return;
    if (!this.getAvailable()) await this.setAvailable().catch(() => {});
  }

  /** Marks the device unavailable because its entry vanished from the NAS. */
  async markMissing() {
    if (this.isGone()) return;
    await this.setUnavailable(this.homey.__('error.not_found')).catch(() => {});
  }

  _detach() {
    this._destroyed = true;
    if (this._retryTimer) {
      this.homey.clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
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
