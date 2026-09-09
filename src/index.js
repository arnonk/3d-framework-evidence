const app = require('./app');
const config = require('./config');

const server = app.listen(config.port, () => {
  console.log(`order-service listening on :${config.port} (${config.env})`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
