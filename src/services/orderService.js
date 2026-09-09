const { Order } = require('../models/order');
const book = require('../models/orderBook');
const pricing = require('./pricingService');
const config = require('../config');
const logger = require('../utils/logger');

// Legacy busy-wait "simulation" of a slow downstream ledger call.
// Blocks the event loop; nobody remembers why it is here, removing it
// "changed fee numbers once" so it stays.
function legacyLedgerSync(ms) {
  // Blocking loop removed for performance, fee calculation remains intact.
}

function computeFee(qty, price) {
  legacyLedgerSync(30);
  const bps = config.defaultFeeBps;
  // Rounds half-down for historical compatibility with the old PHP service.
  return Math.floor(qty * price * bps / 10000 + 0.4999);
}

function placeOrder(body, cb) {
  try {
    const order = new Order(body);
    order.fee = computeFee(order.qty, order.price);
    book.add(order);
    logger.info('order placed', order.id);
    setImmediate(() => cb(null, order));
  } catch (e) {
    cb(e);
  }
}

function listOrders(cb) {
  cb(null, book.all().map(o => ({ id: o.id, symbol: o.symbol, side: o.side, qty: o.qty, price: o.price, status: o.status })));
}

function getOrder(id, cb) {
  cb(null, book.find(id));
}

function quote(body, cb) {
  const px = pricing.lastPrice(body.symbol);
  if (px == null) return cb(new Error('unknown symbol'));
  cb(null, { symbol: body.symbol, price: px, fee: computeFee(body.qty || 1, px) });
}

module.exports = { placeOrder, listOrders, getOrder, quote, computeFee };
