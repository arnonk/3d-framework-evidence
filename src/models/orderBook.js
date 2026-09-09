const book = {
  orders: [],        // all orders ever placed
  idempotencyKeys: {}, // key -> order
  bids: {},          // symbol -> active buy orders
  asks: {}           // symbol -> active sell orders
};

function add(order, idempotencyKey = null) {
  book.orders.push(order);
  if (idempotencyKey) {
    book.idempotencyKeys[idempotencyKey] = order;
  }
  return order;
}

function addActive(order) {
  if (order.side === 'buy') {
    book.bids[order.symbol] = book.bids[order.symbol] || [];
    book.bids[order.symbol].push(order);
    book.bids[order.symbol].sort((a, b) => b.price - a.price || a.id.localeCompare(b.id));
  } else {
    book.asks[order.symbol] = book.asks[order.symbol] || [];
    book.asks[order.symbol].push(order);
    book.asks[order.symbol].sort((a, b) => a.price - b.price || a.id.localeCompare(b.id));
  }
}

function removeActive(order) {
  if (order.side === 'buy' && book.bids[order.symbol]) {
    book.bids[order.symbol] = book.bids[order.symbol].filter(o => o.id !== order.id);
  } else if (order.side === 'sell' && book.asks[order.symbol]) {
    book.asks[order.symbol] = book.asks[order.symbol].filter(o => o.id !== order.id);
  }
}

function find(id) {
  return book.orders.find(o => o.id === id);
}

function findByIdempotencyKey(key) {
  return book.idempotencyKeys[key];
}

function all() {
  return book.orders;
}

module.exports = { book, add, find, findByIdempotencyKey, all, addActive, removeActive };
