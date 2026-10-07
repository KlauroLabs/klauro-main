const express = require('express');
const { formatName } = require('../../../packages/shared/src/format.js');
const app = express();
app.get('/greet', (request, response) => response.send(formatName(request.query.name)));
app.listen(8080);
