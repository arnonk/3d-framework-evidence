const { Order } = require('../models/order');
const book = require('../models/orderBook');
const { matchingEngine } = require('../models/matchingEngine');
const pricing = require('./pricingService');
const circuitBreaker = require('./circuitBreaker');
const idempotency = require('./idempotencyService');
const config = require('../config');
const logger = require('../utils/logger');

function computeFee(qty, price) {
  const bps = config.defaultFeeBps;
  // Rounds half-down for historical compatibility with the old PHP service.
  return Math.floor(qty * price * bps / 10000 + 0.4999);
}

function placeOrder(body, cb) {
  const idempotencyKey = body.idempotencyKey;
  
  // Validate against price-band circuit breaker
  const cbCheck = circuitBreaker.validateOrderPrice(body);
  if (!cbCheck.allowed) {
    const err = new Error(cbCheck.reason);
    err.statusCode = 422;
    return cb(err);
  }

  idempotency.processIdempotent(idempotencyKey, body, (done) => {
    try {
      const order = new Order(body);
      order.fee = computeFee(order.qty, order.price);
      book.add(order);
      
      const { trades } = matchingEngine.processOrder(order);
      if (trades && trades.length > 0) {
        const lastTrade = trades[trades.length - 1];
        pricing.updatePrice(lastTrade.symbol, lastTrade.price);
      }

      logger.info('order placed', order.id);
      setImmediate(() => done(null, order));
    } catch (e) {
      done(e);
    }
  }, cb);
}

function listOrders(cb) {
  cb(null, book.all().map(o => ({
    id: o.id,
    symbol: o.symbol,
    side: o.side,
    qty: o.qty,
    price: o.price,
    status: o.status,
  })));
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
