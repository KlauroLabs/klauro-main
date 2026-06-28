import express from 'express';
import * as fs from 'fs';

const app = express();

// SINK: writes attacker-influenced bytes to the filesystem.
function persistToDisk(path: string, contents: string): void {
  fs.writeFileSync(path, contents);
}

// CROSS-FUNCTION HOP: derives the on-disk path from a caller-supplied name.
function resolveReportPath(name: string): string {
  return `/var/reports/${name}.txt`;
}

// Carries the tainted name from handler to the path builder + write sink.
function saveReport(name: string, body: string): void {
  const target = resolveReportPath(name);
  persistToDisk(target, body);
}

// SOURCE: req.body.filename + req.body.content are user input.
app.post('/reports', (req, res) => {
  const filename = req.body.filename;
  const content = req.body.content;
  saveReport(filename, content);
  res.status(201).end();
});

app.listen(3000);
