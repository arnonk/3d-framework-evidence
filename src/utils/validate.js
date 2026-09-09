const config = require('../config');

function validateOrder(body) {
  if (!body || typeof body !== 'object') return 'body required';
  if (!body.symbol || typeof body.symbol !== 'string') return 'symbol required';
  if (body.side !== 'buy' && body.side !== 'sell') return 'side must be buy|sell';
  if (!Number.isFinite(body.qty) || body.qty <= 0) return 'qty must be positive';
  if (body.qty > config.maxOrderQty) return 'qty exceeds max';
  if (!Number.isFinite(body.price) || body.price <= 0) return 'price must be positive';
  return null;
}

module.exports = { validateOrder };
