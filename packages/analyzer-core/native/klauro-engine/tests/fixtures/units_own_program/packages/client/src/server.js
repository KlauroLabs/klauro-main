const express = require('express');
const app = express();
app.get('/notes', (request, response) => response.send('ok'));
module.exports.serve = () => app.listen(8080);
