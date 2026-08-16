'use strict';

const ChildDriver = require('../../lib/ChildDriver');
const { serviceLabel } = require('../../lib/serviceNames');

class TrueNasServiceDriver extends ChildDriver {

  get entityType() {
    return 'service';
  }

  async buildDeviceList(hub, systemId) {
    return hub.data.services
      .slice()
      .sort((a, b) => serviceLabel(a.service).localeCompare(serviceLabel(b.service)))
      .map((service) => this.makeDevice(systemId, service.service, serviceLabel(service.service), {
        settings: {
          info_service: service.service,
        },
      }));
  }

}

module.exports = TrueNasServiceDriver;
