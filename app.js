'use strict';

const { App } = require('homey');

const LOG_LIMIT = 300;

class TrueNasApp extends App {

  async onInit() {
    /** @type {Map<string, import('./lib/TrueNasHub')>} */
    this._hubs = new Map();
    this._hubWaiters = new Map();
    this._logBuffer = [];

    try {
      this.homey.settings.set('app_version', this.homey.manifest.version);
    } catch (_err) {
      // settings are not critical
    }

    this._registerFlowCards();
    this.log('TrueNAS Manager has been initialized');
  }

  // ---------------------------------------------------------------------------
  // Hub registry — one hub per TrueNAS system, shared by all its devices
  // ---------------------------------------------------------------------------

  registerHub(systemId, hub) {
    this._hubs.set(systemId, hub);

    const waiters = this._hubWaiters.get(systemId);
    if (waiters) {
      this._hubWaiters.delete(systemId);
      for (const resolve of waiters) resolve(hub);
    }
  }

  unregisterHub(systemId) {
    this._hubs.delete(systemId);
  }

  getHub(systemId) {
    return this._hubs.get(systemId) || null;
  }

  listHubs() {
    return Array.from(this._hubs.entries()).map(([systemId, hub]) => ({ systemId, hub }));
  }

  /**
   * Child devices can initialise before their system device does, so they wait
   * here rather than failing outright.
   */
  waitForHub(systemId, timeout = 30000) {
    const existing = this.getHub(systemId);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve) => {
      const waiters = this._hubWaiters.get(systemId) || [];
      waiters.push(resolve);
      this._hubWaiters.set(systemId, waiters);

      this.homey.setTimeout(() => {
        const list = this._hubWaiters.get(systemId);
        if (!list) return;
        const index = list.indexOf(resolve);
        if (index >= 0) list.splice(index, 1);
        if (!list.length) this._hubWaiters.delete(systemId);
        resolve(this.getHub(systemId));
      }, timeout);
    });
  }

  // ---------------------------------------------------------------------------
  // Diagnostics log, surfaced on the app settings page
  // ---------------------------------------------------------------------------

  /** Detailed poll chatter is only kept when the user asks for it. */
  isVerbose() {
    try {
      return this.homey.settings.get('verbose_log') === true;
    } catch (_err) {
      return false;
    }
  }

  addLog(source, level, message) {
    if (level !== 'error' && !this.isVerbose()) return;

    this._logBuffer.push({
      time: new Date().toISOString(),
      source,
      level,
      message: String(message),
    });
    if (this._logBuffer.length > LOG_LIMIT) {
      this._logBuffer.splice(0, this._logBuffer.length - LOG_LIMIT);
    }
  }

  getLog() {
    return this._logBuffer.slice().reverse();
  }

  clearLog() {
    this._logBuffer = [];
  }

  // ---------------------------------------------------------------------------
  // Flow cards
  //
  // Conditions and actions are registered once here. Triggers are device
  // triggers and are fired from the devices themselves.
  // ---------------------------------------------------------------------------

  _registerFlowCards() {
    const condition = (id, listener) => {
      this.homey.flow.getConditionCard(id).registerRunListener(listener);
    };
    const action = (id, listener) => {
      this.homey.flow.getActionCard(id).registerRunListener(listener);
    };

    // --- System ---
    condition('system_update_available', async (args) => args.device.isUpdateAvailable());
    condition('system_has_alert', async (args) => args.device.hasAlertOfLevel(args.level));
    condition('system_cpu_usage_above', async (args) => args.device.isCpuUsageAbove(args.percent));

    action('system_reboot', async (args) => args.device.rebootSystem(args.delay));
    action('system_shutdown', async (args) => args.device.shutdownSystem(args.delay));
    action('system_check_update', async (args) => args.device.checkForUpdate());
    action('system_install_update', async (args) => args.device.installUpdate(args.reboot === 'true'));
    action('system_refresh', async (args) => args.device.refreshNow());

    // --- Pool ---
    condition('pool_is_healthy', async (args) => args.device.isHealthy());
    condition('pool_free_space_below', async (args) => args.device.isFreeSpaceBelow(args.percent));
    condition('pool_scrub_running', async (args) => args.device.isScrubRunning());

    action('pool_start_scrub', async (args) => args.device.startScrub());
    action('pool_stop_scrub', async (args) => args.device.stopScrub());

    // --- Disk ---
    condition('disk_temperature_above', async (args) => args.device.isTemperatureAbove(args.temperature));

    // --- Service ---
    condition('service_is_running', async (args) => args.device.isRunning());
    action('service_start', async (args) => args.device.setServiceState(true));
    action('service_stop', async (args) => args.device.setServiceState(false));
    action('service_restart', async (args) => args.device.restartService());
    action('service_reload', async (args) => args.device.reloadService());

    // --- App ---
    condition('app_is_running', async (args) => args.device.isRunning());
    condition('app_update_available', async (args) => args.device.isUpdateAvailable());
    condition('app_image_update_available', async (args) => args.device.isImageUpdateAvailable());
    action('app_start', async (args) => args.device.setAppState(true));
    action('app_stop', async (args) => args.device.setAppState(false));
    action('app_redeploy', async (args) => args.device.redeployApp());
    action('app_upgrade', async (args) => args.device.upgradeApp());

    // --- Task ---
    condition('task_is_running', async (args) => args.device.isRunning());
    condition('task_last_run_failed', async (args) => args.device.lastRunFailed());
    action('task_run', async (args) => args.device.runTask());
    action('task_abort', async (args) => args.device.abortTask());

    // --- Dataset ---
    condition('dataset_free_space_below', async (args) => args.device.isFreeSpaceBelow(args.percent));
    action('dataset_create_snapshot', async (args) => ({ name: await args.device.createSnapshot() }));

    // --- VM ---
    condition('vm_is_running', async (args) => args.device.isRunning());
    action('vm_start', async (args) => args.device.setVmState(true, false, args.overcommit === 'true'));
    action('vm_stop', async (args) => args.device.setVmState(false, args.force === 'true'));
    action('vm_restart', async (args) => args.device.restartVm());
  }

}

module.exports = TrueNasApp;
