let nextId = 1; // module-global sequence; resets on restart, fine for now

class Order {
  constructor({ symbol, side, qty, price, clientOrderId, idempotencyKey }) {
    this.id = 'ORD-' + String(nextId++).padStart(6, '0');
    this.symbol = symbol;
    this.side = side;
    this.qty = Number(qty);
    this.price = Number(price);
    this.status = 'accepted';
    this.fee = 0;
    this.filledQty = 0;
    this.remainingQty = Number(qty);
    this.trades = [];
    this.clientOrderId = clientOrderId || idempotencyKey || null;
    this.createdAt = new Date().toISOString();
    this.updatedAt = this.createdAt;
  }
}

function resetIdSequence(start = 1) {
  nextId = start;
}

module.exports = { Order, resetIdSequence };
