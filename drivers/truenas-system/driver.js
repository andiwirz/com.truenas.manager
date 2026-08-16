'use strict';

const { Driver } = require('homey');
const { TrueNasClient } = require('../../lib/TrueNasClient');
const { slug, shortVersion } = require('../../lib/util');

class TrueNasSystemDriver extends Driver {

  async onInit() {
    this.log('TrueNAS system driver initialized');
  }

  async onPair(session) {
    session.setHandler('connect', async (input) => {
      const host = String(input.host || '').trim();
      const port = parseInt(input.port, 10);
      const apiKey = String(input.apiKey || '').trim();
      const useSsl = input.useSsl !== false;
      const ignoreCert = input.ignoreCert !== false;

      if (!host) throw new Error(this.homey.__('pair.err_host_required'));
      if (!port || port < 1 || port > 65535) throw new Error(this.homey.__('pair.err_port_invalid'));
      if (!apiKey) throw new Error(this.homey.__('pair.err_key_required'));

      const client = new TrueNasClient({
        host,
        port,
        useSsl,
        apiKey,
        rejectUnauthorized: !ignoreCert,
        log: (...args) => this.log(...args),
        error: (...args) => this.error(...args),
      });

      try {
        await client.connect();

        const info = await client.call('system.info');
        const hostname = (info && info.hostname) || host;
        const version = shortVersion(info && info.version);

        // A stable identifier that survives IP changes. Falls back to the
        // serial and finally to host:port on systems that do not expose it.
        let systemId = null;
        try {
          systemId = await client.call('system.host_id');
        } catch (_err) {
          systemId = null;
        }
        if (!systemId && info && info.system_serial) systemId = info.system_serial;
        if (!systemId) systemId = `${host}-${port}`;

        this.log(`Paired with ${hostname} (${version}) as ${slug(String(systemId))}`);

        return {
          name: hostname,
          data: {
            id: `truenas-${slug(String(systemId))}`,
          },
          settings: {
            host,
            port,
            use_ssl: useSsl,
            ignore_cert: ignoreCert,
            api_key: apiKey,
            poll_interval: 60,
            disk_poll_interval: 300,
            alarm_level: 'ERROR',
            info_hostname: hostname,
            info_version: version || '-',
            info_product: [info && info.system_manufacturer, info && info.system_product]
              .filter(Boolean).join(' ') || '-',
            info_serial: (info && info.system_serial) || '-',
          },
        };
      } catch (err) {
        const message = err.i18n ? this.homey.__(err.i18n) : err.message;
        this.error('Pairing failed:', err.message);
        throw new Error(message);
      } finally {
        client.disconnect();
      }
    });
  }

}

module.exports = TrueNasSystemDriver;
