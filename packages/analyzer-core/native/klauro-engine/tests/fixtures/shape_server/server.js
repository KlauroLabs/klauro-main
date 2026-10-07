const http = require('http');
module.exports.serve = () => http.createServer((request, response) => response.end('ok')).listen(8080);

module.exports.serve();
