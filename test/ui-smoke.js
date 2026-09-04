'use strict';

/**
 * Frontend smoke test.
 *
 * Loads the real index.html plus every page script into jsdom, points it at a
 * live server backed by a throwaway database, then signs in as each role and
 * renders every page that role can reach. Any thrown error, unhandled rejection
 * or console error fails the run.
 *
 *   npm run test:ui
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kitchops-ui-')), 'ui.db');
process.env.KITCHOPS_DB = DB;
process.env.KITCHOPS_JWT_SECRET = 'ui-smoke-secret';
process.env.KITCHOPS_ADMIN_USER = 'uiadmin';
process.env.KITCHOPS_ADMIN_PASS = 'uiadmin123';

const { migrate } = require('../server/db/migrate');
const { seed } = require('../server/db/seed-sample');
const { createApp } = require('../server/index');

const PUBLIC = path.join(__dirname, '..', 'public');
let passed = 0;
let failed = 0;
const failures = [];

function record(name, err) {
  if (err) {
    failed++;
    failures.push(`${name}: ${err}`);
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${err}`);
  } else {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  }
}

/** Boots a jsdom window with the app loaded and signed in as `username`. */
async function bootSession(baseUrl, username, password) {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  const errors = [];

  const dom = new JSDOM(html, {
    url: baseUrl + '/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;

  window.addEventListener('error', (e) => errors.push(`window error: ${e.message}`));
  window.onunhandledrejection = (e) => errors.push(`unhandled rejection: ${e.reason}`);
  window.console.error = (...a) => errors.push(`console.error: ${a.join(' ')}`);

  // jsdom has no fetch; forward to the live server and carry the session cookie.
  let cookie = null;
  window.fetch = async (url, opts = {}) => {
    const full = url.startsWith('http') ? url : baseUrl + url;
    const headers = { ...(opts.headers || {}) };
    if (cookie) headers.cookie = cookie;
    const res = await fetch(full, { ...opts, headers });
    for (const c of (res.headers.getSetCookie?.() || [])) {
      if (c.startsWith('kitchops_token=')) cookie = c.split(';')[0];
    }
    const text = await res.text();
    return {
      ok: res.ok, status: res.status,
      text: async () => text,
      json: async () => JSON.parse(text),
    };
  };

  // Load the scripts in the same order as index.html.
  const files = [
    'js/theme.js', 'js/api.js', 'js/ui.js',
    'js/pages/dashboard.js', 'js/pages/users.js', 'js/pages/stations.js',
    'js/pages/locations.js', 'js/pages/recipes.js', 'js/pages/counter.js',
    'js/pages/masters.js', 'js/pages/mytasks.js', 'js/app.js',
  ];
  for (const f of files) {
    window.eval(fs.readFileSync(path.join(PUBLIC, f), 'utf8'));
  }

  await window.App.init();
  // App.init() attempts /api/auth/me first; sign in explicitly.
  const { user } = await window.API.post('/api/auth/login', { username, password });
  await window.App.refreshMeta();
  window.App.state.user = user;

  return { window, errors };
}

async function renderPage(window, pageId) {
  window.location.hash = pageId;
  await window.App.route();
  // Let any in-flight microtasks settle.
  await new Promise((r) => setTimeout(r, 30));
  return window.document.getElementById('content').innerHTML;
}

/**
 * Theme checks that need the CSS itself, not just the DOM: every colour token
 * must be defined in both palettes, and Machine/Manual must stay blue/orange.
 */
async function themeChecks(baseUrl) {
  console.log('\n\x1b[1mAppearance (light / dark / system)\x1b[0m');
  const css = fs.readFileSync(path.join(PUBLIC, 'css', 'app.css'), 'utf8');

  const block = (selector) => {
    const at = css.indexOf(selector);
    if (at === -1) return null;
    return css.slice(at, css.indexOf('}', at));
  };
  const tokensIn = (text) => new Set([...text.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));

  try {
    const light = tokensIn(block(':root {'));
    const dark = tokensIn(block(':root[data-theme="dark"] {'));
    // --radius/--shadow/--font are structural and may legitimately not be re-declared.
    const structural = new Set(['--radius', '--font', '--shadow', '--shadow-lg']);
    const missing = [...light].filter((t) => !dark.has(t) && !structural.has(t));
    if (missing.length) throw new Error(`dark palette is missing: ${missing.join(', ')}`);
    if (dark.size < 30) throw new Error(`dark palette looks too small (${dark.size} tokens)`);
    record(`dark palette redefines every colour token (${dark.size})`, null);
  } catch (err) {
    record('dark palette redefines every colour token', err.message);
  }

  try {
    // A component that hard-codes a hex instead of a token would not theme.
    const offenders = [];
    for (const rule of ['.card {', '.btn {', 'table.data th {', '.nav-item {', '.modal {']) {
      const b = block(rule);
      if (b && /(background|color|border)[^;]*#[0-9a-f]{3,8}/i.test(b)) offenders.push(rule);
    }
    if (offenders.length) throw new Error(`hardcoded colours in: ${offenders.join(', ')}`);
    record('core components use tokens, not literal colours', null);
  } catch (err) {
    record('core components use tokens, not literal colours', err.message);
  }

  try {
    // v10.2 Rule 5 must survive the theme swap: blue stays blue, orange orange.
    const hueOf = (hex) => {
      const n = parseInt(hex.slice(1), 16);
      const r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
      if (!d) return 0;
      let h;
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      return (h * 60 + 360) % 360;
    };
    const grab = (text, token) => text.match(new RegExp(token + ':\\s*(#[0-9a-fA-F]{6})'))[1];
    for (const [name, selector] of [['light', ':root {'], ['dark', ':root[data-theme="dark"] {']]) {
      const b = block(selector);
      const machine = hueOf(grab(b, '--machine'));
      const manual = hueOf(grab(b, '--manual'));
      if (machine < 200 || machine > 250) throw new Error(`${name}: --machine is not blue (hue ${machine.toFixed(0)})`);
      if (manual < 15 || manual > 45) throw new Error(`${name}: --manual is not orange (hue ${manual.toFixed(0)})`);
    }
    record('MACHINE stays blue and MANUAL stays orange in both themes', null);
  } catch (err) {
    record('MACHINE stays blue and MANUAL stays orange in both themes', err.message);
  }

  try {
    // Readability is not optional in a kitchen. Every text/background pairing
    // must clear WCAG AA (4.5:1) in BOTH themes.
    const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    const lum = (hex) => {
      const n = parseInt(hex.slice(1), 16);
      return 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
    };
    const ratio = (a, b) => {
      const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
      return (x + 0.05) / (y + 0.05);
    };
    const grab = (text, token) => {
      const m = text.match(new RegExp(token + ':\\s*(#[0-9a-fA-F]{6})'));
      if (!m) throw new Error(`token ${token} missing`);
      return m[1];
    };
    const PAIRS = [
      ['body text on page', '--ink', '--bg'],
      ['body text on card', '--ink', '--surface'],
      ['secondary text', '--ink-2', '--surface'],
      ['muted hint text', '--ink-3', '--surface'],
      ['MACHINE badge', '--machine', '--machine-bg'],
      ['MANUAL badge', '--manual', '--manual-bg'],
      ['text on a MACHINE row', '--ink', '--machine-bg'],
      ['text on a MANUAL row', '--ink', '--manual-bg'],
      ['primary button label', '--brand-ink', '--brand'],
      ['active nav item', '--brand-text', '--brand-soft'],
      ['danger note', '--danger', '--danger-bg'],
      ['warn note', '--warn', '--warn-bg'],
      ['ok note', '--ok', '--ok-bg'],
      ['info note', '--info', '--info-bg'],
      ['table header text', '--ink-2', '--surface-2'],
    ];
    const bad = [];
    let worst = 99;
    for (const [theme, selector] of [['light', ':root {'], ['dark', ':root[data-theme="dark"] {']]) {
      const b = block(selector);
      for (const [label, fg, bg] of PAIRS) {
        const r = ratio(grab(b, fg), grab(b, bg));
        worst = Math.min(worst, r);
        if (r < 4.5) bad.push(`${theme}/${label} ${r.toFixed(2)}:1`);
      }
    }
    if (bad.length) throw new Error(`below AA 4.5:1 — ${bad.join(', ')}`);
    record(`all text pairs clear WCAG AA in both themes (worst ${worst.toFixed(2)}:1)`, null);
  } catch (err) {
    record('all text pairs clear WCAG AA in both themes', err.message);
  }

  try {
    // A placeholder must never read as an already-entered value. Bare examples
    // like placeholder="79" get mistaken for real input, so an example has to be
    // prefixed "e.g." and the CSS has to mute placeholders away from body text.
    const offenders = [];
    for (const file of fs.readdirSync(path.join(PUBLIC, 'js', 'pages'))) {
      const src = fs.readFileSync(path.join(PUBLIC, 'js', 'pages', file), 'utf8');
      for (const m of src.matchAll(/placeholder="([^"$]*)"/g)) {
        const text = m[1].trim();
        if (!text) continue;
        const looksLikeAValue = /^[\d.,%-]+$/.test(text) || text.length <= 3;
        if (looksLikeAValue && !/^e\.g\./i.test(text)) offenders.push(`${file}: "${text}"`);
      }
    }
    if (offenders.length) throw new Error(`bare-value placeholders — ${offenders.join(', ')}`);

    const ph = block('input::placeholder, textarea::placeholder {');
    if (!ph) throw new Error('placeholders have no explicit styling, so browsers render them like real text');
    if (!ph.includes('var(--ink-3)')) throw new Error('placeholder colour is not muted to --ink-3');
    if (!/opacity:\s*1/.test(ph)) throw new Error('placeholder opacity not pinned (Firefox dims it differently)');
    record('placeholders read as hints, not as entered values', null);
  } catch (err) {
    record('placeholders read as hints, not as entered values', err.message);
  }

  try {
    // "System" must not stamp data-theme, or it would stop following the OS.
    const dom = new JSDOM('<!doctype html><html><body></body></html>',
      { url: baseUrl + '/', runScripts: 'outside-only' });
    dom.window.eval(fs.readFileSync(path.join(PUBLIC, 'js', 'theme.js'), 'utf8'));
    const T = dom.window.Theme;
    T.init();
    T.set('dark');
    if (dom.window.document.documentElement.getAttribute('data-theme') !== 'dark') throw new Error('dark not applied');
    T.set('light');
    if (dom.window.document.documentElement.getAttribute('data-theme') !== 'light') throw new Error('light not applied');
    T.set('system');
    if (dom.window.document.documentElement.hasAttribute('data-theme')) {
      throw new Error('system left data-theme set, so it cannot follow the OS');
    }
    if (T.get() !== 'system') throw new Error('mode not persisted');
    // The choice survives a reload.
    const dom2 = new JSDOM('<!doctype html><html><body></body></html>',
      { url: baseUrl + '/', runScripts: 'outside-only' });
    dom2.window.localStorage.setItem('kitchops.theme', 'dark');
    dom2.window.eval(fs.readFileSync(path.join(PUBLIC, 'js', 'theme.js'), 'utf8'));
    dom2.window.Theme.init();
    if (dom2.window.document.documentElement.getAttribute('data-theme') !== 'dark') {
      throw new Error('stored choice not restored on load');
    }
    record('light / dark / system persist, and system follows the OS', null);
  } catch (err) {
    record('light / dark / system persist, and system follows the OS', err.message);
  }
}

async function main() {
  migrate({ silent: true });
  seed();

  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const roles = [
    { label: 'Super Admin', user: 'uiadmin', pass: 'uiadmin123',
      pages: ['dashboard', 'counter', 'recipes', 'stations', 'locations', 'masters', 'users', 'settings'] },
    { label: 'Prep Kitchen Admin', user: 'sample.admin', pass: 'sample123',
      pages: ['dashboard', 'counter', 'recipes', 'stations', 'locations', 'masters', 'users'] },
    { label: 'Location Manager', user: 'sample.manager', pass: 'sample123', pages: [] },
    { label: 'Counter Person', user: 'sample.counter1', pass: 'sample123', pages: ['mytasks'] },
  ];

  for (const role of roles) {
    console.log(`\n\x1b[1m${role.label}\x1b[0m`);
    let session;
    try {
      session = await bootSession(baseUrl, role.user, role.pass);
      record(`sign in and load the app shell`, null);
    } catch (err) {
      record(`sign in and load the app shell`, err.message);
      continue;
    }
    const { window, errors } = session;

    // The navigation must only offer pages this role is allowed to open.
    try {
      window.App.route();
      const navIds = Array.from(window.document.querySelectorAll('.nav-item')).map((b) => b.dataset.page);
      const unexpected = navIds.filter((id) => !role.pages.includes(id));
      const missing = role.pages.filter((id) => !navIds.includes(id));
      if (unexpected.length || missing.length) {
        throw new Error(`nav mismatch — unexpected: [${unexpected}], missing: [${missing}]`);
      }
      record(`navigation offers exactly ${role.pages.length} permitted page(s)`, null);
    } catch (err) {
      record('navigation offers the permitted pages', err.message);
    }

    for (const page of role.pages) {
      try {
        const html = await renderPage(window, page);
        if (!html || html.length < 80) throw new Error(`rendered almost nothing (${html.length} chars)`);
        if (/Could not load this page/.test(html)) {
          throw new Error(html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200));
        }
        if (html.includes('undefined</')) throw new Error('rendered a literal "undefined" value');
        record(`renders #${page} (${html.length} chars)`, null);
      } catch (err) {
        record(`renders #${page}`, err.message);
      }
    }

    if (errors.length) {
      record(`no runtime errors while rendering`, errors.slice(0, 3).join(' | '));
    } else {
      record('no runtime errors while rendering', null);
    }

    // Every role gets the appearance toggle, including counter staff who cannot
    // open System Settings.
    try {
      const btn = window.document.getElementById('themeBtn');
      if (!btn) throw new Error('no theme toggle in the topbar');
      const before = window.Theme.resolved();
      btn.click();
      const after = window.Theme.resolved();
      if (before === after) throw new Error(`toggle did not switch (stayed ${before})`);
      if (window.document.documentElement.getAttribute('data-theme') !== after) {
        throw new Error('data-theme was not applied to the document');
      }
      btn.click();
      if (window.Theme.resolved() !== before) throw new Error('toggling back did not restore');
      record('appearance toggle switches and restores', null);
    } catch (err) {
      record('appearance toggle switches and restores', err.message);
    }

    window.close();
  }

  await themeChecks(baseUrl);

  server.close();

  console.log(`\n${'─'.repeat(64)}`);
  console.log(`  \x1b[32m${passed} passed\x1b[0m${failed ? `, \x1b[31m${failed} failed\x1b[0m` : ''}`);
  if (failed) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log(`  • ${f}`));
  }
  console.log(`${'─'.repeat(64)}\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('\nUI smoke harness crashed:', err);
  process.exit(1);
});
