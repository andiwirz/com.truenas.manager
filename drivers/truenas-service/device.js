'use strict';

const ChildDevice = require('../../lib/ChildDevice');
const { titleCase } = require('../../lib/util');

class TrueNasServiceDevice extends ChildDevice {

  get entityType() {
    return 'service';
  }

  async onDeviceInit() {
    this._service = null;
    // Set while a start/stop is in flight, so an in-between poll does not
    // bounce the toggle back to its old position.
    this._pendingState = null;

    this.registerCapabilityListener('onoff', async (value) => {
      await this.setServiceState(value);
    });

    this._registerRestartListener();
    await this._applyRestartButtonVisibility(this.getSetting('show_restart_button') !== false);
  }

  _registerRestartListener() {
    if (!this.hasCapability('service_restart_button')) return;
    this.registerCapabilityListener('service_restart_button', async () => {
      await this.restartService();
      return false;
    });
  }

  async handleData(hub) {
    const service = hub.getService(this.entityKey);
    if (!service) {
      this._service = null;
      await this.markMissing();
      return;
    }

    this._service = service;
    await this.markAvailable();

    if (this._pendingState === null || this._pendingState === service.running) {
      this._pendingState = null;
      await this.setCapability('onoff', service.running);
    }

    await this.setCapability('service_state', titleCase(service.state));
    await this.setCapability('service_autostart', service.enable);
  }

  async _applyRestartButtonVisibility(visible) {
    if (visible && !this.hasCapability('service_restart_button')) {
      await this.addCapability('service_restart_button').catch(() => {});
      this._registerRestartListener();
    } else if (!visible && this.hasCapability('service_restart_button')) {
      await this.removeCapability('service_restart_button').catch(() => {});
    }
  }

  // ---------------------------------------------------------------------------
  // Flow conditions
  // ---------------------------------------------------------------------------

  async isRunning() {
    this.requireHub();
    return this._service ? this._service.running === true : false;
  }

  // ---------------------------------------------------------------------------
  // Flow actions
  // ---------------------------------------------------------------------------

  async setServiceState(running) {
    await this._control(running ? 'START' : 'STOP');
    this._pendingState = Boolean(running);
    await this.setCapability('onoff', Boolean(running));
  }

  async restartService() {
    await this._control('RESTART');
    this._pendingState = true;
  }

  /**
   * Reload re-reads the service configuration without dropping existing
   * connections, which a restart would.
   */
  async reloadService() {
    await this._control('RELOAD');
  }

  async _control(verb) {
    const hub = this.requireHub();
    const name = this._requireService().service;

    this.log(`${verb} service ${name}`);

    // 26.0 replaced the per-verb methods with service.control.
    await hub.callFirst([
      ['service.control', [verb, name, {}]],
      [`service.${verb.toLowerCase()}`, [name, {}]],
    ]);

    hub.scheduleRefresh(3000);
  }

  _requireService() {
    if (!this._service) throw new Error(this.homey.__('error.not_found'));
    return this._service;
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('show_restart_button')) {
      await this._applyRestartButtonVisibility(newSettings.show_restart_button !== false);
    }
  }

}

module.exports = TrueNasServiceDevice;
