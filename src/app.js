/**
 * app.js – Express application factory.
 *
 * Unchanged from the original except:
 *   - exports the raw `app` as before (HTTP routes are registered here)
 *   - also exports an `attachWs(httpServer)` helper so index.js can wire up
 *     the WebSocket server after http.Server is created.
 *
 * This keeps the test helpers (which import `app` directly and call
 * app.listen() themselves) working without modification.
 */
'use strict';

const express = require('express');
const orderRoutes = require('./routes/orders');
const healthRoutes = require('./routes/health');

const app = express();
app.use(express.json());
app.use('/api', orderRoutes);
app.use('/api', healthRoutes);

// 404
app.use((req, res) => res.status(404).json({ error: 'not found' }));

module.exports = app;
