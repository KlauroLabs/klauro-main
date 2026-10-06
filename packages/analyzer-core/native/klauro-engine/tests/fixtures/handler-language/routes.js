const express = require('express');
const { sharedHandler } = require('./elsewhere');
const app = express();

app.get('/ping', pingHandler);
app.get('/shared', sharedHandler);
