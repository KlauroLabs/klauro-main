#!/usr/bin/env node
const { send } = require('./send.js');
const [command] = process.argv.slice(2);
if (command === "send") {
  send();
}
