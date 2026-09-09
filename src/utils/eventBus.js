const { EventEmitter } = require('node:events');

const EVENTS = {
  ORDER_PLACED: 'order:placed',
  TRADES_EXECUTED: 'trades:executed',
  BOOK_UPDATED: 'book:updated',
  CIRCUIT_BREAKER_TRIGGERED: 'circuit_breaker:triggered',
  CIRCUIT_BREAKER_RESET: 'circuit_breaker:reset',
  PRICE_UPDATED: 'price:updated',
};

class EventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100);
  }
}

const eventBus = new EventBus();

module.exports = { eventBus, EventBus, EVENTS };
