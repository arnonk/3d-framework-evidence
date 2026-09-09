/**
 * wsService.js
 *
 * Real-time WebSocket layer.
 *
 * Attach to an existing http.Server with `attach(server)`.
 * Clients connect to  ws://<host>/ws  and receive JSON frames:
 *
 *   { type: "order_book_update", payload: { id, symbol, side, qty, price, status, fee } }
 *   { type: "trade_executed",    payload: { id, symbol, side, qty, price, status, fee, executedAt } }
 *   { type: "circuit_breaker",   payload: { symbol, state, ts } }
 *   { type: "welcome",           payload: { message, subscriptions } }
 *
 * Clients may send a subscription filter (optional):
 *   { action: "subscribe", channels: ["order_book_update", "trade_executed"] }
 *   { action: "unsubscribe", channels: ["circuit_breaker"] }
 *
 * If no subscription message is sent the client receives ALL channels.
 */

const { WebSocketServer } = require('ws');
const book = require('../models/orderBook');
const circuitBreaker = require('./circuitBreaker');
const pricing = require('./pricingService');
const logger = require('../utils/logger');

const ALL_CHANNELS = ['order_book_update', 'trade_executed', 'circuit_breaker'];

/** @type {WebSocketServer | null} */
let wss = null;

// ── helpers ───────────────────────────────────────────────────────────────────

function safeStringify(obj) {
  try { return JSON.stringify(obj); }
  catch { return null; }
}

/**
 * Broadcast a message to all connected clients that have subscribed to
 * the given channel.
 */
function broadcast(channel, payload) {
  if (!wss) return;
  const frame = safeStringify({ type: channel, payload });
  if (!frame) return;
  for (const client of wss.clients) {
    if (client.readyState !== client.OPEN) continue;
    // _channels is undefined until the client sends a subscribe message,
    // which means "all channels".
    if (client._channels && !client._channels.has(channel)) continue;
    try { client.send(frame); } catch { /* ignore dead socket */ }
  }
}

// ── event subscriptions ───────────────────────────────────────────────────────

function wireEvents() {
  // Order-book mutations → order_book_update
  book.emitter.on('order_added', order => {
    broadcast('order_book_update', {
      id: order.id,
      symbol: order.symbol,
      side: order.side,
      qty: order.qty,
      price: order.price,
      status: order.status,
      fee: order.fee,
    });
  });

  // Trade executions → trade_executed
  book.emitter.on('trade_executed', order => {
    broadcast('trade_executed', {
      id: order.id,
      symbol: order.symbol,
      side: order.side,
      qty: order.qty,
      price: order.price,
      status: order.status,
      fee: order.fee,
      executedAt: new Date().toISOString(),
    });
  });

  // Circuit-breaker state changes → circuit_breaker
  // We re-use the pricing tick to detect state changes by comparing before/after.
  pricing.emitter.on('tick', ({ symbol }) => {
    const snap = circuitBreaker.snapshot();
    const sym  = snap[symbol];
    if (sym && sym.state !== 'CLOSED') {
      broadcast('circuit_breaker', { symbol, state: sym.state, ts: Date.now() });
    }
  });
}

// ── connection handler ────────────────────────────────────────────────────────

function onConnection(ws) {
  // _channels === undefined → subscribed to everything
  ws._channels = undefined;

  const welcome = safeStringify({
    type: 'welcome',
    payload: { message: 'Connected to order-service real-time feed', subscriptions: 'all' },
  });
  if (welcome) ws.send(welcome);

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch { return; }

    if (msg.action === 'subscribe' && Array.isArray(msg.channels)) {
      ws._channels = ws._channels || new Set(ALL_CHANNELS);
      for (const ch of msg.channels) {
        if (ALL_CHANNELS.includes(ch)) ws._channels.add(ch);
      }
    }

    if (msg.action === 'unsubscribe' && Array.isArray(msg.channels)) {
      if (ws._channels) {
        for (const ch of msg.channels) ws._channels.delete(ch);
      }
    }
  });

  ws.on('error', err => logger.warn('[ws] client error', err.message));
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Attach the WebSocket server to an existing http.Server instance.
 * Should be called once, after the HTTP server is created.
 */
function attach(server) {
  wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', onConnection);
  wireEvents();
  logger.info('[ws] WebSocket server attached at /ws');
  return wss;
}

/** Exposed for testing. */
function getServer() { return wss; }

module.exports = { attach, broadcast, getServer };
