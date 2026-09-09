let nextId = 1;

class Order {
  constructor({ symbol, side, qty, price, idempotencyKey }) {
    this.id = 'ORD-' + String(nextId++).padStart(6, '0');
    this.symbol = symbol;
    this.side = side;
    this.qty = Number(qty);
    this.price = Number(price);
    this.status = 'accepted';
    this.fee = 0;
    this.filledQty = 0;
    this.remainingQty = Number(qty);
    this.idempotencyKey = idempotencyKey || null;
    this.createdAt = new Date().toISOString();
  }
}

function resetNextId() {
  nextId = 1;
}

module.exports = { Order, resetNextId };
