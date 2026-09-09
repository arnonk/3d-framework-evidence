// In-memory order book. Shared mutable module state.
// NOTE: several services import this directly and mutate it.
//
// v2 additions (backward-compatible):
//   - byId Map for O(1) lookup (replaces linear scan in find())
//   - bySymbol kept as-is so existing callers don't break
const book = {
  orders: [],        // all orders ever placed (append-only)
  byId: new Map(),   // id -> order  (O(1) lookup)
  bySymbol: {},      // symbol -> array of orders
};

function add(order) {
  book.orders.push(order);
  book.byId.set(order.id, order);
  (book.bySymbol[order.symbol] = book.bySymbol[order.symbol] || []).push(order);
  return order;
}

function find(id) {
  // O(1) via Map; falls back to linear scan for ids added before the upgrade.
  return book.byId.get(id) ?? book.orders.find((o) => o.id === id);
}

function all() {
  return book.orders;
}

function forSymbol(symbol) {
  return book.bySymbol[symbol] || [];
}

module.exports = { book, add, find, all, forSymbol };
