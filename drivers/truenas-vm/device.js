'use strict';

const ChildDevice = require('../../lib/ChildDevice');
const { titleCase, round } = require('../../lib/util');

class TrueNasVmDevice extends ChildDevice {

  get entityType() {
    return 'vm';
  }

  async onDeviceInit() {
    this._vm = null;
    this._pendingState = null;
    this._prevState = null;

    this._trigStateChanged = this.homey.flow.getDeviceTriggerCard('vm_state_changed');

    this.registerCapabilityListener('onoff', async (value) => {
      await this.setVmState(value, this.getSetting('force_stop') === true);
    });

    this._registerRestartListener();
    await this._applyRestartButtonVisibility(this.getSetting('show_restart_button') !== false);
  }

  _registerRestartListener() {
    if (!this.hasCapability('vm_restart_button')) return;
    this.registerCapabilityListener('vm_restart_button', async () => {
      await this.restartVm();
      return false;
    });
  }

  async handleData(hub) {
    const vm = hub.getVm(this.entityKey);
    if (!vm) {
      this._vm = null;
      await this.markMissing();
      return;
    }

    this._vm = vm;
    await this.markAvailable();

    if (this._pendingState === null || this._pendingState === vm.running) {
      this._pendingState = null;
      await this.setCapability('onoff', vm.running);
    }

    await this.setCapability('vm_state', titleCase(vm.state));
    // vm.query reports memory in MiB already.
    await this.setCapability('vm_memory', round(vm.memory, 0));

    await this._fireStateTrigger(vm);
    await this._syncInfoSettings(vm);
  }

  async _fireStateTrigger(vm) {
    const previous = this._prevState;
    this._prevState = vm.state;
    if (previous === null || previous === vm.state) return;

    await this._trigStateChanged.trigger(this, {
      state: titleCase(vm.state) || '',
      previous_state: titleCase(previous) || '',
    }).catch((err) => this.error('State trigger failed:', err.message));
  }

  async _syncInfoSettings(vm) {
    const value = vm.vcpus ? String(vm.vcpus) : '-';
    if (this.getSetting('info_vcpus') !== value) {
      await this.setSettings({ info_vcpus: value }).catch(() => {});
    }
  }

  async _applyRestartButtonVisibility(visible) {
    if (visible && !this.hasCapability('vm_restart_button')) {
      await this.addCapability('vm_restart_button').catch(() => {});
      this._registerRestartListener();
    } else if (!visible && this.hasCapability('vm_restart_button')) {
      await this.removeCapability('vm_restart_button').catch(() => {});
    }
  }

  // ---------------------------------------------------------------------------
  // Flow conditions
  // ---------------------------------------------------------------------------

  async isRunning() {
    this.requireHub();
    return this._vm ? this._vm.running === true : false;
  }

  // ---------------------------------------------------------------------------
  // Flow actions
  // ---------------------------------------------------------------------------

  async setVmState(running, force = false) {
    const hub = this.requireHub();
    const vm = this._requireVm();

    if (running) {
      this.log(`Starting VM ${vm.name}`);
      await hub.call('vm.start', [vm.id, {}]);
    } else if (force) {
      this.log(`Powering off VM ${vm.name}`);
      await hub.call('vm.poweroff', [vm.id]);
    } else {
      this.log(`Stopping VM ${vm.name}`);
      await hub.call('vm.stop', [vm.id, { force: false }]);
    }

    this._pendingState = Boolean(running);
    await this.setCapability('onoff', Boolean(running));
    hub.scheduleRefresh(8000);
  }

  async restartVm() {
    const hub = this.requireHub();
    const vm = this._requireVm();

    this.log(`Restarting VM ${vm.name}`);
    await hub.call('vm.restart', [vm.id]);
    this._pendingState = true;
    hub.scheduleRefresh(10000);
  }

  _requireVm() {
    if (!this._vm) throw new Error(this.homey.__('error.not_found'));
    return this._vm;
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('show_restart_button')) {
      await this._applyRestartButtonVisibility(newSettings.show_restart_button !== false);
    }
  }

}

module.exports = TrueNasVmDevice;
