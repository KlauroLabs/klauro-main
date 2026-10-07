const HEARTBEAT_MS = 1000;

function holdLease(store) {
  const timer = setInterval(() => {
    store.touch();
  }, HEARTBEAT_MS);
  return timer;
}

function handleUpload(store) {
  holdLease(store);
  store.save();
}

module.exports = { handleUpload };

const http = require('http');
http.createServer((req, res) => handleUpload(req.store)).listen(3000);
