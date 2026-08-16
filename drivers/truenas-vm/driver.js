'use strict';

const ChildDriver = require('../../lib/ChildDriver');

class TrueNasVmDriver extends ChildDriver {

  get entityType() {
    return 'vm';
  }

  async buildDeviceList(hub, systemId) {
    return hub.data.vms
      .slice()
      .sort((a, b) => String(a.name).localeCompare(String(b.name)))
      .map((vm) => this.makeDevice(systemId, vm.id, vm.name, {
        settings: {
          info_vcpus: vm.vcpus ? String(vm.vcpus) : '-',
        },
      }));
  }

}

module.exports = TrueNasVmDriver;
