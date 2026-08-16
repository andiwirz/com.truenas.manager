'use strict';

const GIB = 1024 ** 3;
const TIB = 1024 ** 4;

/**
 * Reads a nested value using a slash-separated path, e.g. `get(pool, 'scan/state')`.
 * Returns `fallback` for any missing or null link in the chain.
 */
function get(obj, path, fallback = null) {
  if (obj === null || obj === undefined) return fallback;
  let current = obj;
  for (const key of String(path).split('/')) {
    if (current === null || current === undefined) return fallback;
    current = current[key];
  }
  return current === null || current === undefined ? fallback : current;
}

function round(value, digits = 1) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  const factor = 10 ** digits;
  return Math.round(num * factor) / factor;
}

function toGiB(bytes, digits = 1) {
  const num = Number(bytes);
  if (!Number.isFinite(num)) return null;
  return round(num / GIB, digits);
}

function toTiB(bytes, digits = 2) {
  const num = Number(bytes);
  if (!Number.isFinite(num)) return null;
  return round(num / TIB, digits);
}

/**
 * Picks GiB or TiB depending on magnitude, returning `{ value, unit }`.
 * Used for pool and disk sizes, which range from a few GB to hundreds of TB.
 */
function humanBytes(bytes) {
  const num = Number(bytes);
  if (!Number.isFinite(num)) return { value: null, unit: 'GB' };
  if (Math.abs(num) >= TIB) return { value: round(num / TIB, 2), unit: 'TB' };
  return { value: round(num / GIB, 1), unit: 'GB' };
}

function percent(part, total, digits = 1) {
  const p = Number(part);
  const t = Number(total);
  if (!Number.isFinite(p) || !Number.isFinite(t) || t <= 0) return null;
  return round((p / t) * 100, digits);
}

/**
 * Formats an uptime in seconds as a compact `12d 5h 3m` string.
 */
function formatUptime(seconds) {
  const total = Math.floor(Number(seconds));
  if (!Number.isFinite(total) || total < 0) return null;

  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * Strips the `TrueNAS-SCALE-` prefix so the version capability stays readable.
 */
function shortVersion(version) {
  if (!version) return null;
  return String(version)
    .replace(/^TrueNAS-/, '')
    .replace(/^SCALE-/, '');
}

/**
 * Turns an UPPER_SNAKE state into `Title Case` for display capabilities.
 */
function titleCase(value) {
  if (value === null || value === undefined || value === '') return null;
  return String(value)
    .toLowerCase()
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Escapes a string for use inside a Homey device data id.
 */
function slug(value) {
  return String(value).replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
}

module.exports = {
  get,
  round,
  toGiB,
  toTiB,
  humanBytes,
  percent,
  formatUptime,
  shortVersion,
  titleCase,
  slug,
};
