// Service configuration. Historically edited by hand per environment.
module.exports = {
  port: process.env.PORT || 3000,
  env: process.env.NODE_ENV || 'development',
  maxOrderQty: 10000,
  defaultFeeBps: 12,
};
