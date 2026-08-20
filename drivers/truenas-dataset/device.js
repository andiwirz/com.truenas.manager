'use strict';

const ChildDevice = require('../../lib/ChildDevice');
const { toGiB } = require('../../lib/util');

class TrueNasDatasetDevice extends ChildDevice {

  get entityType() {
    return 'dataset';
  }

  async onDeviceInit() {
    this._dataset = null;
    this._prevFreePercent = null;

    this._trigSpaceLow = this.homey.flow.getDeviceTriggerCard('dataset_space_low');
    this._trigSpaceLow.registerRunListener(async (args, state) => {
      // Only on the downward crossing, not on every poll below the mark.
      return state.freePercent < args.percent && state.previousFreePercent >= args.percent;
    });

    this._registerSnapshotListener();
    await this._applySnapshotButtonVisibility(this.getSetting('show_snapshot_button') === true);
  }

  _registerSnapshotListener() {
    if (!this.hasCapability('dataset_snapshot_button')) return;
    this.registerCapabilityListener('dataset_snapshot_button', async () => {
      await this.createSnapshot();
      return false;
    });
  }

  async handleData(hub) {
    const dataset = hub.getDataset(this.entityKey);
    if (!dataset) {
      this._dataset = null;
      await this.markMissing();
      return;
    }

    this._dataset = dataset;
    await this.markAvailable();

    await this.setCapability('dataset_usage', dataset.usage);
    await this.setCapability('dataset_used', toGiB(dataset.used));
    await this.setCapability('dataset_free', toGiB(dataset.available));
    // A dataset without a quota inherits the pool's free space; show zero
    // rather than leaving the tile blank.
    await this.setCapability('dataset_quota', toGiB(dataset.quota) || 0);
    await this.setCapability('dataset_compression', dataset.compressRatio || '-');

    await this._fireSpaceTrigger(dataset);
    await this._syncInfoSettings(dataset);
  }

  async _fireSpaceTrigger(dataset) {
    if (dataset.usage === null) return;
    const freePercent = Math.max(0, 100 - dataset.usage);

    const previous = this._prevFreePercent === null ? freePercent : this._prevFreePercent;
    this._prevFreePercent = freePercent;
    if (freePercent === previous) return;

    await this._trigSpaceLow.trigger(
      this,
      { free_percent: freePercent, free_gb: toGiB(dataset.available) || 0 },
      { freePercent, previousFreePercent: previous },
    ).catch((err) => this.error('Space trigger failed:', err.message));
  }

  async _syncInfoSettings(dataset) {
    const next = {
      info_pool: dataset.pool || '-',
      info_mountpoint: dataset.mountpoint || '-',
      info_encrypted: dataset.encrypted ? 'yes' : 'no',
    };
    const changed = {};
    for (const [key, value] of Object.entries(next)) {
      if (this.getSetting(key) !== value) changed[key] = value;
    }
    if (Object.keys(changed).length) await this.setSettings(changed).catch(() => {});
  }

  async _applySnapshotButtonVisibility(visible) {
    if (visible && !this.hasCapability('dataset_snapshot_button')) {
      await this.addCapability('dataset_snapshot_button').catch(() => {});
      this._registerSnapshotListener();
    } else if (!visible && this.hasCapability('dataset_snapshot_button')) {
      await this.removeCapability('dataset_snapshot_button').catch(() => {});
    }
  }

  // ---------------------------------------------------------------------------
  // Flow conditions
  // ---------------------------------------------------------------------------

  async isFreeSpaceBelow(percent) {
    const dataset = this._requireDataset();
    if (dataset.usage === null) return false;
    return (100 - dataset.usage) < Number(percent);
  }

  // ---------------------------------------------------------------------------
  // Flow actions
  // ---------------------------------------------------------------------------

  /**
   * Creates a snapshot named `<prefix>-YYYY-MM-DD-HHMMSS`. A timestamp keeps
   * the name unique and sorting chronological, and the prefix keeps it clear
   * of the naming schemas used by periodic snapshot tasks.
   */
  async createSnapshot() {
    const hub = this.requireHub();
    const dataset = this._requireDataset();

    const prefix = String(this.getSetting('snapshot_prefix') || 'homey')
      .replace(/[^a-zA-Z0-9_.-]/g, '') || 'homey';
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').replace(/\..+$/, '')
      .replace(/-(\d{2})-(\d{2})-(\d{2})$/, '-$1$2$3');
    const name = `${prefix}-${stamp}`;

    this.log(`Creating snapshot ${dataset.id}@${name}`);
    await hub.call('pool.snapshot.create', [{
      dataset: dataset.id,
      name,
      recursive: this.getSetting('snapshot_recursive') === true,
    }]);

    return name;
  }

  _requireDataset() {
    this.requireHub();
    if (!this._dataset) throw new Error(this.homey.__('error.not_found'));
    return this._dataset;
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('show_snapshot_button')) {
      await this._applySnapshotButtonVisibility(newSettings.show_snapshot_button === true);
    }
  }

}

module.exports = TrueNasDatasetDevice;
