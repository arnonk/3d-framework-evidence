const express = require('express');
const orderRoutes = require('./routes/orders');
const healthRoutes = require('./routes/health');

const app = express();
app.use(express.json());
app.use('/api', orderRoutes);
app.use('/api', healthRoutes);

// 404
app.use((req, res) => res.status(404).json({ error: 'not found' }));

module.exports = app;
