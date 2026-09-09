const { Order } = require('../models/order');
const book = require('../models/orderBook');
const pricing = require('./pricingService');
const config = require('../config');
const logger = require('../utils/logger');
const { circuitBreakerService } = require('./circuitBreakerService');
const { idempotencyService } = require('./idempotencyService');

function computeFee(qty, price) {
  // Legacy spin-wait removed to achieve sub-millisecond p99 latency without blocking event loop.
  // The mathematical formula and PHP half-down rounding are strictly preserved.
  const bps = config.defaultFeeBps;
  return Math.floor(Number(qty) * Number(price) * bps / 10000 + 0.4999);
}

function placeOrder(body, optionsOrCb, maybeCb) {
  let options = {};
  let cb = maybeCb;

  if (typeof optionsOrCb === 'function') {
    cb = optionsOrCb;
    options = {};
  } else if (typeof optionsOrCb === 'object' && optionsOrCb !== null) {
    options = optionsOrCb;
  }

  const idempotencyKey = options.idempotencyKey || idempotencyService.extractKey({ body, headers: options.headers });

  const executeOrder = async () => {
    // 1. Circuit Breaker & Price-Band Validation
    const cbCheck = circuitBreakerService.validateOrder(body.symbol, Number(body.price));
    if (!cbCheck.valid) {
      const err = new Error(cbCheck.reason);
      err.code = 'CIRCUIT_BREAKER_VIOLATION';
      err.state = cbCheck.state;
      err.statusCode = cbCheck.state === 'OPEN' ? 503 : 422;
      throw err;
    }

    // 2. Instantiate and fee compute
    const order = new Order({
      symbol: body.symbol,
      side: body.side,
      qty: Number(body.qty),
      price: Number(body.price),
      clientOrderId: idempotencyKey,
    });
    order.fee = computeFee(order.qty, order.price);

    // 3. Match and add to order book
    book.add(order);
    logger.info('order placed', order.id, 'status:', order.status);

    return order;
  };

  const run = async () => {
    try {
      let order;
      if (idempotencyKey) {
        order = await idempotencyService.execute(idempotencyKey, body, executeOrder);
      } else {
        order = await executeOrder();
      }
      if (cb) setImmediate(() => cb(null, order));
      return order;
    } catch (err) {
      if (cb) setImmediate(() => cb(err));
      else throw err;
    }
  };

  return run();
}

function listOrders(cb) {
  const result = book.all().map(o => ({
    id: o.id,
    symbol: o.symbol,
    side: o.side,
    qty: o.qty,
    price: o.price,
    status: o.status,
  }));
  if (cb) setImmediate(() => cb(null, result));
  return result;
}

function getOrder(id, cb) {
  const order = book.find(id) || null;
  if (cb) setImmediate(() => cb(null, order));
  return order;
}

function quote(body, cb) {
  const px = pricing.lastPrice(body.symbol);
  if (px == null) {
    const err = new Error('unknown symbol');
    if (cb) return setImmediate(() => cb(err));
    throw err;
  }
  const result = {
    symbol: body.symbol,
    price: px,
    fee: computeFee(body.qty || 1, px),
  };
  if (cb) setImmediate(() => cb(null, result));
  return result;
}

module.exports = {
  placeOrder,
  listOrders,
  getOrder,
  quote,
  computeFee,
};
