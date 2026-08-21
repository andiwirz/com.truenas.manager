'use strict';

/**
 * Checks that every user-visible string exists in all supported languages.
 *
 * Homey silently falls back to English for a missing translation, so a gap
 * never surfaces as an error — it just quietly ships an English label into a
 * Dutch or German app. This test is the only thing that notices.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LANGS = ['en', 'de', 'nl'];
const LANG_SET = new Set(LANGS);

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures += 1;
    console.log(`  FAIL  ${label}\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
  } else {
    console.log(`  ok    ${label}`);
  }
}

// ---------------------------------------------------------------------------
// Manifest: every i18n object carries every language
// ---------------------------------------------------------------------------
console.log('\nManifest');

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));

function isI18n(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  return keys.length > 0 && keys.every((k) => LANG_SET.has(k)) && keys.includes('en');
}

const strings = [];
(function walk(node, trail) {
  if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${trail}[${i}]`));
  if (!node || typeof node !== 'object') return;
  if (isI18n(node)) return strings.push({ path: trail, value: node });
  for (const [k, v] of Object.entries(node)) walk(v, trail ? `${trail}.${k}` : k);
})(manifest, '');

check('manifest has translatable strings', strings.length > 250, true);

for (const lang of LANGS) {
  const gaps = strings.filter((s) => {
    const v = s.value[lang];
    return v === undefined || v === null || (typeof v === 'string' && !v.trim());
  });
  check(`manifest complete in ${lang} (${strings.length} strings)`,
    gaps.map((g) => g.path).slice(0, 5), []);
}

// Placeholders and Homey's !{{a|b}} switches have to survive translation: an
// argument that no longer resolves breaks the flow card at runtime.
console.log('\nPlaceholders and switches');

const tokenGaps = [];
const switchGaps = [];
for (const s of strings) {
  const en = s.value.en;
  if (typeof en !== 'string') continue;
  const wanted = (en.match(/\[\[[^\]]+\]\]/g) || []).sort();
  const switches = (en.match(/!\{\{[^}]+\}\}/g) || []).length;

  for (const lang of LANGS) {
    const v = s.value[lang];
    if (typeof v !== 'string') continue;
    const got = (v.match(/\[\[[^\]]+\]\]/g) || []).sort();
    if (JSON.stringify(wanted) !== JSON.stringify(got)) {
      tokenGaps.push(`${s.path} [${lang}]`);
    }
    const gotSwitches = (v.match(/!\{\{[^}]+\}\}/g) || []);
    if (gotSwitches.length !== switches) switchGaps.push(`${s.path} [${lang}]`);
    for (const sw of gotSwitches) {
      if (sw.split('|').length !== 2) switchGaps.push(`${s.path} [${lang}] ${sw}`);
    }
  }
}
check('every translation keeps its [[placeholders]]', tokenGaps.slice(0, 5), []);
check('every translation keeps its !{{switches}}', switchGaps.slice(0, 5), []);

// ---------------------------------------------------------------------------
// locales/*.json: same key set in every language
// ---------------------------------------------------------------------------
console.log('\nLocale files');

function flatten(obj, prefix, out) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') flatten(v, key, out);
    else out.add(key);
  }
  return out;
}

const keysets = {};
for (const lang of LANGS) {
  const file = path.join(ROOT, 'locales', `${lang}.json`);
  check(`locales/${lang}.json exists`, fs.existsSync(file), true);
  if (!fs.existsSync(file)) continue;
  keysets[lang] = flatten(JSON.parse(fs.readFileSync(file, 'utf8')), '', new Set());
}

const baseKeys = keysets.en || new Set();
for (const lang of LANGS) {
  if (!keysets[lang]) continue;
  check(`locales/${lang}.json has all ${baseKeys.size} keys`,
    [...baseKeys].filter((k) => !keysets[lang].has(k)), []);
  check(`locales/${lang}.json has no stray keys`,
    [...keysets[lang]].filter((k) => !baseKeys.has(k)), []);
}

// ---------------------------------------------------------------------------
// Store description and changelog
// ---------------------------------------------------------------------------
console.log('\nStore texts');

for (const lang of LANGS) {
  const file = lang === 'en' ? 'readme.txt' : `readme.${lang}.txt`;
  const p = path.join(ROOT, file);
  const ok = fs.existsSync(p) && fs.readFileSync(p, 'utf8').trim().length > 200;
  check(`${file} present and non-trivial`, ok, true);
}

const changelog = JSON.parse(fs.readFileSync(path.join(ROOT, '.homeychangelog.json'), 'utf8'));
for (const [version, entry] of Object.entries(changelog)) {
  check(`changelog ${version} covers ${LANGS.join('/')}`,
    LANGS.filter((l) => !entry[l]), []);
}

// Publishing is refused without an entry for the version being published, and
// forgetting it after a bump is the easy mistake.
check(`changelog has an entry for the current version (${manifest.version})`,
  Boolean(changelog[manifest.version]), true);

// ---------------------------------------------------------------------------
// Hand-written HTML: the settings page and the widget localise themselves
// ---------------------------------------------------------------------------
console.log('\nHTML surfaces');

for (const rel of ['settings/index.html', 'widgets/nas-overview/public/index.html']) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');

  // The TEXT table is evaluated rather than pattern-matched: counting quotes
  // with a regex would miss an apostrophe inside a translation, and Dutch has
  // plenty of those ("VM's").
  const start = src.indexOf('var TEXT = {');
  const end = src.indexOf('\n    };', start);
  check(`${rel}: TEXT table found`, start >= 0 && end > start, true);

  // end points at the newline before '    };', so +6 takes in the brace.
  const literal = src.slice(start + 'var TEXT = '.length, end + 6);
  // eslint-disable-next-line no-new-func
  const table = new Function(`return ${literal}`)();

  const entries = Object.entries(table);
  check(`${rel}: TEXT table is not empty`, entries.length > 5, true);
  check(`${rel}: every TEXT entry has three languages (${entries.length} entries)`,
    entries
      .filter(([, v]) => !Array.isArray(v) || v.length !== LANGS.length
        || v.some((x) => typeof x !== 'string' || !x.length))
      .map(([k, v]) => `${k}:${Array.isArray(v) ? v.length : typeof v}`),
    []);

  check(`${rel}: language switch covers nl`, /indexOf\('nl'\) === 0/.test(src), true);
  check(`${rel}: no leftover two-language switch`, /isGerman/.test(src), false);
}

const settingsSrc = fs.readFileSync(path.join(ROOT, 'settings', 'index.html'), 'utf8');
for (const lang of LANGS) {
  check(`settings help page has a ${lang} section`,
    new RegExp(`^      ${lang}: \\[`, 'm').test(settingsSrc), true);
}

// The badge labels live in their own table, outside TEXT, so they need their
// own check — otherwise a new TrueNAS state could ship English-only.
const stateStart = settingsSrc.indexOf('var STATE_LABELS = {');
const stateEnd = settingsSrc.indexOf('\n    };', stateStart);
check('STATE_LABELS table found', stateStart >= 0 && stateEnd > stateStart, true);

// eslint-disable-next-line no-new-func
const stateLabels = new Function(
  `return ${settingsSrc.slice(stateStart + 'var STATE_LABELS = '.length, stateEnd + 6)}`,
)();
const stateEntries = Object.entries(stateLabels);
check(`STATE_LABELS covers ${LANGS.join('/')} (${stateEntries.length} states)`,
  stateEntries
    .filter(([, v]) => !Array.isArray(v) || v.length !== LANGS.length
      || v.some((x) => typeof x !== 'string' || !x.length))
    .map(([k]) => k),
  []);

console.log(failures === 0 ? '\nAll language checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
