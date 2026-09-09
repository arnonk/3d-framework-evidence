// In-memory order book.
const orderBook = {
  orders: [],        // all orders ever placed
  bySymbol: {},      // symbol -> array of all orders
};

function add(order) {
  orderBook.orders.push(order);
  (orderBook.bySymbol[order.symbol] = orderBook.bySymbol[order.symbol] || []).push(order);
  return order;
}

function find(id) {
  return orderBook.orders.find(o => o.id === id);
}

function all() {
  return orderBook.orders;
}

function getDepth(symbol) {
  const symbolOrders = orderBook.bySymbol[symbol] || [];
  const activeBids = {};
  const activeAsks = {};

  for (const o of symbolOrders) {
    if (o.remainingQty > 0 && o.status !== 'rejected' && o.status !== 'cancelled') {
      if (o.side === 'buy') {
        activeBids[o.price] = (activeBids[o.price] || 0) + o.remainingQty;
      } else if (o.side === 'sell') {
        activeAsks[o.price] = (activeAsks[o.price] || 0) + o.remainingQty;
      }
    }
  }

  const bids = Object.entries(activeBids)
    .map(([p, q]) => [Number(p), q])
    .sort((a, b) => b[0] - a[0]);

  const asks = Object.entries(activeAsks)
    .map(([p, q]) => [Number(p), q])
    .sort((a, b) => a[0] - b[0]);

  return { bids, asks };
}

function clear() {
  orderBook.orders.length = 0;
  for (const key of Object.keys(orderBook.bySymbol)) {
    delete orderBook.bySymbol[key];
  }
}

// Ensure backward compatibility: book.book, book.orders, book.bySymbol, and exported functions
orderBook.book = orderBook;
orderBook.add = add;
orderBook.find = find;
orderBook.all = all;
orderBook.getDepth = getDepth;
orderBook.clear = clear;

module.exports = orderBook;
