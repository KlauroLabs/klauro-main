const { spawn } = require('child_process');
const http = require('http');

function runTask() {
  const child = spawn('ls');
  child.on('exit', () => {
    console.log('done');
  });
  child.stdout.on('data', (chunk) => {
    console.log(chunk);
  });
}

function watchShutdown() {
  process.on('SIGTERM', () => {
    console.log('shutting down');
  });
}

function serve() {
  const server = http.createServer();
  server.on('request', (req, res) => {
    res.end('ok');
  });
}
