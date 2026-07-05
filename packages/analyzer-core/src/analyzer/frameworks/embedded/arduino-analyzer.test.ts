import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ArduinoAnalyzer } from './arduino-analyzer';

function makeTempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arduino-analyzer-test-'));

  const sketch = [
    '#include <Arduino.h>',
    '',
    'void blinkTask(void *pvParameters) {',
    '  for (;;) {',
    '    digitalWrite(LED_BUILTIN, HIGH);',
    '    delay(500);',
    '    digitalWrite(LED_BUILTIN, LOW);',
    '    delay(500);',
    '  }',
    '}',
    '',
    'void setup() {',
    '  pinMode(LED_BUILTIN, OUTPUT);',
    '  xTaskCreate(blinkTask, "Blink", 1024, NULL, 1, NULL);',
    '}',
    '',
    'void loop() {',
    '  // main loop intentionally left idle; blinking handled by RTOS task',
    '}',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'sketch.ino'), sketch);

  return dir;
}

test('ArduinoAnalyzer canAnalyze detects a .ino sketch', async () => {
  const dir = makeTempProject();
  const analyzer = new ArduinoAnalyzer();
  assert.equal(await analyzer.canAnalyze(dir), true);
});

test('ArduinoAnalyzer surfaces setup/loop as lifecycle entry points and xTaskCreate target as a task entry point', async () => {
  const dir = makeTempProject();
  const analyzer = new ArduinoAnalyzer();
  const cas = await analyzer.analyze({ projectPath: dir });

  const entryPoints = cas.entry_points || [];
  const setupEp = entryPoints.find(ep => ep.metadata?.hook === 'setup');
  const loopEp = entryPoints.find(ep => ep.metadata?.hook === 'loop');
  const taskEp = entryPoints.find(ep => ep.type === 'task');

  assert.ok(setupEp, 'expected setup() lifecycle entry point');
  assert.equal(setupEp?.type, 'lifecycle');
  assert.ok(loopEp, 'expected loop() lifecycle entry point');
  assert.equal(loopEp?.type, 'lifecycle');

  assert.ok(taskEp, 'expected blinkTask entry point from xTaskCreate');
  assert.equal(taskEp?.handler?.method_name, 'blinkTask');
});
