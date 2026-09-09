const express = require('express');
const orderRoutes = require('./routes/orders');
const healthRoutes = require('./routes/health');
const adminRoutes = require('./routes/admin');

const app = express();
app.use(express.json());
app.use('/api', orderRoutes);
app.use('/api', healthRoutes);
app.use('/api/admin', adminRoutes);

// 404
app.use((req, res) => res.status(404).json({ error: 'not found' }));

module.exports = app;
