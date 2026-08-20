'use strict';

const ChildDevice = require('../../lib/ChildDevice');
const { titleCase } = require('../../lib/util');

class TrueNasTaskDevice extends ChildDevice {

  get entityType() {
    return 'task';
  }

  async onDeviceInit() {
    this._task = null;
    this._prevState = null;
    this._wasRunning = false;

    this._trigFinished = this.homey.flow.getDeviceTriggerCard('task_finished');
    this._trigFailed = this.homey.flow.getDeviceTriggerCard('task_failed');

    this._registerRunListener();
    await this._applyRunButtonVisibility(this.getSetting('show_run_button') === true);
  }

  _registerRunListener() {
    if (!this.hasCapability('task_run_button')) return;
    this.registerCapabilityListener('task_run_button', async () => {
      await this.runTask();
      return false;
    });
  }

  async handleData(hub) {
    const task = hub.getTask(this.entityKey);
    if (!task) {
      this._task = null;
      await this.markMissing();
      return;
    }

    this._task = task;
    await this.markAvailable();

    await this.setCapability('task_state', titleCase(task.state));
    await this.setCapability('task_progress', task.running ? (task.progress || 0) : 0);
    await this.setCapability('task_last_run', this._formatTime(task.lastRun));
    await this.setCapability('alarm_generic', task.failed === true);

    await this._fireTriggers(task);
    await this._syncInfoSettings(task);
  }

  /**
   * The run finished when the task leaves RUNNING, which is the moment worth
   * reporting — not every poll while it sits in SUCCESS afterwards.
   */
  async _fireTriggers(task) {
    const previousState = this._prevState;
    const wasRunning = this._wasRunning;

    this._prevState = task.state;
    this._wasRunning = task.running;

    if (previousState === null) return;
    if (!wasRunning || task.running) return;

    const tokens = {
      task: task.name || '',
      state: titleCase(task.state) || '',
      type: task.type,
    };

    await this._trigFinished.trigger(this, tokens)
      .catch((err) => this.error('Finished trigger failed:', err.message));

    if (task.failed) {
      await this._trigFailed.trigger(this, tokens)
        .catch((err) => this.error('Failed trigger failed:', err.message));
    }
  }

  _formatTime(iso) {
    if (!iso) return '-';
    try {
      // Homey knows the user's timezone; sv-SE gives an unambiguous
      // year-month-day order regardless of the app language.
      const timeZone = this.homey.clock.getTimezone();
      return new Date(iso).toLocaleString('sv-SE', { timeZone }).slice(0, 16);
    } catch (_err) {
      return String(iso).replace('T', ' ').slice(0, 16);
    }
  }

  async _syncInfoSettings(task) {
    const next = {
      info_target: task.path || '-',
    };
    if (this.getSetting('info_target') !== next.info_target) {
      await this.setSettings(next).catch(() => {});
    }
  }

  async _applyRunButtonVisibility(visible) {
    if (visible && !this.hasCapability('task_run_button')) {
      await this.addCapability('task_run_button').catch(() => {});
      this._registerRunListener();
    } else if (!visible && this.hasCapability('task_run_button')) {
      await this.removeCapability('task_run_button').catch(() => {});
    }
  }

  // ---------------------------------------------------------------------------
  // Flow conditions
  // ---------------------------------------------------------------------------

  async isRunning() {
    this.requireHub();
    return this._task ? this._task.running === true : false;
  }

  async lastRunFailed() {
    this.requireHub();
    return this._task ? this._task.failed === true : false;
  }

  // ---------------------------------------------------------------------------
  // Flow actions
  // ---------------------------------------------------------------------------

  async runTask() {
    const hub = this.requireHub();
    const task = this._requireTask();

    if (task.running) {
      this.log(`Task ${task.name} is already running`);
      return;
    }

    this.log(`Running ${task.type} task ${task.name}`);
    switch (task.type) {
      case 'cloudsync':
        await hub.call('cloudsync.sync', [task.id, {}]);
        break;
      case 'replication':
        await hub.call('replication.run', [task.id]);
        break;
      case 'snapshot':
        await hub.call('pool.snapshottask.run', [task.id]);
        break;
      default:
        throw new Error(this.homey.__('error.not_found'));
    }
    hub.scheduleRefresh(5000);
  }

  async abortTask() {
    const hub = this.requireHub();
    const task = this._requireTask();

    // Only cloud sync jobs can be aborted through the API.
    if (task.type !== 'cloudsync') {
      throw new Error(this.homey.__('error.abort_unsupported'));
    }
    if (!task.running) {
      this.log(`Task ${task.name} is not running`);
      return;
    }

    this.log(`Aborting cloud sync task ${task.name}`);
    await hub.call('cloudsync.abort', [task.id]);
    hub.scheduleRefresh(5000);
  }

  _requireTask() {
    if (!this._task) throw new Error(this.homey.__('error.not_found'));
    return this._task;
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('show_run_button')) {
      await this._applyRunButtonVisibility(newSettings.show_run_button === true);
    }
  }

}

module.exports = TrueNasTaskDevice;
