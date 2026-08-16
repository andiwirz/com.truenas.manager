'use strict';

const ChildDevice = require('../../lib/ChildDevice');
const { toTiB, titleCase } = require('../../lib/util');

const SCRUB_RUNNING = ['SCANNING', 'RUNNING'];

class TrueNasPoolDevice extends ChildDevice {

  get entityType() {
    return 'pool';
  }

  async onDeviceInit() {
    this._pool = null;
    this._prevStatus = null;
    this._prevFreePercent = null;
    this._prevScrubState = null;

    this._trigStatusChanged = this.homey.flow.getDeviceTriggerCard('pool_status_changed');
    this._trigUnhealthy = this.homey.flow.getDeviceTriggerCard('pool_unhealthy');
    this._trigScrubStarted = this.homey.flow.getDeviceTriggerCard('pool_scrub_started');
    this._trigScrubFinished = this.homey.flow.getDeviceTriggerCard('pool_scrub_finished');

    this._trigSpaceLow = this.homey.flow.getDeviceTriggerCard('pool_space_low');
    this._trigSpaceLow.registerRunListener(async (args, state) => {
      // Fire only on the downward crossing, not on every poll below the mark.
      return state.freePercent < args.percent && state.previousFreePercent >= args.percent;
    });

    this._registerScrubListener();
    await this._applyScrubButtonVisibility(this.getSetting('show_scrub_button') !== false);
  }

  _registerScrubListener() {
    if (!this.hasCapability('pool_scrub_button')) return;
    this.registerCapabilityListener('pool_scrub_button', async () => {
      await this.startScrub();
      return false;
    });
  }

  async handleData(hub) {
    const pool = hub.getPool(this.entityKey);
    if (!pool) {
      this._pool = null;
      await this.markMissing();
      return;
    }

    this._pool = pool;
    await this.markAvailable();

    const unhealthy = pool.healthy !== true;
    const usage = pool.usage;
    const freePercent = usage === null ? null : Math.max(0, 100 - usage);

    await this.setCapability('pool_status', titleCase(pool.status));
    await this.setCapability('alarm_generic', unhealthy);
    await this.setCapability('pool_usage', usage);
    await this.setCapability('pool_used', toTiB(pool.allocated));
    await this.setCapability('pool_free', toTiB(pool.free));
    await this.setCapability('pool_total', toTiB(pool.size));

    await this._updateScrub(pool);
    await this._fireStatusTriggers(pool, unhealthy);
    await this._fireSpaceTrigger(pool, freePercent);
    await this._syncInfoSettings(pool);
  }

  async _updateScrub(pool) {
    const running = SCRUB_RUNNING.includes(String(pool.scrubState || '').toUpperCase());
    const label = pool.scrubState
      ? titleCase(pool.scrubState)
      : this.homey.__('state.no_scrub');

    await this.setCapability('scrub_state', label);
    await this.setCapability('scrub_progress', running ? (pool.scrubProgress || 0) : 0);

    const previous = this._prevScrubState;
    this._prevScrubState = pool.scrubState || null;

    if (previous === null) return;

    const wasRunning = SCRUB_RUNNING.includes(String(previous).toUpperCase());
    if (!wasRunning && running) {
      await this._trigScrubStarted.trigger(this, { pool: pool.name })
        .catch((err) => this.error('Scrub start trigger failed:', err.message));
    } else if (wasRunning && !running) {
      await this._trigScrubFinished.trigger(this, {
        pool: pool.name,
        errors: Number(pool.scrubErrors) || 0,
      }).catch((err) => this.error('Scrub finish trigger failed:', err.message));
    }
  }

  async _fireStatusTriggers(pool, unhealthy) {
    const previous = this._prevStatus;
    this._prevStatus = pool.status;

    if (previous === null || previous === pool.status) return;

    await this._trigStatusChanged.trigger(this, {
      status: titleCase(pool.status) || '',
      previous_status: titleCase(previous) || '',
    }).catch((err) => this.error('Status trigger failed:', err.message));

    if (unhealthy) {
      await this._trigUnhealthy.trigger(this, {
        status: titleCase(pool.status) || '',
        detail: pool.statusDetail || '',
      }).catch((err) => this.error('Unhealthy trigger failed:', err.message));
    }
  }

  async _fireSpaceTrigger(pool, freePercent) {
    if (freePercent === null) return;

    const previous = this._prevFreePercent === null ? freePercent : this._prevFreePercent;
    this._prevFreePercent = freePercent;

    if (freePercent === previous) return;

    await this._trigSpaceLow.trigger(
      this,
      { free_percent: freePercent, free_tb: toTiB(pool.free) || 0 },
      { freePercent, previousFreePercent: previous },
    ).catch((err) => this.error('Space trigger failed:', err.message));
  }

  async _syncInfoSettings(pool) {
    const next = {
      info_pool: pool.name || '-',
      info_status_detail: pool.statusDetail || '-',
    };
    const changed = {};
    for (const [key, value] of Object.entries(next)) {
      if (this.getSetting(key) !== value) changed[key] = value;
    }
    if (Object.keys(changed).length) await this.setSettings(changed).catch(() => {});
  }

  async _applyScrubButtonVisibility(visible) {
    if (visible && !this.hasCapability('pool_scrub_button')) {
      await this.addCapability('pool_scrub_button').catch(() => {});
      this._registerScrubListener();
    } else if (!visible && this.hasCapability('pool_scrub_button')) {
      await this.removeCapability('pool_scrub_button').catch(() => {});
    }
  }

  // ---------------------------------------------------------------------------
  // Flow conditions
  // ---------------------------------------------------------------------------

  async isHealthy() {
    const pool = this._requirePool();
    return pool.healthy === true;
  }

  async isFreeSpaceBelow(percent) {
    const pool = this._requirePool();
    if (pool.usage === null) return false;
    return (100 - pool.usage) < Number(percent);
  }

  async isScrubRunning() {
    const pool = this._requirePool();
    return SCRUB_RUNNING.includes(String(pool.scrubState || '').toUpperCase());
  }

  // ---------------------------------------------------------------------------
  // Flow actions
  // ---------------------------------------------------------------------------

  async startScrub() {
    await this._scrubAction('START');
  }

  async stopScrub() {
    await this._scrubAction('STOP');
  }

  async _scrubAction(action) {
    const hub = this.requireHub();
    const pool = this._requirePool();

    // The boot pool is not a regular pool: it has its own scrub method, which
    // only starts and cannot be stopped.
    if (pool.isBoot) {
      if (action !== 'START') {
        throw new Error(this.homey.__('error.boot_scrub_stop'));
      }
      this.log('Starting scrub on the boot pool');
      await hub.call('boot.scrub', []);
      hub.scheduleRefresh(5000);
      return;
    }

    this.log(`${action} scrub on pool ${pool.name}`);
    await hub.call('pool.scrub.scrub', [pool.name, action]);
    hub.scheduleRefresh(5000);
  }

  _requirePool() {
    this.requireHub();
    if (!this._pool) throw new Error(this.homey.__('error.not_found'));
    return this._pool;
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('show_scrub_button')) {
      await this._applyScrubButtonVisibility(newSettings.show_scrub_button !== false);
    }
  }

}

module.exports = TrueNasPoolDevice;
