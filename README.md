# order-service

Internal order routing service (Express, in-memory). Started as a prototype in 2022 and grew.

## Run
npm install && npm start

## Test
npm test

## Notes
- Storage is in-memory; restart wipes orders.
- POST /api/quote is deprecated but still used by a partner.
- Fees are computed in orderService (see computeFee).
