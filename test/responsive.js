'use strict';

/**
 * REAL-LAYOUT responsive test.
 *
 * The jsdom suite cannot measure pixels, which is exactly how a horizontal
 * overflow bug reached a phone unnoticed. This drives headless Chrome over the
 * DevTools Protocol — no extra dependencies, using Node's built-in WebSocket —
 * emulates real phone/tablet/desktop viewports, and measures the rendered box
 * of every element.
 *
 * It fails on:
 *   - the page being wider than the screen (sideways scrolling)
 *   - any element sticking out past the right edge
 *   - interactive controls smaller than the 44px touch minimum
 *   - text below a readable size
 *
 *   npm run test:responsive
 *
 * Skips cleanly (exit 0) when no Chrome/Edge is installed.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kitchops-resp-')), 'resp.db');
process.env.KITCHOPS_DB = DB;
process.env.KITCHOPS_JWT_SECRET = 'responsive-secret';
process.env.KITCHOPS_ADMIN_USER = 'respadmin';
process.env.KITCHOPS_ADMIN_PASS = 'respadmin123';

const { migrate } = require('../server/db/migrate');
const { seed } = require('../server/db/seed-sample');
const { createApp } = require('../server/index');

const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

// Real devices, smallest first. 320 is the narrowest phone still in use.
const VIEWPORTS = [
  { name: 'small phone', width: 320, height: 640, mobile: true },
  { name: 'phone', width: 360, height: 740, mobile: true },
  { name: 'large phone', width: 414, height: 896, mobile: true },
  { name: 'tablet', width: 768, height: 1024, mobile: true },
  { name: 'laptop', width: 1280, height: 800, mobile: false },
];

const PAGES = ['dashboard', 'counter', 'recipes', 'stations', 'locations',
  'masters', 'users', 'credentials', 'settings', 'account'];

const TOUCH_MIN = 44;   // Apple HIG; Android asks 48
const TEXT_MIN = 11;    // below this is unreadable on a handset

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

// --------------------------------------------------------------- CDP client

/** HTTP request helper — /json/new requires PUT on current Chrome. */
const httpRequest = (url, method = 'GET') => new Promise((resolve, reject) => {
  const u = new URL(url);
  const req = http.request(
    { host: u.hostname, port: u.port, path: u.pathname + u.search, method },
    (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
  req.on('error', reject);
  req.end();
});

/**
 * Opens a fresh page target and returns it. Chrome's startup tab is not
 * dependably a "page" — in headless it can be a chrome://headless command page,
 * and /json/list also returns extension and browser-UI targets. Creating one
 * explicitly removes that guesswork.
 */
async function openPageTarget(port) {
  try {
    const created = await httpRequest(`http://127.0.0.1:${port}/json/new?about:blank`, 'PUT');
    if (created && created.webSocketDebuggerUrl) return created;
  } catch { /* fall through to reusing an existing page */ }

  for (let i = 0; i < 20; i++) {
    const list = await httpRequest(`http://127.0.0.1:${port}/json/list`);
    const page = list.find((t) => t.type === 'page');
    if (page) return page;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Chrome exposed no page target to drive');
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  const waiters = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
      return;
    }
    if (msg.method && waiters.has(msg.method)) {
      const list = waiters.get(msg.method);
      waiters.delete(msg.method);
      list.forEach((fn) => fn(msg.params));
    }
  });
  return {
    ready,
    send(method, params = {}) {
      const msgId = ++id;
      return new Promise((resolve, reject) => {
        pending.set(msgId, { resolve, reject });
        ws.send(JSON.stringify({ id: msgId, method, params }));
      });
    },
    /** Resolves the next time Chrome emits `event`. */
    once(event, timeoutMs = 10000) {
      return new Promise((resolve, reject) => {
        const list = waiters.get(event) || [];
        list.push(resolve);
        waiters.set(event, list);
        setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), timeoutMs);
      });
    },
    close: () => ws.close(),
  };
}

const getJson = (url) => new Promise((resolve, reject) => {
  http.get(url, (res) => {
    let body = '';
    res.on('data', (d) => { body += d; });
    res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
  }).on('error', reject);
});

async function waitForDevTools(port, timeoutMs = 15000) {
  const started = Date.now();
  for (;;) {
    try { return await getJson(`http://127.0.0.1:${port}/json/version`); }
    catch {
      if (Date.now() - started > timeoutMs) throw new Error('Chrome did not expose its debugging port');
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

/**
 * Navigates and waits for the document to finish loading. Polling readyState is
 * more robust here than Page.loadEventFired, which depends on being attached to
 * the exact target that navigates.
 */
async function navigate(client, url, timeoutMs = 15000) {
  await client.send('Page.navigate', { url });
  const started = Date.now();
  for (;;) {
    try {
      const state = await evaluate(client, "document.readyState + '|' + location.href");
      const [ready, href] = state.split('|');
      if (ready === 'complete' && href.startsWith(url.split('#')[0])) return;
    } catch {
      // The context is swapped out mid-navigation; retry.
    }
    if (Date.now() - started > timeoutMs) throw new Error('navigation to ' + url + ' did not complete');
    await new Promise((r) => setTimeout(r, 120));
  }
}

/** Waits until the SPA has decided which view to show. */
async function waitForApp(client, timeoutMs = 8000) {
  const started = Date.now();
  for (;;) {
    const state = await evaluate(client, `(() => {
      const login = document.getElementById('loginView');
      const app = document.getElementById('appView');
      if (!login || !app) return 'no-shell';
      if (!app.hidden) return 'app';
      if (!login.hidden) return 'login';
      return 'booting';
    })()`);
    if (state === 'app' || state === 'login') return state;
    if (Date.now() - started > timeoutMs) return state;
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** Runs `expression` in the page and returns its value, awaiting promises. */
async function evaluate(client, expression) {
  const { result, exceptionDetails } = await client.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true,
  });
  if (exceptionDetails) {
    throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
  }
  return result.value;
}

// -------------------------------------------------------- in-page measuring
const MEASURE = `(() => {
  const vw = window.innerWidth;
  const doc = document.documentElement;
  const out = {
    viewport: vw,
    scrollWidth: doc.scrollWidth,
    overflow: Math.max(0, doc.scrollWidth - vw),
    wide: [],
    small: [],
    tiny: [],
  };
  const name = (el) => {
    const id = el.id ? '#' + el.id : '';
    const cls = typeof el.className === 'string' && el.className
      ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
    return el.tagName.toLowerCase() + id + cls;
  };
  const describe = (el) => {
    const txt = (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 22);
    const chain = [];
    for (let p = el.parentElement; p && chain.length < 3 && p.id !== 'appView'; p = p.parentElement) {
      chain.push(name(p));
    }
    return name(el) + (txt ? ' "' + txt + '"' : '') + ' in ' + chain.join(' < ');
  };
  // Horizontal scrolling INSIDE a designated container is intentional (a wide
  // table on a laptop). Only flag elements that are not inside one.
  const inScroller = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if (ox === 'auto' || ox === 'scroll') return true;
    }
    return false;
  };
  for (const el of document.querySelectorAll('#appView *')) {
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || !r.width) continue;
    // Fixed overlays legitimately sit off-screen (the closed nav drawer).
    if (style.position === 'fixed' && r.right <= 0) continue;
    if (r.right > vw + 1 && !inScroller(el) && out.wide.length < 6) {
      out.wide.push(describe(el) + ' right=' + Math.round(r.right));
    }
    const interactive = el.matches('button, a, input, select, textarea, .nav-item, [role="button"]');
    if (interactive && r.height > 0 && r.height < ${TOUCH_MIN} - 0.5 && out.small.length < 6) {
      out.small.push(describe(el) + ' h=' + r.height.toFixed(0));
    }
    if (el.children.length === 0 && (el.textContent || '').trim()) {
      const fs = parseFloat(style.fontSize);
      if (fs && fs < ${TEXT_MIN} && out.tiny.length < 6) out.tiny.push(describe(el) + ' ' + fs + 'px');
    }
  }
  return out;
})()`;

// -------------------------------------------------------------------- main
async function main() {
  const browser = BROWSERS.find((p) => fs.existsSync(p));
  if (!browser) {
    console.log('\n\x1b[33mNo Chrome or Edge found — skipping the real-layout test.\x1b[0m');
    console.log('The jsdom suite (npm run test:ui) still runs.\n');
    process.exit(0);
  }
  console.log(`\nMeasuring real layout in ${path.basename(browser)}`);

  migrate({ silent: true });
  seed();
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const port = 9333;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kitchops-chrome-'));
  const chrome = spawn(browser, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--disable-extensions', '--mute-audio', 'about:blank',
  ], { stdio: 'ignore' });

  let client;
  try {
    await waitForDevTools(port);
    const target = await openPageTarget(port);
    client = cdp(target.webSocketDebuggerUrl);
    await client.ready;
    await client.send('Page.enable');
    await client.send('Runtime.enable');

    for (const vp of VIEWPORTS) {
      console.log(`\n\x1b[1m${vp.name} — ${vp.width}x${vp.height}\x1b[0m`);
      await client.send('Emulation.setDeviceMetricsOverride', {
        width: vp.width, height: vp.height,
        deviceScaleFactor: vp.mobile ? 2 : 1, mobile: vp.mobile,
      });

      // Sign in once per viewport, then reload so the app boots authenticated.
      await navigate(client, baseUrl + '/');
      await waitForApp(client);
      const status = await evaluate(client, `fetch('/api/auth/login',{method:'POST',
        headers:{'content-type':'application/json'},
        body:JSON.stringify({username:'respadmin',password:'respadmin123'})}).then(r=>r.status)`);
      if (status !== 200) throw new Error(`sign-in failed with status ${status}`);
      await navigate(client, baseUrl + '/');
      const view = await waitForApp(client);
      if (view !== 'app') throw new Error(`app did not boot signed in (showing "${view}")`);

      for (const page of PAGES) {
        await evaluate(client, `(location.hash = '#${page}', 1)`);
        await new Promise((r) => setTimeout(r, 450));
        const m = await evaluate(client, MEASURE);

        const problems = [];
        if (m.overflow > 1) {
          problems.push(`page is ${m.overflow}px wider than the ${m.viewport}px screen`
            + (m.wide.length ? ` — ${m.wide.join(' | ')}` : ''));
        } else if (m.wide.length) {
          problems.push(`past the right edge: ${m.wide.join(' | ')}`);
        }
        if (vp.mobile && m.small.length) {
          problems.push(`touch target under ${TOUCH_MIN}px: ${m.small.join('; ')}`);
        }
        if (m.tiny.length) problems.push(`text under ${TEXT_MIN}px: ${m.tiny[0]}`);

        record(`#${page}`, problems.length ? problems.join(' | ') : null);
      }

      // Scroll position is a real-layout property, so it can only be checked
      // here. An in-place refresh must swap its HTML in one go; if a page ever
      // blanks its content first, the browser clamps scroll to 0 and the reader
      // loses their place. This guards that.
      if (vp.mobile) {
        try {
          await evaluate(client, "(location.hash = '#users', 1)");
          await new Promise((r) => setTimeout(r, 500));
          const kept = await evaluate(client, `(async () => {
            const max = document.documentElement.scrollHeight - window.innerHeight;
            if (max < 120) return 'page too short to test';
            window.scrollTo(0, 150);
            await new Promise(r => setTimeout(r, 60));
            const before = window.scrollY;
            await window.Pages.users();          // the in-place refresh pages do
            await new Promise(r => setTimeout(r, 250));
            return Math.abs(window.scrollY - before) <= 8
              ? 'kept'
              : 'jumped from ' + before + ' to ' + window.scrollY;
          })()`);
          record('re-render keeps your place', kept === 'kept' || kept === 'page too short to test'
            ? null : kept);
        } catch (err) {
          record('re-render keeps your place', err.message);
        }
      }
    }
  } finally {
    try { client?.close(); } catch { /* closing anyway */ }
    chrome.kill();
    server.close();
  }

  console.log(`\n${'─'.repeat(64)}`);
  console.log(`  \x1b[32m${passed} passed\x1b[0m${failed ? `, \x1b[31m${failed} failed\x1b[0m` : ''}`);
  if (failed) {
    console.log('\nFailures:');
    failures.forEach((x) => console.log(`  • ${x}`));
  }
  console.log(`${'─'.repeat(64)}\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('\nResponsive harness crashed:', err);
  process.exit(1);
});
