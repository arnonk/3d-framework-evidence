// In-memory order book. Shared mutable module state.
// NOTE: several services import this directly and mutate it.
const book = {
  orders: [],        // all orders ever placed
  bySymbol: {},      // symbol -> array of orders
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

module.exports = { book, add, find, all };
