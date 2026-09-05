'use strict';

require('dotenv').config();

const path = require('node:path');
const express = require('express');
const cookieParser = require('cookie-parser');

const { migrate } = require('./db/migrate');
const { authenticate } = require('./middleware/auth');

const PORT = Number(process.env.PORT) || 3000;

function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser());
  app.use(authenticate);

  app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'kitchops', phase: 1 }));

  app.use('/api/auth', require('./routes/auth.routes'));
  app.use('/api/meta', require('./routes/meta.routes'));
  app.use('/api/users', require('./routes/users.routes'));
  app.use('/api/credentials', require('./routes/credentials.routes'));
  app.use('/api/stations', require('./routes/stations.routes'));
  app.use('/api/locations', require('./routes/locations.routes'));
  app.use('/api/recipes', require('./routes/recipes.routes'));
  app.use('/api/roster', require('./routes/roster.routes'));
  app.use('/api/tasks', require('./routes/tasks.routes'));
  app.use('/api/validation', require('./routes/validation.routes'));

  // Always revalidate before reusing an asset. Browsers otherwise happily serve
  // a cached app.js against a newer index.html, which renders a blank page and
  // looks like an application fault. ETags keep revalidation cheap (304s), so
  // this costs a round trip, not a re-download — and every kitchen phone picks
  // up an update on its next load rather than needing a manual hard refresh.
  app.use(express.static(path.join(__dirname, '..', 'public'), {
    etag: true,
    lastModified: true,
    // "/" must reach the shell handler below, which applies a stricter policy.
    index: false,
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
  }));

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown endpoint.' }));

  // Single-page shell for any non-API route. The shell is never cached: it is
  // what names the current asset files, so a stale copy poisons everything else.
  app.get('*', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err.status || 500;
    if (status >= 500) console.error('[error]', err);
    const body = { error: err.message || 'Unexpected server error.' };
    if (err.code) body.code = err.code;
    if (err.references) body.references = err.references;
    if (err.requiredPermissions) body.requiredPermissions = err.requiredPermissions;
    res.status(status).json(body);
  });

  return app;
}

/**
 * Every address a phone on the same Wi-Fi can use. Virtual adapters (WSL,
 * VirtualBox, Hyper-V) are filtered out — they look like LAN addresses but are
 * not reachable from a handset.
 */
function lanAddresses() {
  // Adapter NAMES catch most virtual interfaces, but VirtualBox's host-only
  // adapter shows up as a plain "Ethernet N", so its well-known 192.168.56.x
  // range is excluded by address too. Neither is reachable from a handset.
  const VIRTUAL_NAME = /(vEthernet|VirtualBox|VMware|Loopback|Hyper-V|Bluetooth|Docker|WSL|Npcap)/i;
  const VIRTUAL_NET = /^(192\.168\.56\.|169\.254\.|172\.1[7-9]\.|172\.2\d\.|172\.3[01]\.)/;

  return Object.entries(require('node:os').networkInterfaces())
    .filter(([name]) => !VIRTUAL_NAME.test(name))
    .flatMap(([name, addrs]) => (addrs || [])
      .filter((a) => a.family === 'IPv4' && !a.internal && !VIRTUAL_NET.test(a.address))
      .map((a) => ({ name, address: a.address, wifi: /wi-?fi|wlan|wireless/i.test(name) })))
    // A phone joins over Wi-Fi, so show that adapter first.
    .sort((a, b) => Number(b.wifi) - Number(a.wifi));
}

if (require.main === module) {
  migrate();
  // Bind every interface, not just loopback, so phones on the same Wi-Fi can
  // reach it (v10.2 Rule 7 — counter staff use a phone browser).
  createApp().listen(PORT, '0.0.0.0', () => {
    console.log(`\nKitchOps running\n  on this PC   http://localhost:${PORT}`);
    const lan = lanAddresses();
    lan.forEach(({ name, address, wifi }, i) => {
      const hint = wifi ? '  <- use this one' : i === 0 ? '  <- try this one' : '';
      console.log(`  on a phone   http://${address}:${PORT}   (${name})${hint}`);
    });
    if (!lan.length) {
      console.log('  no LAN address found — is Wi-Fi connected?');
    } else {
      console.log('\n  The phone must be on the SAME Wi-Fi. If it will not connect,');
      console.log(`  Windows Firewall is probably blocking inbound port ${PORT}.\n`);
    }
  });
}

module.exports = { createApp };
