const express = require('express');
const users = require('./routes/users');
const orders = require('./routes/orders');

const app = express();
app.use('/api/users', users);
app.use('/api/orders', orders);
app.get('/health', (req, res) => res.send('ok'));

module.exports = app;
