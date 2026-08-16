'use strict';

const ChildDriver = require('../../lib/ChildDriver');

class TrueNasPoolDriver extends ChildDriver {

  get entityType() {
    return 'pool';
  }

  async buildDeviceList(hub, systemId) {
    return hub.data.pools.map((pool) => this.makeDevice(systemId, pool.name, pool.name, {
      settings: {
        info_pool: pool.name,
        info_status_detail: pool.statusDetail || '-',
      },
    }));
  }

}

module.exports = TrueNasPoolDriver;
