'use strict';

const ChildDriver = require('../../lib/ChildDriver');

class TrueNasDatasetDriver extends ChildDriver {

  get entityType() {
    return 'dataset';
  }

  async buildDeviceList(hub, systemId) {
    return hub.data.datasets
      // Zvols back virtual machine disks and have no meaningful free space.
      .filter((ds) => ds.type !== 'VOLUME')
      .slice()
      .sort((a, b) => String(a.id).localeCompare(String(b.id)))
      .map((ds) => this.makeDevice(systemId, ds.id, ds.id, {
        settings: {
          info_pool: ds.pool || '-',
          info_mountpoint: ds.mountpoint || '-',
          info_encrypted: ds.encrypted ? 'yes' : 'no',
        },
      }));
  }

}

module.exports = TrueNasDatasetDriver;
