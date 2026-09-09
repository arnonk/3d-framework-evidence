let nextId = 1; // module-global sequence; resets on restart, fine for now

class Order {
  constructor({ symbol, side, qty, price }) {
    this.id = 'ORD-' + String(nextId++).padStart(6, '0');
    this.symbol = symbol;
    this.side = side;
    this.qty = qty;
    this.price = price;
    this.status = 'accepted';
    this.fee = 0;
    this.createdAt = new Date().toISOString();
  }
}
module.exports = { Order };
