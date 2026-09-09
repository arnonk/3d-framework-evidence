const http = require('http');
const app = require('./app');
const config = require('./config');
const wsHub = require('./services/wsHub');
const feePool = require('./workers/feePool');
const logger = require('./utils/logger');

// Wrap Express app in a plain http.Server so we can attach WebSockets
// to the same port without opening a second listener.
const server = http.createServer(app);

// Attach WebSocket hub — must happen before server.listen so upgrade
// requests that arrive immediately after listen() are handled.
wsHub.attach(server);

server.listen(config.port, () => {
  logger.info(`order-service listening on :${config.port} (${config.env})`);
  logger.info(`WebSocket endpoint: ws://localhost:${config.port}/ws`);
});

// Graceful shutdown: stop accepting new connections, finish in-flight
// requests, then terminate the fee-worker threads.
function shutdown(signal) {
  logger.info(`${signal} received — shutting down`);
  server.close(async () => {
    await feePool.shutdown();
    logger.info('shutdown complete');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
