'use strict';

const ChildDriver = require('../../lib/ChildDriver');

class TrueNasAppDriver extends ChildDriver {

  get entityType() {
    return 'app';
  }

  async buildDeviceList(hub, systemId) {
    return hub.data.apps
      .slice()
      .sort((a, b) => String(a.name).localeCompare(String(b.name)))
      .map((app) => this.makeDevice(systemId, app.name, app.name, {
        settings: {
          info_app: app.id || app.name,
          info_latest_version: app.latestVersion || '-',
          info_portal: app.portal || '-',
        },
      }));
  }

}

module.exports = TrueNasAppDriver;
