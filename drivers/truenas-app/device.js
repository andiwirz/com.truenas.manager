'use strict';

const ChildDevice = require('../../lib/ChildDevice');
const { titleCase } = require('../../lib/util');

class TrueNasAppDevice extends ChildDevice {

  get entityType() {
    return 'app';
  }

  /** Added to installs paired before these fields were read. */
  get addedCapabilities() {
    return ['app_image_update', 'app_containers'];
  }

  async onDeviceInit() {
    this._app = null;
    this._pendingState = null;
    this._prevState = null;
    this._updateWasAvailable = false;
    this._imageUpdateWasAvailable = false;

    this._trigStateChanged = this.homey.flow.getDeviceTriggerCard('app_state_changed');
    this._trigUpdate = this.homey.flow.getDeviceTriggerCard('app_update_found');
    this._trigImageUpdate = this.homey.flow.getDeviceTriggerCard('app_image_update_found');

    this.registerCapabilityListener('onoff', async (value) => {
      await this.setAppState(value);
    });

    this._registerRestartListener();
    this._registerUpgradeListener();
    await this._applyRestartButtonVisibility(this.getSetting('show_restart_button') !== false);
    await this._applyUpgradeButtonVisibility(this.getSetting('show_upgrade_button') !== false);
  }

  _registerRestartListener() {
    if (!this.hasCapability('app_restart_button')) return;
    this.registerCapabilityListener('app_restart_button', async () => {
      await this.redeployApp();
      return false;
    });
  }

  _registerUpgradeListener() {
    if (!this.hasCapability('app_upgrade_button')) return;
    this.registerCapabilityListener('app_upgrade_button', async () => {
      await this.upgradeApp();
      return false;
    });
  }

  async handleData(hub) {
    const app = hub.getApp(this.entityKey);
    if (!app) {
      this._app = null;
      await this.markMissing();
      return;
    }

    this._app = app;
    await this.markAvailable();

    // DEPLOYING and STOPPING are transitional; keep the toggle where the user
    // put it until the app settles.
    const settled = app.state === 'RUNNING' || app.state === 'STOPPED' || app.state === 'CRASHED';
    if (settled && (this._pendingState === null || this._pendingState === app.running)) {
      this._pendingState = null;
      await this.setCapability('onoff', app.running);
    }

    await this.setCapability('app_state', titleCase(app.state));
    await this.setCapability('app_version', app.version || '-');
    await this.setCapability('app_update_available', app.upgradeAvailable === true);
    await this.setCapability('app_image_update', app.imageUpdates === true);
    await this.setCapability('app_containers', app.containers);

    await this._fireStateTrigger(app);
    await this._fireUpdateTrigger(app);
    await this._syncInfoSettings(app);
  }

  async _fireStateTrigger(app) {
    const previous = this._prevState;
    this._prevState = app.state;
    if (previous === null || previous === app.state) return;

    await this._trigStateChanged.trigger(this, {
      state: titleCase(app.state) || '',
      previous_state: titleCase(previous) || '',
      portal: app.portal || '',
    }).catch((err) => this.error('State trigger failed:', err.message));
  }

  async _fireUpdateTrigger(app) {
    const available = app.upgradeAvailable === true;
    if (available && !this._updateWasAvailable) {
      await this._trigUpdate.trigger(this, {
        version: app.latestVersion || '',
        portal: app.portal || '',
      }).catch((err) => this.error('Update trigger failed:', err.message));
    }
    this._updateWasAvailable = available;

    const imageAvailable = app.imageUpdates === true;
    if (imageAvailable && !this._imageUpdateWasAvailable) {
      await this._trigImageUpdate.trigger(this, {
        portal: app.portal || '',
      }).catch((err) => this.error('Image update trigger failed:', err.message));
    }
    this._imageUpdateWasAvailable = imageAvailable;
  }

  async _syncInfoSettings(app) {
    const next = {
      info_app: app.id || app.name || '-',
      info_latest_version: app.latestVersion || '-',
      info_portal: app.portal || '-',
    };
    const changed = {};
    for (const [key, value] of Object.entries(next)) {
      if (this.getSetting(key) !== value) changed[key] = value;
    }
    if (Object.keys(changed).length) await this.setSettings(changed).catch(() => {});
  }

  async _applyRestartButtonVisibility(visible) {
    if (visible && !this.hasCapability('app_restart_button')) {
      await this.addCapability('app_restart_button').catch(() => {});
      this._registerRestartListener();
    } else if (!visible && this.hasCapability('app_restart_button')) {
      await this.removeCapability('app_restart_button').catch(() => {});
    }
  }

  async _applyUpgradeButtonVisibility(visible) {
    if (visible && !this.hasCapability('app_upgrade_button')) {
      await this.addCapability('app_upgrade_button').catch(() => {});
      this._registerUpgradeListener();
    } else if (!visible && this.hasCapability('app_upgrade_button')) {
      await this.removeCapability('app_upgrade_button').catch(() => {});
    }
  }

  // ---------------------------------------------------------------------------
  // Flow conditions
  // ---------------------------------------------------------------------------

  async isRunning() {
    this.requireHub();
    return this._app ? this._app.running === true : false;
  }

  async isUpdateAvailable() {
    this.requireHub();
    return this._app ? this._app.upgradeAvailable === true : false;
  }

  async isImageUpdateAvailable() {
    this.requireHub();
    return this._app ? this._app.imageUpdates === true : false;
  }

  // ---------------------------------------------------------------------------
  // Flow actions
  // ---------------------------------------------------------------------------

  async setAppState(running) {
    const hub = this.requireHub();
    const name = this._requireApp().name;

    this.log(`${running ? 'Starting' : 'Stopping'} app ${name}`);
    await hub.call(running ? 'app.start' : 'app.stop', [name]);

    this._pendingState = Boolean(running);
    await this.setCapability('onoff', Boolean(running));
    hub.scheduleRefresh(5000);
  }

  async redeployApp() {
    const hub = this.requireHub();
    const name = this._requireApp().name;

    this.log(`Redeploying app ${name}`);
    await hub.call('app.redeploy', [name]);
    hub.scheduleRefresh(8000);
  }

  /**
   * Installs whatever update is pending. TrueNAS tracks a catalog version
   * upgrade and newer container images separately, and they need different
   * calls: `app.upgrade` moves to a new catalog version, while pulling fresh
   * images for the same version is what a redeploy does.
   */
  async upgradeApp() {
    const hub = this.requireHub();
    const app = this._requireApp();

    if (app.upgradeAvailable) {
      this.log(`Upgrading app ${app.name} to ${app.latestVersion || 'latest'}`);
      await hub.call('app.upgrade', [app.name, { app_version: 'latest' }]);
      this._pendingState = true;
      hub.scheduleRefresh(10000);
      return;
    }

    if (app.imageUpdates) {
      this.log(`Pulling newer container images for app ${app.name}`);
      await hub.call('app.redeploy', [app.name]);
      this._pendingState = true;
      hub.scheduleRefresh(10000);
      return;
    }

    this.log(`App ${app.name} is already up to date`);
  }

  _requireApp() {
    if (!this._app) throw new Error(this.homey.__('error.not_found'));
    return this._app;
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('show_restart_button')) {
      await this._applyRestartButtonVisibility(newSettings.show_restart_button !== false);
    }
    if (changedKeys.includes('show_upgrade_button')) {
      await this._applyUpgradeButtonVisibility(newSettings.show_upgrade_button !== false);
    }
  }

}

module.exports = TrueNasAppDevice;
