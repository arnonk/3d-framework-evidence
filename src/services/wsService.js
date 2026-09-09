const { WebSocketServer, WebSocket } = require('ws');
const { eventBus, EVENTS } = require('../utils/eventBus');
const { engine } = require('../models/orderBook');
const logger = require('../utils/logger');

class WebSocketService {
  constructor() {
    this.wss = null;
    this.clients = new Set();
    this.setupEventBusListeners();
  }

  init(server, path = '/ws') {
    this.wss = new WebSocketServer({ server, path });

    this.wss.on('connection', (ws, req) => {
      ws.isAlive = true;
      ws.subscriptions = new Set(['all']); // Default subscription to all channels or specific

      this.clients.add(ws);
      logger.info('WebSocket client connected from', req?.socket?.remoteAddress || 'unknown');

      // Send initial welcome message
      this.safeSend(ws, {
        type: 'connected',
        message: 'Real-time trade execution engine WebSocket connected',
        timestamp: Date.now(),
      });

      ws.on('message', data => {
        try {
          const message = JSON.parse(data.toString());
          this.handleClientMessage(ws, message);
        } catch (err) {
          this.safeSend(ws, { type: 'error', message: 'Invalid JSON message' });
        }
      });

      ws.on('pong', () => {
        ws.isAlive = true;
      });

      ws.on('close', () => {
        this.clients.delete(ws);
        logger.info('WebSocket client disconnected');
      });

      ws.on('error', err => {
        logger.warn('WebSocket client error:', err.message);
        this.clients.delete(ws);
      });
    });

    return this.wss;
  }

  handleClientMessage(ws, message) {
    const action = message.action || message.type;

    if (action === 'ping') {
      return this.safeSend(ws, { type: 'pong', timestamp: Date.now() });
    }

    if (action === 'subscribe') {
      const channels = message.channels || (message.channel ? [message.channel] : ['book', 'trades', 'circuit_breaker']);
      const symbols = message.symbols || (message.symbol ? [message.symbol] : ['*']);

      for (const ch of channels) {
        for (const sym of symbols) {
          const subKey = `${ch.toLowerCase()}:${sym.toUpperCase()}`;
          ws.subscriptions.add(subKey);
        }
      }

      this.safeSend(ws, {
        type: 'subscribed',
        channels,
        symbols,
        timestamp: Date.now(),
      });
      return;
    }

    if (action === 'unsubscribe') {
      const channels = message.channels || (message.channel ? [message.channel] : []);
      const symbols = message.symbols || (message.symbol ? [message.symbol] : ['*']);

      for (const ch of channels) {
        for (const sym of symbols) {
          ws.subscriptions.delete(`${ch.toLowerCase()}:${sym.toUpperCase()}`);
        }
      }

      this.safeSend(ws, {
        type: 'unsubscribed',
        channels,
        symbols,
        timestamp: Date.now(),
      });
      return;
    }

    if (action === 'get_book') {
      const symbol = message.symbol;
      if (!symbol) {
        return this.safeSend(ws, { type: 'error', message: 'symbol required for get_book' });
      }
      const depth = engine.getDepth(symbol);
      return this.safeSend(ws, {
        type: 'book_snapshot',
        ...depth,
      });
    }
  }

  safeSend(ws, payload) {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(payload));
      } catch (err) {
        logger.warn('Failed to send WebSocket payload:', err.message);
      }
    }
  }

  broadcast(channel, symbol, payload) {
    const specificKey = `${channel.toLowerCase()}:${symbol.toUpperCase()}`;
    const wildcardKey = `${channel.toLowerCase()}:*`;

    for (const ws of this.clients) {
      if (
        ws.subscriptions.has('all') ||
        ws.subscriptions.has(wildcardKey) ||
        ws.subscriptions.has(specificKey)
      ) {
        this.safeSend(ws, payload);
      }
    }
  }

  setupEventBusListeners() {
    eventBus.on(EVENTS.BOOK_UPDATED, depth => {
      this.broadcast('book', depth.symbol, {
        type: 'book_update',
        symbol: depth.symbol,
        bids: depth.bids,
        asks: depth.asks,
        bestBid: depth.bestBid,
        bestAsk: depth.bestAsk,
        spread: depth.spread,
        lastPrice: depth.lastPrice,
        timestamp: depth.timestamp || Date.now(),
      });
    });

    eventBus.on(EVENTS.TRADES_EXECUTED, ({ symbol, trades }) => {
      for (const trade of trades) {
        this.broadcast('trades', symbol, {
          type: 'trade_execution',
          trade_id: trade.tradeId,
          symbol: trade.symbol,
          price: trade.price,
          qty: trade.qty,
          buy_order_id: trade.buyOrderId,
          sell_order_id: trade.sellOrderId,
          timestamp: trade.timestamp,
        });
      }
    });

    eventBus.on(EVENTS.CIRCUIT_BREAKER_TRIGGERED, event => {
      this.broadcast('circuit_breaker', event.symbol, {
        type: 'circuit_breaker',
        symbol: event.symbol,
        state: event.state,
        reason: event.reason,
        referencePrice: event.referencePrice,
        timestamp: event.timestamp || Date.now(),
      });
    });

    eventBus.on(EVENTS.CIRCUIT_BREAKER_RESET, event => {
      this.broadcast('circuit_breaker', event.symbol, {
        type: 'circuit_breaker',
        symbol: event.symbol,
        state: event.state,
        timestamp: event.timestamp || Date.now(),
      });
    });
  }

  close() {
    if (this.wss) {
      for (const client of this.clients) {
        client.terminate();
      }
      this.clients.clear();
      this.wss.close();
    }
  }
}

const wsService = new WebSocketService();

module.exports = {
  wsService,
  WebSocketService,
};
