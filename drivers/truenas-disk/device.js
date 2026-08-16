'use strict';

const ChildDevice = require('../../lib/ChildDevice');
const { toTiB } = require('../../lib/util');

class TrueNasDiskDevice extends ChildDevice {

  get entityType() {
    return 'disk';
  }

  async onDeviceInit() {
    this._disk = null;
    this._temperature = null;
    this._prevTemperature = null;

    this._trigTempHigh = this.homey.flow.getDeviceTriggerCard('disk_temperature_high');
    this._trigTempHigh.registerRunListener(async (args, state) => {
      // Only on the upward crossing, so a hot disk does not fire every poll.
      return state.temperature > args.temperature
        && state.previousTemperature <= args.temperature;
    });
  }

  async handleData(hub) {
    const disk = hub.getDisk(this.entityKey);
    if (!disk) {
      this._disk = null;
      await this.markMissing();
      return;
    }

    this._disk = disk;
    await this.markAvailable();

    await this.setCapability('disk_size', toTiB(disk.size));
    await this.setCapability('disk_model', disk.model || '-');
    await this.setCapability('disk_pool', disk.pool || '-');

    const temperature = hub.getDiskTemperature(disk);
    if (temperature === null) return;

    await this.setCapability('measure_temperature', temperature);

    const threshold = Number(this.getSetting('temperature_alarm')) || 50;
    await this.setCapability('alarm_generic', temperature > threshold);

    const previous = this._prevTemperature === null ? temperature : this._prevTemperature;
    this._prevTemperature = temperature;
    this._temperature = temperature;

    if (temperature === previous) return;

    await this._trigTempHigh.trigger(
      this,
      { temperature, disk: disk.name || '' },
      { temperature, previousTemperature: previous },
    ).catch((err) => this.error('Temperature trigger failed:', err.message));
  }

  // ---------------------------------------------------------------------------
  // Flow conditions
  // ---------------------------------------------------------------------------

  async isTemperatureAbove(temperature) {
    this.requireHub();
    if (this._temperature === null) return false;
    return this._temperature > Number(temperature);
  }

}

module.exports = TrueNasDiskDevice;
