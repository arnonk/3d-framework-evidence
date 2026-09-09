const { WebSocketServer, WebSocket } = require('ws');
const { matchingEngine } = require('../models/matchingEngine');
const book = require('../models/orderBook');

class WebSocketService {
  constructor() {
    this.wss = null;
    this.clients = new Set();
    this._setupEngineListeners();
  }

  _setupEngineListeners() {
    matchingEngine.on('trade', (trade) => {
      this.broadcast('trades', trade.symbol, {
        type: 'trade',
        channel: 'trades',
        data: trade,
      });
    });

    matchingEngine.on('book_update', (update) => {
      this.broadcast('orderbook', update.symbol, {
        type: 'book_update',
        channel: 'orderbook',
        symbol: update.symbol,
        side: update.side,
        price: update.price,
        qty: update.qty,
        timestamp: update.timestamp,
      });
    });

    matchingEngine.on('order_update', (orderUpdate) => {
      this.broadcast('orders', orderUpdate.symbol, {
        type: 'order_update',
        channel: 'orders',
        data: orderUpdate,
      });
    });
  }

  attach(server) {
    if (this.wss) {
      this.close();
    }

    this.wss = new WebSocketServer({ server });

    this.wss.on('connection', (ws) => {
      ws.subscriptions = new Set();
      this.clients.add(ws);

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleClientMessage(ws, msg);
        } catch (e) {
          this.safeSend(ws, { type: 'error', message: 'invalid json' });
        }
      });

      ws.on('close', () => {
        this.clients.delete(ws);
      });

      ws.on('error', () => {
        this.clients.delete(ws);
      });
    });

    return this.wss;
  }

  handleClientMessage(ws, msg) {
    if (!msg || typeof msg !== 'object') return;

    if (msg.action === 'ping') {
      return this.safeSend(ws, {
        type: 'pong',
        timestamp: Date.now(),
      });
    }

    if (msg.action === 'subscribe') {
      const channel = msg.channel;
      const symbol = msg.symbol;
      const subKey = `${channel}:${symbol}`;
      ws.subscriptions.add(subKey);

      this.safeSend(ws, {
        type: 'subscribed',
        channel,
        symbol,
        timestamp: Date.now(),
      });

      if (channel === 'orderbook' && symbol) {
        const depth = book.getDepth(symbol);
        this.safeSend(ws, {
          type: 'snapshot',
          channel: 'orderbook',
          symbol,
          bids: depth.bids,
          asks: depth.asks,
          timestamp: Date.now(),
        });
      }
      return;
    }

    if (msg.action === 'unsubscribe') {
      const channel = msg.channel;
      const symbol = msg.symbol;
      const subKey = `${channel}:${symbol}`;
      ws.subscriptions.delete(subKey);

      return this.safeSend(ws, {
        type: 'unsubscribed',
        channel,
        symbol,
        timestamp: Date.now(),
      });
    }
  }

  broadcast(channel, symbol, message) {
    const subKey = `${channel}:${symbol}`;
    const payload = JSON.stringify(message);

    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN && client.subscriptions.has(subKey)) {
        client.send(payload);
      }
    }
  }

  safeSend(ws, message) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  getActiveConnectionCount() {
    return this.clients.size;
  }

  close() {
    return new Promise((resolve) => {
      for (const client of this.clients) {
        try {
          client.terminate();
        } catch (e) {}
      }
      this.clients.clear();

      if (this.wss) {
        this.wss.close(() => {
          this.wss = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}

const websocketService = new WebSocketService();
module.exports = websocketService;
