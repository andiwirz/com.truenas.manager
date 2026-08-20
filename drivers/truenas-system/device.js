'use strict';

const { Device } = require('homey');
const TrueNasHub = require('../../lib/TrueNasHub');
const { toGiB, toNumber } = require('../../lib/util');

const ALERT_LEVELS = ['INFO', 'NOTICE', 'WARNING', 'ERROR', 'CRITICAL', 'ALERT', 'EMERGENCY'];

/**
 * Homey destroys a device's Insights logs before it calls onDeleted, so a
 * write already in flight comes back as a missing LogLocal. That is the
 * device going away, not a fault worth reporting.
 */
function isGoneError(err) {
  const message = String((err && err.message) || err);
  return /not found|loglocal|invalid_device|no such device/i.test(message);
}

class TrueNasSystemDevice extends Device {

  async onInit() {
    this.systemId = this.getData().id;
    this._knownAlerts = new Set();
    this._seeded = false;
    this._updateWasAvailable = false;

    await this._createHub();

    this.registerCapabilityListener('nas_refresh', async () => {
      await this.refreshNow();
      return false;
    });

    this._registerUpdateListener();
    await this._applyUpdateButtonVisibility(this.getSetting('show_update_button') === true);

    this._triggerAlert = this.homey.flow.getDeviceTriggerCard('system_alert_raised');
    this._triggerUpdate = this.homey.flow.getDeviceTriggerCard('system_update_found');

    await this._hub.start();
  }

  async _createHub() {
    const s = this.getSettings();

    this._hub = new TrueNasHub({
      homey: this.homey,
      systemId: this.systemId,
      host: s.host,
      port: s.port,
      useSsl: s.use_ssl !== false,
      apiKey: s.api_key,
      rejectUnauthorized: s.ignore_cert === false,
      pollInterval: s.poll_interval,
      slowPollInterval: s.disk_poll_interval,
      log: (...args) => {
        this.log(...args);
        this.homey.app.addLog(this.getName(), 'log', args.join(' '));
      },
      error: (...args) => {
        this.error(...args);
        this.homey.app.addLog(this.getName(), 'error', args.join(' '));
      },
    });

    this._hub.on('data', () => {
      if (this.isGone()) return;
      this._handleData().catch((err) => {
        if (isGoneError(err)) return;
        this.error('Update failed:', err.message);
      });
    });
    this._hub.on('unavailable', (i18n) => {
      if (this.isGone()) return;
      this.setUnavailable(this.homey.__(i18n || 'error.unreachable')).catch(() => {});
    });

    this.homey.app.registerHub(this.systemId, this._hub);
  }

  /**
   * Homey removes the device from its driver and destroys the Insights logs
   * before calling onDeleted, so a write landing in that window is reported
   * by Homey itself. The write must simply not happen.
   */
  isGone() {
    if (this._destroyed) return true;
    try {
      const { driver } = this;
      if (!driver || typeof driver.getDevices !== 'function') return false;
      return !driver.getDevices().includes(this);
    } catch (_err) {
      return false;
    }
  }

  get hub() {
    return this._hub;
  }

  requireHub() {
    if (!this._hub) throw new Error(this.homey.__('error.no_system'));
    if (!this._hub.available) throw new Error(this.homey.__('error.unreachable'));
    return this._hub;
  }

  // ---------------------------------------------------------------------------
  // Capability updates
  // ---------------------------------------------------------------------------

  async _handleData() {
    const hub = this._hub;
    const sys = hub.data.system;

    if (!this.getAvailable()) await this.setAvailable().catch(() => {});

    await this._syncTemperatureCapability(hub);

    await this._set('nas_cpu_usage', sys.cpuUsage);
    await this._set('measure_temperature', sys.cpuTemperature);
    await this._set('nas_load_1', sys.load1);
    await this._set('nas_load_5', sys.load5);
    await this._set('nas_load_15', sys.load15);
    await this._set('nas_memory_usage', sys.memoryUsage);
    await this._set('nas_memory_used', toGiB(sys.memoryUsed));
    await this._set('nas_memory_free', toGiB(sys.memoryFree));
    await this._set('nas_arc_size', toGiB(sys.arcSize));
    await this._set('nas_net_rx', sys.networkRx);
    await this._set('nas_net_tx', sys.networkTx);
    await this._set('nas_uptime', sys.uptime);
    await this._set('nas_version', sys.version);

    await this._updateAlerts(hub);
    await this._updateUpdateStatus(hub);
    await this._syncInfoSettings(sys);
  }

  /**
   * Virtualised installs have no CPU temperature sensor at all. Once the hub
   * confirms the graph is unsupported, drop the capability instead of showing
   * a permanently empty tile.
   */
  async _syncTemperatureCapability(hub) {
    const supported = hub.isGraphAvailable('cputemp');

    if (!supported && this.hasCapability('measure_temperature')) {
      this.log('CPU temperature is not reported by this system, removing capability');
      await this.removeCapability('measure_temperature').catch(() => {});
    } else if (supported && !this.hasCapability('measure_temperature')) {
      await this.addCapability('measure_temperature').catch(() => {});
    }
  }

  async _updateAlerts(hub) {
    const threshold = Math.max(0, ALERT_LEVELS.indexOf(this.getSetting('alarm_level') || 'ERROR'));
    const relevant = hub.data.alerts.filter((a) => a.severity >= threshold);

    await this._set('nas_alert_count', hub.data.alerts.length);
    await this._set('nas_alert_text', relevant.length ? this._shorten(relevant[0].text) : '-');
    await this._set('alarm_generic', relevant.length > 0);

    const currentIds = new Set(relevant.map((a) => a.uuid || a.id));

    if (!this._seeded) {
      // Do not replay every pre-existing alert on app start.
      this._seeded = true;
      this._knownAlerts = currentIds;
      return;
    }

    for (const alert of relevant) {
      const key = alert.uuid || alert.id;
      if (this._knownAlerts.has(key)) continue;
      await this._triggerAlert.trigger(this, {
        level: alert.level || 'UNKNOWN',
        message: this._shorten(alert.text, 500),
        category: alert.klass || '',
      }).catch((err) => this.error('Alert trigger failed:', err.message));
    }

    this._knownAlerts = currentIds;
  }

  async _updateUpdateStatus(hub) {
    const {
      available, version, status, downloadProgress,
    } = hub.data.update;

    // Not a plain Number() check: update_download_progress is null unless a
    // download is actually running, and Number(null) is 0.
    const progress = toNumber(downloadProgress);

    let label;
    if (status === 'ERROR') {
      label = this.homey.__('state.update_error');
    } else if (status === null || status === undefined) {
      label = this.homey.__('state.unknown');
    } else if (available && progress !== null) {
      // The NAS is already pulling the image; show how far it has got.
      label = `${this.homey.__('state.downloading')} (${Math.round(progress)} %)`;
    } else if (available) {
      label = this.homey.__('state.update_available');
    } else {
      label = this.homey.__('state.up_to_date');
    }

    const showVersion = available && version && status !== 'ERROR';
    await this._set('nas_update_status', showVersion ? `${label} (${version})` : label);

    if (available && !this._updateWasAvailable) {
      await this._triggerUpdate.trigger(this, {
        version: version || '',
      }).catch((err) => this.error('Update trigger failed:', err.message));
    }
    this._updateWasAvailable = available;
  }

  /** Mirrors read-only system facts into the settings page. */
  async _syncInfoSettings(sys) {
    const next = {
      info_hostname: sys.hostname || '-',
      info_version: sys.version || '-',
      info_product: [sys.manufacturer, sys.product].filter(Boolean).join(' ') || '-',
      info_serial: sys.serial || '-',
    };

    const changed = {};
    for (const [key, value] of Object.entries(next)) {
      if (this.getSetting(key) !== value) changed[key] = value;
    }
    if (Object.keys(changed).length) {
      await this.setSettings(changed).catch(() => {});
    }
  }

  _shorten(text, max = 120) {
    if (!text) return '-';
    const clean = String(text).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
  }

  async _set(capability, value) {
    // Writes run in sequence; a deletion part way through must not land on
    // a device Homey has already torn down.
    if (this.isGone()) return;
    if (!this.hasCapability(capability)) return;
    if (value === null || value === undefined) return;
    if (this.getCapabilityValue(capability) === value) return;
    await this.setCapabilityValue(capability, value).catch((err) => {
      if (isGoneError(err)) return;
      this.error(`Could not set ${capability}:`, err.message);
    });
  }

  // ---------------------------------------------------------------------------
  // Flow conditions
  // ---------------------------------------------------------------------------

  async isUpdateAvailable() {
    return this.requireHub().data.update.available === true;
  }

  async hasAlertOfLevel(level) {
    const threshold = Math.max(0, ALERT_LEVELS.indexOf(level || 'ERROR'));
    return this.requireHub().data.alerts.some((a) => a.severity >= threshold);
  }

  async isCpuUsageAbove(percent) {
    const value = toNumber(this.requireHub().data.system.cpuUsage);
    if (value === null) return false;
    return value > Number(percent);
  }

  // ---------------------------------------------------------------------------
  // Flow actions
  // ---------------------------------------------------------------------------

  async rebootSystem(delay) {
    const hub = this.requireHub();
    const seconds = Number(delay) > 0 ? Math.round(Number(delay)) : null;
    this.log(`Rebooting TrueNAS${seconds ? ` in ${seconds} s` : ''}`);
    await hub.call('system.reboot', ['Homey flow', { delay: seconds }]);
  }

  async shutdownSystem(delay) {
    const hub = this.requireHub();
    const seconds = Number(delay) > 0 ? Math.round(Number(delay)) : null;
    this.log(`Shutting down TrueNAS${seconds ? ` in ${seconds} s` : ''}`);
    await hub.call('system.shutdown', ['Homey flow', { delay: seconds }]);
  }

  _registerUpdateListener() {
    if (!this.hasCapability('nas_update_button')) return;
    this.registerCapabilityListener('nas_update_button', async () => {
      // The tile button never reboots; that stays an explicit flow choice.
      await this.installUpdate(false);
      return false;
    });
  }

  async _applyUpdateButtonVisibility(visible) {
    if (visible && !this.hasCapability('nas_update_button')) {
      await this.addCapability('nas_update_button').catch(() => {});
      this._registerUpdateListener();
    } else if (!visible && this.hasCapability('nas_update_button')) {
      await this.removeCapability('nas_update_button').catch(() => {});
    }
  }

  /**
   * Installs a pending TrueNAS update.
   *
   * Only `update.run` is used. In 25.10 `update.update` writes the update
   * *configuration*, while on older releases the same name performed the
   * install — falling back to it could silently rewrite the user's settings.
   */
  async installUpdate(reboot = false) {
    const hub = this.requireHub();

    if (!hub.data.update.available) {
      this.log('No system update pending, nothing to install');
      return;
    }

    this.log(`Installing system update${reboot ? ' and rebooting' : ' without rebooting'}`);
    try {
      await hub.call('update.run', [{ reboot: Boolean(reboot) }]);
    } catch (err) {
      if (err.methodMissing) throw new Error(this.homey.__('error.update_unsupported'));
      throw err;
    }
    hub.scheduleRefresh(15000);
  }

  async checkForUpdate() {
    const hub = this.requireHub();
    hub.forceUpdateCheck();
    await hub.refreshNow();
  }

  async refreshNow() {
    if (!this._hub) throw new Error(this.homey.__('error.no_system'));
    await this._hub.refreshNow();
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async onSettings({ newSettings, changedKeys }) {
    const connectionKeys = ['host', 'port', 'use_ssl', 'ignore_cert', 'api_key'];
    const pollKeys = ['poll_interval', 'disk_poll_interval'];

    if (changedKeys.includes('show_update_button')) {
      await this._applyUpdateButtonVisibility(newSettings.show_update_button === true);
    }

    if (!changedKeys.some((key) => [...connectionKeys, ...pollKeys].includes(key))) return;
    if (!this._hub) return;

    this._hub.reconfigure({
      host: newSettings.host,
      port: newSettings.port,
      useSsl: newSettings.use_ssl !== false,
      apiKey: newSettings.api_key,
      rejectUnauthorized: newSettings.ignore_cert === false,
      pollInterval: newSettings.poll_interval,
      slowPollInterval: newSettings.disk_poll_interval,
    });
  }

  async onUninit() {
    this._teardown();
  }

  async onDeleted() {
    this._teardown();
  }

  _teardown() {
    this._destroyed = true;
    if (this._hub) {
      this._hub.removeAllListeners();
      this._hub.stop();
      this._hub = null;
    }
    this.homey.app.unregisterHub(this.systemId);
  }

}

module.exports = TrueNasSystemDevice;
