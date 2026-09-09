/**
 * index.js – process entry point.
 *
 * Starts the HTTP server then attaches the WebSocket server to the same port.
 * Worker threads (fee service) start lazily when the first order arrives.
 */
'use strict';

const app = require('./app');
const config = require('./config');
const wsHub = require('./services/wsHub');
const feeService = require('./services/feeService');

const server = app.listen(config.port, () => {
  console.log(`order-service listening on :${config.port} (${config.env})`);
});

// Attach WebSocket server to the same HTTP server / port
wsHub.attach(server);

// Graceful shutdown: close HTTP, close WS, terminate fee workers
process.on('SIGTERM', () => {
  server.close(async () => {
    await feeService.shutdown();
    process.exit(0);
  });
});
