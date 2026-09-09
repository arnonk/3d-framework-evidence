// In-memory order book.
const book = {
  orders: [],        // all orders ever placed
  bySymbol: {},      // symbol -> array of all orders
};

function add(order) {
  book.orders.push(order);
  (book.bySymbol[order.symbol] = book.bySymbol[order.symbol] || []).push(order);
  return order;
}

function find(id) {
  return book.orders.find(o => o.id === id);
}

function all() {
  return book.orders;
}

function getRestingOrders(symbol, side) {
  const symbolOrders = book.bySymbol[symbol] || [];
  return symbolOrders.filter(o => o.side === side && (o.remainingQty > 0 || o.status === 'accepted' || o.status === 'open' || o.status === 'partially_filled') && o.status !== 'filled' && o.status !== 'rejected' && o.status !== 'cancelled');
}

// Compute L2 aggregated depth [[price, qty]]
function getDepth(symbol) {
  const symbolOrders = book.bySymbol[symbol] || [];
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

  // Bids descending by price
  const bids = Object.entries(activeBids)
    .map(([p, q]) => [Number(p), q])
    .sort((a, b) => b[0] - a[0]);

  // Asks ascending by price
  const asks = Object.entries(activeAsks)
    .map(([p, q]) => [Number(p), q])
    .sort((a, b) => a[0] - b[0]);

  return { bids, asks };
}

function clear() {
  book.orders.length = 0;
  for (const key of Object.keys(book.bySymbol)) {
    delete book.bySymbol[key];
  }
}

module.exports = { book, add, find, all, getDepth, getRestingOrders, clear };
