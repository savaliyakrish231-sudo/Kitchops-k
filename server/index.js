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
  app.use('/api/stations', require('./routes/stations.routes'));
  app.use('/api/locations', require('./routes/locations.routes'));
  app.use('/api/recipes', require('./routes/recipes.routes'));
  app.use('/api/roster', require('./routes/roster.routes'));
  app.use('/api/validation', require('./routes/validation.routes'));

  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown endpoint.' }));

  // Single-page shell for any non-API route.
  app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

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

if (require.main === module) {
  migrate();
  createApp().listen(PORT, () => {
    console.log(`KitchOps running on http://localhost:${PORT}`);
  });
}

module.exports = { createApp };
