/**
 * wsHub.js – WebSocket broadcast hub.
 *
 * Attaches a ws.Server to the existing HTTP server and manages all connected
 * clients.  Other services call the broadcast helpers to push events.
 *
 * Event envelope:
 *   { type: string, ts: number, payload: object }
 *
 * Event types emitted:
 *   order_ack      – new order accepted (fired before fee is computed)
 *   order_ready    – order fully processed with fee
 *   trade          – simulated fill notification
 *   book_update    – snapshot of order counts per symbol
 *   circuit_open   – breaker tripped for a symbol
 *   circuit_half   – breaker in half-open (cooldown elapsed)
 *   circuit_closed – breaker reset / recovered
 *
 * Client→server messages (JSON):
 *   { type: 'subscribe', symbols: ['AAPL','TSLA'] }  – filter events by symbol
 *   { type: 'subscribe_all' }                          – receive everything
 *
 * Connecting with no subscription message also receives everything by default.
 */
'use strict';

const { WebSocketServer } = require('ws');
const circuitBreaker = require('./circuitBreaker');
const logger = require('../utils/logger');

let wss = null;

/**
 * Attach the WebSocket server to an existing http.Server.
 * Called from src/index.js after app.listen().
 */
function attach(httpServer) {
  wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws) => {
    ws._subscriptions = null; // null = all symbols

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'subscribe' && Array.isArray(msg.symbols)) {
          ws._subscriptions = new Set(msg.symbols.map(s => String(s).toUpperCase()));
          ws.send(JSON.stringify({ type: 'subscribed', symbols: [...ws._subscriptions], ts: Date.now() }));
        } else if (msg.type === 'subscribe_all') {
          ws._subscriptions = null;
          ws.send(JSON.stringify({ type: 'subscribed', symbols: 'all', ts: Date.now() }));
        }
      } catch (_) { /* ignore malformed messages */ }
    });

    ws.on('error', (err) => logger.error('[ws] client error', err.message));

    // Send current circuit breaker state on connect
    const snapshot = circuitBreaker.status();
    ws.send(JSON.stringify({ type: 'circuit_snapshot', payload: snapshot, ts: Date.now() }));
  });

  // Forward circuit breaker state changes to all relevant subscribers
  circuitBreaker.emitter.on('change', ({ symbol, state }) => {
    let type;
    if (state === circuitBreaker.OPEN)      type = 'circuit_open';
    else if (state === circuitBreaker.HALF_OPEN) type = 'circuit_half';
    else                                     type = 'circuit_closed';
    _broadcast({ type, payload: circuitBreaker.status(), ts: Date.now() }, symbol);
  });

  logger.info('[ws] WebSocket server attached at /ws');
}

/**
 * Broadcast a message to all connected clients, optionally filtered by symbol.
 * @param {object} envelope  – { type, payload, ts }
 * @param {string|null} symbol – if provided, only clients subscribed to this symbol
 *                               (or with no subscription filter) receive the event.
 */
function _broadcast(envelope, symbol) {
  if (!wss) return;
  const json = JSON.stringify(envelope);
  for (const client of wss.clients) {
    if (client.readyState !== 1 /* OPEN */) continue;
    if (symbol && client._subscriptions && !client._subscriptions.has(symbol.toUpperCase())) continue;
    client.send(json);
  }
}

/** Order accepted (pre-fee) – fast ack path. */
function emitOrderAck(order) {
  _broadcast({
    type: 'order_ack',
    payload: { order_id: order.id, symbol: order.symbol, side: order.side, qty: order.qty, price: order.price, status: order.status },
    ts: Date.now(),
  }, order.symbol);
}

/** Order fully processed with fee. */
function emitOrderReady(order) {
  _broadcast({
    type: 'order_ready',
    payload: { order_id: order.id, symbol: order.symbol, side: order.side, qty: order.qty, price: order.price, fee: order.fee, status: order.status },
    ts: Date.now(),
  }, order.symbol);
}

/** Simulated fill / trade. */
function emitTrade(trade) {
  _broadcast({
    type: 'trade',
    payload: trade,
    ts: Date.now(),
  }, trade.symbol);
}

/** Book snapshot update (fired after each new order). */
function emitBookUpdate(snapshot) {
  _broadcast({ type: 'book_update', payload: snapshot, ts: Date.now() }, null);
}

function clientCount() {
  return wss ? wss.clients.size : 0;
}

module.exports = { attach, emitOrderAck, emitOrderReady, emitTrade, emitBookUpdate, clientCount };
