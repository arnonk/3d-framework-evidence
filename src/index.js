const app = require('./app');
const config = require('./config');

const wsService = require('./services/wsService');

const server = app.listen(config.port, () => {
  console.log(`order-service listening on :${config.port} (${config.env})`);
});
wsService.attach(server);

process.on('SIGTERM', () => server.close(() => process.exit(0)));
