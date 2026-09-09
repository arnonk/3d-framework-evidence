const { WebSocketServer } = require('ws');

const clients = new Set();
let wss = null;

function attach(server) {
  wss = new WebSocketServer({ server, path: '/ws' });
  
  wss.on('connection', (ws) => {
    ws.subscriptions = { channels: new Set(), symbols: new Set() };
    clients.add(ws);
    
    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message);
        if (data.type === 'subscribe') {
          if (Array.isArray(data.channels)) {
            data.channels.forEach(ch => ws.subscriptions.channels.add(ch));
          }
          if (data.symbol) {
            ws.subscriptions.symbols.add(data.symbol);
          }
        }
      } catch (e) {
        // ignore malformed messages
      }
    });
    
    ws.on('close', () => {
      clients.delete(ws);
    });
  });
}

const matchingEngine = require('./matchingEngine');

matchingEngine.on('trade', (data) => {
  broadcast('trade', data.symbol, data);
});

matchingEngine.on('book_update', (data) => {
  broadcast('book', data.symbol, data);
});

function broadcast(channel, symbol, data) {
  for (const ws of clients) {
    if (ws.readyState === 1 && // OPEN
        ws.subscriptions.channels.has(channel) && 
        (!symbol || ws.subscriptions.symbols.has(symbol))) {
      ws.send(JSON.stringify(data));
    }
  }
}

module.exports = { attach, broadcast };
