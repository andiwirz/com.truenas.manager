'use strict';

const ChildDriver = require('../../lib/ChildDriver');

class TrueNasDiskDriver extends ChildDriver {

  get entityType() {
    return 'disk';
  }

  async buildDeviceList(hub, systemId) {
    return hub.data.disks.map((disk) => {
      const label = disk.model ? `${disk.model} (${disk.name})` : disk.name;
      return this.makeDevice(systemId, disk.identifier, label, {
        settings: {
          info_device: disk.devname || disk.name || '-',
          info_serial: disk.serial || '-',
          info_type: this._describeType(disk),
        },
      });
    });
  }

  _describeType(disk) {
    if (disk.rotationrate) return `HDD ${disk.rotationrate} rpm`;
    if (disk.type) return disk.type === 'SSD' ? 'SSD' : disk.type;
    return '-';
  }

}

module.exports = TrueNasDiskDriver;
