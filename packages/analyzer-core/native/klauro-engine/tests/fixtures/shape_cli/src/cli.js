#!/usr/bin/env node
const fs = require("fs");
const [command, text] = process.argv.slice(2);
if (command === "add") {
  fs.appendFileSync("notes.txt", text + "\n");
} else if (command === "list") {
  console.log(fs.readFileSync("notes.txt", "utf8"));
}
