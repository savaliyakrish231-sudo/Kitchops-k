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
    'js/pages/dashboard.js', 'js/pages/users.js', 'js/pages/credentials.js', 'js/pages/account.js',
    'js/pages/stations.js',
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
    // Only COLOUR tokens need a dark counterpart. Layout and typography tokens
    // (--tap, --safe-*, --radius, --font) are the same in both themes, so the
    // check keys off each token's VALUE rather than a hand-kept exclusion list.
    const colourTokens = (text) => {
      const found = new Map();
      for (const m of text.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
        const value = m[2].trim();
        if (/^#[0-9a-f]{3,8}$/i.test(value) || /^(rgb|hsl)a?\(/i.test(value)) found.set(m[1], value);
      }
      return found;
    };
    const light = colourTokens(block(':root {'));
    const dark = colourTokens(block(':root[data-theme="dark"] {'));
    const missing = [...light.keys()].filter((t) => !dark.has(t));
    if (missing.length) throw new Error(`dark palette is missing: ${missing.join(', ')}`);
    if (dark.size < 30) throw new Error(`dark palette looks too small (${dark.size} colours)`);

    // A dark token that is byte-identical to light usually means it was copied
    // and never adjusted. Backgrounds and text must actually differ.
    const identical = [...light.entries()]
      .filter(([t, v]) => dark.get(t) === v && /(--ink|--bg|--surface|--line)/.test(t))
      .map(([t]) => t);
    if (identical.length) throw new Error(`unchanged in dark: ${identical.join(', ')}`);
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
    // Regression guard: a theme change must never wipe the page being used.
    // A global re-route on theme change previously replaced the content with a
    // spinner mid-click, destroying the control the user had just pressed.
    const app = fs.readFileSync(path.join(PUBLIC, 'js', 'app.js'), 'utf8');
    const reroutes = [...app.matchAll(/Theme\.onChange\(([\s\S]{0,240}?)\)\s*;/g)]
      .filter((m) => /\broute\s*\(/.test(m[1]));
    if (reroutes.length) {
      throw new Error('app.js re-routes on theme change, which blanks the current page');
    }
    record('changing the theme does not blank the current page', null);
  } catch (err) {
    record('changing the theme does not blank the current page', err.message);
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

/**
 * The shell must PARSE to a usable document. An unterminated HTML comment
 * silently swallows every element and <script> after it, which renders a blank
 * page with no console error — the failure this guards against.
 */
function shellChecks() {
  console.log('\n\x1b[1mApp shell (index.html)\x1b[0m');
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

  try {
    const doc = new JSDOM(html).window.document;
    const required = ['loginView', 'loginForm', 'loginError', 'appView', 'navToggle',
      'sidebar', 'content', 'toastHost', 'modalHost'];
    const missing = required.filter((id) => !doc.getElementById(id));
    if (missing.length) {
      throw new Error(`missing after parsing: #${missing.join(', #')} `
        + '— usually an unterminated <!-- comment --> swallowing the rest of the page');
    }
    record(`all ${required.length} shell elements survive parsing`, null);
  } catch (err) {
    record('all shell elements survive parsing', err.message);
  }

  try {
    const doc = new JSDOM(html).window.document;
    const parsed = [...doc.querySelectorAll('script[src]')].map((t) => t.getAttribute('src'));
    // Count the raw tags too: if parsing drops some, they were inside a comment.
    const raw = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
    if (parsed.length !== raw.length) {
      throw new Error(`${raw.length} script tags written but only ${parsed.length} parse `
        + `— dropped: ${raw.filter((r) => !parsed.includes(r)).join(', ')}`);
    }
    const onDisk = parsed.filter((src) => !fs.existsSync(path.join(PUBLIC, src.replace(/^\//, ''))));
    if (onDisk.length) throw new Error(`script files missing: ${onDisk.join(', ')}`);
    record(`all ${parsed.length} scripts parse and exist on disk`, null);
  } catch (err) {
    record('all scripts parse and exist on disk', err.message);
  }

  try {
    // Every HTML comment must be closed.
    const opens = (html.match(/<!--/g) || []).length;
    const closes = (html.match(/-->/g) || []).length;
    if (opens !== closes) throw new Error(`${opens} "<!--" but ${closes} "-->" — a comment is unterminated`);
    record('every HTML comment is closed', null);
  } catch (err) {
    record('every HTML comment is closed', err.message);
  }
}


/**
 * MOBILE-FIRST checks (v10.2 Rule 7 — counter staff use a phone browser).
 *
 * jsdom has no layout engine, so this cannot measure rendered pixels. It
 * verifies the things that actually cause mobile failures and ARE checkable:
 * the declared rules, the breakpoint direction, and the per-cell labels the
 * card layout depends on. Real device testing is still needed for feel.
 */
function mobileChecks() {
  console.log('\n\x1b[1mMobile-first\x1b[0m');
  const css = fs.readFileSync(path.join(PUBLIC, 'css', 'app.css'), 'utf8');
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  // Match a selector only at the START of a line, so looking up ".btn {" cannot
  // land inside ".page-actions .btn {" and read the wrong rule.
  const rule = (selector) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = css.match(new RegExp('^' + escaped, 'm'));
    return m ? css.slice(m.index, css.indexOf('}', m.index)) : null;
  };

  try {
    const meta = html.match(/<meta name="viewport" content="([^"]+)"/);
    if (!meta) throw new Error('no viewport meta tag');
    const content = meta[1];
    if (!/width=device-width/.test(content)) throw new Error('viewport lacks width=device-width');
    if (!/initial-scale=1/.test(content)) throw new Error('viewport lacks initial-scale=1');
    if (/user-scalable=no|maximum-scale=1/.test(content)) {
      throw new Error('viewport blocks zoom — pinch-zoom must stay available');
    }
    if (!/viewport-fit=cover/.test(content)) throw new Error('viewport lacks viewport-fit=cover for the notch');
    record('viewport is mobile-correct and still allows pinch-zoom', null);
  } catch (err) {
    record('viewport is mobile-correct and still allows pinch-zoom', err.message);
  }

  try {
    // Below 16px, iOS Safari zooms the page every time a field is focused.
    const inputs = rule('input[type=text], input[type=password]');
    if (!inputs) throw new Error('base input rule not found');
    const size = inputs.match(/font-size:\s*(\d+(?:\.\d+)?)px/);
    if (!size) throw new Error('base input rule sets no font-size');
    if (Number(size[1]) < 16) {
      throw new Error(`base input font-size is ${size[1]}px — iOS zooms the page below 16px`);
    }
    record(`form controls are ${size[1]}px on phones, so iOS does not zoom`, null);
  } catch (err) {
    record('form controls are 16px on phones, so iOS does not zoom', err.message);
  }

  try {
    // Apple asks 44px, Android 48px. --tap must be at least 44 and actually used.
    const root = rule(':root {');
    const tap = root.match(/--tap:\s*(\d+)px/);
    if (!tap) throw new Error('no --tap token');
    if (Number(tap[1]) < 44) throw new Error(`--tap is ${tap[1]}px, below the 44px minimum`);

    for (const sel of ['.btn {', '.nav-item {', '.icon-btn {']) {
      const r = rule(sel);
      if (!r) throw new Error(`${sel} not found`);
      if (!/min-(height|width):\s*var\(--tap\)/.test(r)) {
        throw new Error(`${sel} does not adopt the --tap minimum`);
      }
    }
    // The small variant must shrink text, never the tap area, on a phone.
    const sm = rule('.btn-sm {');
    if (/min-height/.test(sm)) throw new Error('.btn-sm overrides the phone tap minimum');
    record(`interactive targets are at least ${tap[1]}px on phones`, null);
  } catch (err) {
    record('interactive targets are at least 44px on phones', err.message);
  }

  try {
    // Mobile-first means the base styles are the phone and min-width queries add
    // to them — not max-width queries taking desktop away.
    const queries = [...css.matchAll(/@media\s*\(([^)]+)\)/g)].map((m) => m[1].trim());
    const widthQueries = queries.filter((q) => /width/.test(q));
    const maxWidth = widthQueries.filter((q) => /max-width/.test(q));
    if (!widthQueries.length) throw new Error('no responsive breakpoints at all');
    if (maxWidth.length) throw new Error(`desktop-first max-width queries remain: ${maxWidth.join(', ')}`);
    const minWidths = widthQueries.map((q) => Number(q.match(/(\d+)px/)[1])).sort((a, b) => a - b);
    record(`mobile-first: base is the phone, enhanced at ${minWidths.join('px, ')}px`, null);
  } catch (err) {
    record('mobile-first: base is the phone, enhanced upward', err.message);
  }

  try {
    // A 13-column table is unreadable at 360px, so rows become cards. That
    // depends on every cell carrying its column name.
    const uiSrc = fs.readFileSync(path.join(PUBLIC, 'js', 'ui.js'), 'utf8');
    if (!/data-label="\$\{esc\(c\.label/.test(uiSrc)) {
      throw new Error('UI.table does not write data-label on cells');
    }
    if (!/td::before/.test(css) || !/content:\s*attr\(data-label\)/.test(css)) {
      throw new Error('CSS does not surface data-label as the card row label');
    }
    // And the real table must come back when there is room.
    const wide = css.slice(css.indexOf('@media (min-width: 900px)'));
    if (!/table\.data\s*\{[^}]*display:\s*table/.test(wide)) {
      throw new Error('the real table is never restored on wide screens');
    }
    record('wide tables collapse to labelled cards on phones', null);
  } catch (err) {
    record('wide tables collapse to labelled cards on phones', err.message);
  }

  try {
    // The notch and home indicator must be padded around, not painted under.
    for (const token of ['--safe-t', '--safe-b']) {
      if (!css.includes(token + ': env(safe-area-inset')) throw new Error(`${token} is not an env() inset`);
    }
    for (const sel of ['.content {', '.topbar {', '.toast-host {']) {
      const r = rule(sel);
      if (!/var\(--safe-/.test(r)) throw new Error(`${sel} ignores the safe-area insets`);
    }
    record('layout respects iPhone notch and home-indicator insets', null);
  } catch (err) {
    record('layout respects iPhone notch and home-indicator insets', err.message);
  }

  try {
    // A drawer with no way back is a trap on a phone.
    if (!/id="navBackdrop"/.test(html)) throw new Error('no backdrop element to tap');
    const app = fs.readFileSync(path.join(PUBLIC, 'js', 'app.js'), 'utf8');
    for (const [needle, what] of [
      ["getElementById('navBackdrop').onclick", 'tapping the backdrop closes it'],
      ["e.key !== 'Escape'", 'Escape closes it'],
      ["matchMedia('(min-width: 900px)')", 'resizing past the breakpoint releases it'],
      ['nav-open', 'the page behind is scroll-locked'],
    ]) {
      if (!app.includes(needle)) throw new Error(`drawer: ${what} — missing`);
    }
    record('nav drawer closes by backdrop, Escape, navigation and resize', null);
  } catch (err) {
    record('nav drawer closes by backdrop, Escape, navigation and resize', err.message);
  }

  try {
    // Horizontal page scroll is the classic mobile-layout smell.
    const body = rule('body {');
    if (!/overflow-x:\s*hidden/.test(body)) throw new Error('body allows horizontal scrolling');
    record('the page itself never scrolls sideways', null);
  } catch (err) {
    record('the page itself never scrolls sideways', err.message);
  }
}


/**
 * Interaction feel: a tap must be acknowledged, and a dialog must be
 * dismissable the ways people instinctively try.
 */
async function interactionChecks(session) {
  console.log('\n\x1b[1mInteraction\x1b[0m');
  const { window } = session;
  const { UI } = window;
  const host = window.document.getElementById('modalHost');
  const settle = (ms = 320) => new Promise((r) => setTimeout(r, ms));

  try {
    UI.modal({ title: 'Escape test', body: '<p>x</p>', submitLabel: 'Go', onSubmit: () => true });
    if (host.hidden) throw new Error('modal did not open');
    window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
    await settle();
    if (!host.hidden) throw new Error('Escape did not close the dialog');
    record('a dialog closes on Escape', null);
  } catch (err) {
    record('a dialog closes on Escape', err.message);
  }

  try {
    UI.modal({ title: 'Backdrop test', body: '<p>x</p>', submitLabel: 'Go', onSubmit: () => true });
    // A click on the dimmed area itself, not on the dialog.
    host.onclick({ target: host });
    await settle();
    if (!host.hidden) throw new Error('tapping outside did not close the dialog');
    record('a dialog closes when you tap outside it', null);
  } catch (err) {
    record('a dialog closes when you tap outside it', err.message);
  }

  try {
    // A click INSIDE the dialog must not dismiss it.
    UI.modal({ title: 'Inside test', body: '<p>x</p>', submitLabel: 'Go', onSubmit: () => true });
    const dialog = host.querySelector('.modal');
    host.onclick({ target: dialog });
    await settle(120);
    if (host.hidden) throw new Error('clicking inside the dialog closed it');
    host.querySelector('[data-role=cancel]').click();
    await settle();
    record('clicking inside a dialog does not dismiss it', null);
  } catch (err) {
    record('clicking inside a dialog does not dismiss it', err.message);
  }

  try {
    // An async handler should mark its button busy until it settles.
    const btn = window.document.createElement('button');
    btn.className = 'btn';
    let release;
    btn.onclick = () => new Promise((r) => { release = r; });
    window.document.body.appendChild(btn);
    UI.enhanceButtons(window.document.body);

    btn.onclick(new window.Event('click'));
    await settle(20);
    if (!btn.classList.contains('is-busy')) throw new Error('button was not marked busy');
    if (!btn.disabled) throw new Error('button stayed clickable while working');
    release();
    await settle(30);
    if (btn.classList.contains('is-busy')) throw new Error('busy state was not cleared');
    if (btn.disabled) throw new Error('button stayed disabled after finishing');
    btn.remove();
    record('an async button shows a spinner and blocks double taps', null);
  } catch (err) {
    record('an async button shows a spinner and blocks double taps', err.message);
  }

  try {
    // A synchronous handler must not be disabled — that would break the theme
    // buttons and every plain toggle.
    const btn = window.document.createElement('button');
    btn.className = 'btn';
    let ran = 0;
    btn.onclick = () => { ran++; };
    window.document.body.appendChild(btn);
    UI.enhanceButtons(window.document.body);
    btn.onclick(new window.Event('click'));
    if (btn.classList.contains('is-busy') || btn.disabled) {
      throw new Error('a synchronous handler was treated as pending');
    }
    if (ran !== 1) throw new Error('the original handler did not run');
    btn.remove();
    record('a synchronous button is left alone', null);
  } catch (err) {
    record('a synchronous button is left alone', err.message);
  }

  try {
    // The slow-load placeholder must be a skeleton, not a bare word.
    const html = UI.skeleton(2);
    if (!/skeleton/.test(html) || (html.match(/class="line/g) || []).length < 4) {
      throw new Error('skeleton does not mirror the page shape');
    }
    record('a slow load shows a shaped skeleton, not "Loading…"', null);
  } catch (err) {
    record('a slow load shows a shaped skeleton, not "Loading…"', err.message);
  }
}

async function main() {
  migrate({ silent: true });
  seed();

  // Before anything else: a shell that cannot parse makes every later check a
  // misleading downstream error.
  shellChecks();
  mobileChecks();

  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const roles = [
    { label: 'Super Admin', user: 'uiadmin', pass: 'uiadmin123',
      pages: ['dashboard', 'counter', 'recipes', 'stations', 'locations', 'masters', 'users', 'credentials', 'settings', 'account'] },
    { label: 'Prep Kitchen Admin', user: 'sample.admin', pass: 'sample123',
      pages: ['dashboard', 'counter', 'recipes', 'stations', 'locations', 'masters', 'users', 'account'] },
    { label: 'Location Manager', user: 'sample.manager', pass: 'sample123', pages: ['account'] },
    { label: 'Counter Person', user: 'sample.counter1', pass: 'sample123', pages: ['mytasks', 'account'] },
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
      const navIds = Array.from(window.document.querySelectorAll('.nav-item[data-page]')).map((b) => b.dataset.page);
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

        // Double-escaping shows up as a visible "&amp;" / "&lt;" in the TEXT the
        // user reads (e.g. a station called "Pasta & Sauce" rendering as
        // "Pasta &amp; Sauce"). Helpers that escape their own arguments make
        // this easy to reintroduce, so check the rendered text, not the source.
        const text = window.document.getElementById('content').textContent;
        const doubled = ['&amp;', '&lt;', '&gt;', '&quot;', '&#39;'].filter((e) => text.includes(e));
        if (doubled.length) {
          const near = text.slice(Math.max(0, text.indexOf(doubled[0]) - 40),
            text.indexOf(doubled[0]) + 40).replace(/\s+/g, ' ').trim();
          throw new Error(`double-escaped ${doubled.join(', ')} visible to the user — "…${near}…"`);
        }
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
      await renderPage(window, 'account');
      const picker = window.document.querySelectorAll('#accountTheme button');
      if (picker.length !== 3) throw new Error(`expected 3 appearance options, got ${picker.length}`);
      const modes = Array.from(picker).map((b) => b.dataset.mode);
      for (const m of ['light', 'dark', 'system']) {
        if (!modes.includes(m)) throw new Error(`missing appearance option "${m}"`);
      }
      const before = window.Theme.resolved();
      const other = before === 'dark' ? 'light' : 'dark';
      window.document.querySelector(`#accountTheme button[data-mode="${other}"]`).click();
      if (window.Theme.resolved() !== other) throw new Error('appearance did not switch');
      if (window.document.documentElement.getAttribute('data-theme') !== other) {
        throw new Error('data-theme was not applied to the document');
      }
      // The pressed state must follow the choice.
      const pressed = window.document.querySelector('#accountTheme button[aria-pressed="true"]');
      if (!pressed || pressed.dataset.mode !== other) throw new Error('pressed state did not update');
      window.document.querySelector(`#accountTheme button[data-mode="${before}"]`).click();
      if (window.Theme.resolved() !== before) throw new Error('switching back did not restore');
      record('appearance picker on the Account page switches and restores', null);
    } catch (err) {
      record('appearance picker on the Account page switches and restores', err.message);
    }

    try {
      await renderPage(window, 'account');
      const btn = window.document.getElementById('accountSignOut');
      if (!btn) throw new Error('no sign-out button on the Account page');

      // Clicking must NOT sign out on its own — it must raise a confirmation.
      btn.click();
      await new Promise((r) => setTimeout(r, 20));
      const host = window.document.getElementById('modalHost');
      if (host.hidden) throw new Error('sign-out happened with no confirmation');
      const text = host.textContent;
      if (!/sign out/i.test(text)) throw new Error('dialog does not mention signing out');
      if (!text.includes(session.window.App.state.user.fullName)) {
        throw new Error('dialog does not say who is signed in');
      }
      // Cancelling must leave the session intact.
      host.querySelector('[data-role=cancel]').click();
      await new Promise((r) => setTimeout(r, 20));
      if (!window.document.getElementById('appView').hidden === false) { /* still in app */ }
      if (!window.App.state.user) throw new Error('cancelling still signed the user out');
      record('sign-out asks first and cancel keeps you in', null);
    } catch (err) {
      record('sign-out asks first and cancel keeps you in', err.message);
    }

    try {
      // On a phone the topbar buttons are hidden, so the sidebar must carry them.
      // Reachable from the sidebar like any other page.
      const entry = window.document.querySelector('.nav-account .nav-item[data-page="account"]');
      if (!entry) throw new Error('no Account entry in the sidebar');

      const html = await renderPage(window, 'account');
      const user = session.window.App.state.user;
      for (const [needle, what] of [
        [user.fullName, 'the signed-in name'],
        [user.username, 'the login ID'],
        [user.roleName, 'the role'],
      ]) {
        if (!html.includes(needle)) throw new Error(`Account page does not show ${what}`);
      }
      if (!window.document.getElementById('accountTheme')) throw new Error('no appearance picker');
      if (!window.document.getElementById('changeSecret')) throw new Error('no change-password action');
      if (!window.document.getElementById('accountSignOut')) throw new Error('no sign-out action');

      // A PIN user must be told "PIN", not "password".
      const usesPin = user.credentialType === 'PIN';
      if (usesPin && !/PIN/.test(html)) throw new Error('PIN account not described as using a PIN');

      // Nothing account-related may be left stranded in the topbar, and the
      // Phase 1 chip is gone.
      if (window.document.querySelector('.topbar #logoutBtn, .topbar #themeBtn, .topbar #userChip')) {
        throw new Error('account controls still present in the topbar');
      }
      if (window.document.querySelector('.topbar .chip-phase')) {
        throw new Error('Phase 1 chip still present in the topbar');
      }
      record('Account page carries identity, appearance, security and sign out', null);
    } catch (err) {
      record('Account page carries identity, appearance, security and sign out', err.message);
    }

    if (role.label === 'Super Admin') await interactionChecks(session);

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
