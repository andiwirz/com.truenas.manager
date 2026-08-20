'use strict';

const ChildDriver = require('../../lib/ChildDriver');

const TYPE_LABEL = {
  cloudsync: 'Cloud Sync',
  replication: 'Replication',
  snapshot: 'Snapshot',
};

class TrueNasTaskDriver extends ChildDriver {

  get entityType() {
    return 'task';
  }

  async buildDeviceList(hub, systemId) {
    return hub.data.tasks
      .slice()
      .sort((a, b) => a.type.localeCompare(b.type) || String(a.name).localeCompare(String(b.name)))
      .map((task) => {
        // The type belongs in the name: a cloudsync and a snapshot task can
        // easily be named after the same dataset.
        const label = `${TYPE_LABEL[task.type] || task.type}: ${task.name}`;
        return this.makeDevice(systemId, task.key, label, {
          settings: {
            info_type: TYPE_LABEL[task.type] || task.type,
            info_target: task.path || '-',
          },
        });
      });
  }

}

module.exports = TrueNasTaskDriver;
