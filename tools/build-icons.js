'use strict';

/**
 * Rasterises public/favicon.svg into the bitmap icons browsers still ask for.
 *
 * Uses headless Chrome over the DevTools Protocol — the same approach as
 * test/responsive.js — so there is no image library to install and the output
 * matches exactly how a browser draws the SVG.
 *
 *   npm run build:icons
 *
 * Produces:
 *   public/favicon.ico          32px, for browsers that request /favicon.ico
 *   public/icons/icon-180.png   iOS home screen (apple-touch-icon)
 *   public/icons/icon-192.png   Android home screen
 *
 * Re-run this after editing favicon.svg. Skips cleanly if Chrome is absent.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const SVG = path.join(PUBLIC, 'favicon.svg');
const ICON_DIR = path.join(PUBLIC, 'icons');

const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

const SIZES = [32, 180, 192];

const getJson = (url) => new Promise((resolve, reject) => {
  http.get(url, (res) => {
    let body = '';
    res.on('data', (d) => { body += d; });
    res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
  }).on('error', reject);
});


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
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  });
  return {
    ready,
    send: (method, params = {}) => new Promise((resolve, reject) => {
      const msgId = ++id;
      pending.set(msgId, { resolve, reject });
      ws.send(JSON.stringify({ id: msgId, method, params }));
    }),
    close: () => ws.close(),
  };
}

/** Wraps a 32px PNG in an ICO container. ICO permits a raw PNG payload. */
function pngToIco(png, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);      // reserved
  header.writeUInt16LE(1, 2);      // 1 = icon
  header.writeUInt16LE(1, 4);      // one image

  const entry = Buffer.alloc(16);
  entry.writeUInt8(size >= 256 ? 0 : size, 0);   // width  (0 means 256)
  entry.writeUInt8(size >= 256 ? 0 : size, 1);   // height
  entry.writeUInt8(0, 2);                        // palette size
  entry.writeUInt8(0, 3);                        // reserved
  entry.writeUInt16LE(1, 4);                     // colour planes
  entry.writeUInt16LE(32, 6);                    // bits per pixel
  entry.writeUInt32LE(png.length, 8);            // payload size
  entry.writeUInt32LE(header.length + entry.length, 12); // payload offset

  return Buffer.concat([header, entry, png]);
}

async function main() {
  const browser = BROWSERS.find((p) => fs.existsSync(p));
  if (!browser) {
    console.log('No Chrome or Edge found — cannot rasterise. favicon.svg still works');
    console.log('in every modern browser; only the .ico/.png fallbacks are skipped.');
    process.exit(0);
  }
  if (!fs.existsSync(SVG)) throw new Error('public/favicon.svg is missing');
  fs.mkdirSync(ICON_DIR, { recursive: true });

  // A tiny page that shows the SVG at an exact pixel size, on a transparent
  // ground so the tile's rounded corners stay rounded.
  const svg = fs.readFileSync(SVG, 'utf8');
  const stage = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kitchops-icon-')), 'stage.html');
  fs.writeFileSync(stage,
    `<!doctype html><meta charset="utf-8">
     <style>html,body{margin:0;padding:0;background:transparent}
            svg{display:block;width:100vw;height:100vh}</style>${svg}`);

  const port = 9455;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kitchops-icons-'));
  const chrome = spawn(browser, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    'about:blank',
  ], { stdio: 'ignore' });

  let client;
  try {
    const started = Date.now();
    for (;;) {
      try { await getJson(`http://127.0.0.1:${port}/json/version`); break; }
      catch {
        if (Date.now() - started > 15000) throw new Error('Chrome did not start');
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    const target = await openPageTarget(port);
    client = cdp(target.webSocketDebuggerUrl);
    await client.ready;
    await client.send('Page.enable');
    // Rasterise the LIGHT tile: it reads on both light and dark browser chrome,
    // and dark-capable browsers use the SVG anyway.
    await client.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: 'light' }],
    });
    // Transparent page background, so the tile keeps its rounded corners rather
    // than sitting on an opaque square. Done over CDP because the equivalent
    // --default-background-color launch flag hangs headless startup here.
    await client.send('Emulation.setDefaultBackgroundColorOverride', {
      color: { r: 0, g: 0, b: 0, a: 0 },
    });

    for (const size of SIZES) {
      await client.send('Emulation.setDeviceMetricsOverride', {
        width: size, height: size, deviceScaleFactor: 1, mobile: false,
      });
      await client.send('Page.navigate', { url: 'file:///' + stage.replace(/\\/g, '/') });
      await new Promise((r) => setTimeout(r, 350));
      const { data } = await client.send('Page.captureScreenshot', {
        format: 'png', omitBackground: true,
        clip: { x: 0, y: 0, width: size, height: size, scale: 1 },
      });
      const png = Buffer.from(data, 'base64');

      if (size === 32) {
        fs.writeFileSync(path.join(PUBLIC, 'favicon.ico'), pngToIco(png, 32));
        console.log(`  favicon.ico            ${png.length} bytes (32px)`);
      }
      fs.writeFileSync(path.join(ICON_DIR, `icon-${size}.png`), png);
      console.log(`  icons/icon-${size}.png${' '.repeat(Math.max(0, 9 - String(size).length))}${png.length} bytes`);
    }
  } finally {
    try { client?.close(); } catch { /* closing anyway */ }
    chrome.kill();
  }
  console.log('\nIcons rebuilt from public/favicon.svg');
}

main().catch((err) => {
  console.error('Icon build failed:', err.message);
  process.exit(1);
});
