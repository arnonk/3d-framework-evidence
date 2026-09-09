/**
 * wsHub.js — WebSocket broadcast hub.
 *
 * Manages all connected WebSocket clients and fans out two event types:
 *
 *   order_update  - emitted whenever an order is placed or its status changes.
 *                   Payload: the full order object.
 *
 *   book_snapshot - emitted whenever an order is added to the book.
 *                   Payload: { symbol, bids: [...], asks: [...] }
 *                   (simple side-separated view of open orders for that symbol)
 *
 * Clients connect to  ws://<host>/ws  and receive JSON-encoded messages:
 *   { type: 'order_update' | 'book_snapshot', data: <payload>, ts: <epoch ms> }
 *
 * Clients may subscribe to a specific symbol by sending:
 *   { subscribe: 'AAPL' }
 * If no subscription is sent they receive events for all symbols.
 *
 * Attach by calling hub.attach(httpServer) once.
 */
'use strict';

const { WebSocketServer, OPEN } = require('ws');
const logger = require('../utils/logger');

let wss = null;

/**
 * Attach the WebSocket server to an existing http.Server.
 * Must be called exactly once before any broadcasts.
 */
function attach(httpServer) {
  wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws, req) => {
    ws._subscription = null; // null = all symbols
    logger.info(`[ws] client connected from ${req.socket.remoteAddress}`);

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.subscribe && typeof msg.subscribe === 'string') {
          ws._subscription = msg.subscribe.toUpperCase();
          ws.send(JSON.stringify({ type: 'subscribed', symbol: ws._subscription, ts: Date.now() }));
          logger.info(`[ws] client subscribed to ${ws._subscription}`);
        }
      } catch (_) {
        // ignore malformed messages
      }
    });

    ws.on('close', () => logger.info('[ws] client disconnected'));
    ws.on('error', (err) => logger.error('[ws] client error', err.message));

    // Send a welcome frame so clients can confirm the connection is live.
    ws.send(JSON.stringify({ type: 'connected', ts: Date.now() }));
  });

  logger.info('[ws] hub attached to HTTP server on path /ws');
  return wss;
}

/**
 * Broadcast a message to all relevant connected clients.
 *
 * @param {string} type     - event type (e.g. 'order_update')
 * @param {object} data     - event payload
 * @param {string} [symbol] - if provided, only clients subscribed to this
 *                            symbol (or with no subscription filter) receive it
 */
function broadcast(type, data, symbol) {
  if (!wss) return; // not yet attached (unit test contexts)

  const frame = JSON.stringify({ type, data, ts: Date.now() });

  for (const client of wss.clients) {
    if (client.readyState !== OPEN) continue;
    // Filter by subscription: null = all symbols.
    if (client._subscription && symbol && client._subscription !== symbol) continue;
    try {
      client.send(frame);
    } catch (err) {
      logger.error('[ws] send error', err.message);
    }
  }
}

/**
 * Emit an order_update event for the given order object.
 */
function emitOrderUpdate(order) {
  broadcast('order_update', order, order.symbol);
}

/**
 * Emit a book_snapshot for the given symbol using the current order book.
 * Computes a lightweight bids/asks view from all open orders.
 *
 * @param {string} symbol
 * @param {Array}  orders  - all orders for this symbol
 */
function emitBookSnapshot(symbol, orders) {
  const open = orders.filter((o) => o.status === 'accepted' || o.status === 'partially_filled');
  const bids = open
    .filter((o) => o.side === 'buy')
    .sort((a, b) => b.price - a.price) // descending
    .slice(0, 20)
    .map((o) => ({ price: o.price, qty: o.qty, orderId: o.id }));
  const asks = open
    .filter((o) => o.side === 'sell')
    .sort((a, b) => a.price - b.price) // ascending
    .slice(0, 20)
    .map((o) => ({ price: o.price, qty: o.qty, orderId: o.id }));

  broadcast('book_snapshot', { symbol, bids, asks }, symbol);
}

/** Return connected client count (for /api/health). */
function clientCount() {
  return wss ? wss.clients.size : 0;
}

/** For testing: return the underlying WebSocketServer. */
function _wss() {
  return wss;
}

/** Detach and close for testing / graceful shutdown. */
function close(cb) {
  if (wss) {
    wss.close(cb);
    wss = null;
  } else if (cb) {
    cb();
  }
}

module.exports = { attach, broadcast, emitOrderUpdate, emitBookSnapshot, clientCount, close, _wss };
