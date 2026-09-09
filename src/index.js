const app = require('./app');
const config = require('./config');
const { WebSocketServer } = require('ws');
const { engineEvents } = require('./services/executionEngine');

const server = app.listen(config.port, () => {
  console.log(`order-service listening on :${config.port} (${config.env})`);
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log('WebSocket connection established');
  ws.send(JSON.stringify({ type: 'connected' }));
});

engineEvents.on('trade', (data) => {
  const msg = JSON.stringify({ type: 'trade', data });
  wss.clients.forEach(c => c.send(msg));
});
engineEvents.on('order_update', (data) => {
  const msg = JSON.stringify({ type: 'order_update', data });
  wss.clients.forEach(c => c.send(msg));
});
engineEvents.on('circuit_breaker', (data) => {
  const msg = JSON.stringify({ type: 'circuit_breaker', data });
  wss.clients.forEach(c => c.send(msg));
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
