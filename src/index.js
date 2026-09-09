const http = require('node:http');
const app = require('./app');
const config = require('./config');
const { wsService } = require('./services/wsService');

const server = http.createServer(app);
wsService.init(server, config.ws?.path || '/ws');

if (require.main === module) {
  server.listen(config.port, () => {
    console.log(`order-service listening on :${config.port} (${config.env})`);
  });

  process.on('SIGTERM', () => {
    wsService.close();
    server.close(() => process.exit(0));
  });
}

module.exports = { server, app };
