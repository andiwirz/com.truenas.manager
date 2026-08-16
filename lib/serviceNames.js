'use strict';

/**
 * TrueNAS service identifiers are terse and historical (`cifs` is SMB). These
 * are the labels the TrueNAS web interface itself uses, so a paired device is
 * recognisable without looking up the identifier.
 */
const SERVICE_NAMES = {
  cifs: 'SMB',
  nfs: 'NFS',
  iscsitarget: 'iSCSI',
  nvmet: 'NVMe-oF',
  ssh: 'SSH',
  ftp: 'FTP',
  tftp: 'TFTP',
  snmp: 'SNMP',
  ups: 'UPS',
  smartd: 'S.M.A.R.T.',
  smart: 'S.M.A.R.T.',
  rsync: 'Rsync',
  s3: 'S3',
  webdav: 'WebDAV',
  netdata: 'Netdata',
  glusterd: 'Gluster',
  openvpn_client: 'OpenVPN Client',
  openvpn_server: 'OpenVPN Server',
  lldp: 'LLDP',
  dynamicdns: 'Dynamic DNS',
  cron: 'Cron',
  docker: 'Docker',
  kubernetes: 'Applications',
  libvirt: 'Virtualization',
  truecommand: 'TrueCommand',
  keepalived: 'Keepalived',
  idmap: 'ID Mapping',
};

function serviceLabel(id) {
  if (!id) return 'Service';
  return SERVICE_NAMES[id] || id.toUpperCase();
}

module.exports = { SERVICE_NAMES, serviceLabel };
