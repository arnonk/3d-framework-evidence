// In-memory order book. Shared mutable module state (legacy design – kept as-is).
// NOTE: several services import this directly and mutate it.
//
// Extended with an EventEmitter so the WebSocket broadcaster can subscribe to
// mutations without the book having to know about WebSockets.
const { EventEmitter } = require('events');

const emitter = new EventEmitter();

const book = {
  orders: [],        // all orders ever placed
  bySymbol: {},      // symbol -> array of orders
};

function add(order) {
  book.orders.push(order);
  (book.bySymbol[order.symbol] = book.bySymbol[order.symbol] || []).push(order);
  emitter.emit('order_added', order);
  return order;
}

function update(order) {
  // Called when status / fields on an already-stored order change.
  emitter.emit('order_updated', order);
  return order;
}

function find(id) {
  return book.orders.find(o => o.id === id);
}

function all() {
  return book.orders;
}

module.exports = { book, add, update, find, all, emitter };
