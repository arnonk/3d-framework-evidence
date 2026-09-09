const http = require('node:http');
const app = require('./app');
const config = require('./config');
const websocketService = require('./services/websocketService');

const server = http.createServer(app);
websocketService.attach(server);

server.listen(config.port, () => {
  console.log(`order-service listening on :${config.port} (${config.env})`);
});

process.on('SIGTERM', () => {
  websocketService.close().then(() => {
    server.close(() => process.exit(0));
  });
});

module.exports = server;
