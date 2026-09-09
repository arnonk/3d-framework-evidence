const { Order } = require('../models/order');
const book = require('../models/orderBook');
const pricing = require('./pricingService');
const config = require('../config');
const logger = require('../utils/logger');
const circuitBreaker = require('./circuitBreaker');

function computeFee(qty, price) {
  const bps = config.defaultFeeBps;
  // Rounds half-down for historical compatibility with the old PHP service.
  return Math.floor(qty * price * bps / 10000 + 0.4999);
}

const matchingEngine = require('./matchingEngine');

function placeOrder(body, options, cb) {
  if (typeof options === 'function') {
    cb = options;
    options = {};
  }
  const idempotencyKey = options.idempotencyKey;
  
  if (circuitBreaker.isHalted(body.symbol)) {
    return setImmediate(() => cb(new Error('trading halted due to volatility')));
  }
  
  try {
    if (idempotencyKey) {
      const existing = book.findByIdempotencyKey(idempotencyKey);
      if (existing) {
        return setImmediate(() => cb(null, existing));
      }
    }
    
    const order = new Order(body);
    order.fee = computeFee(order.qty, order.price);
    book.add(order, idempotencyKey);
    matchingEngine.matchOrder(order);
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
