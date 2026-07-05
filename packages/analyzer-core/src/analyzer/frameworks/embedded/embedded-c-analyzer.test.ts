import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EmbeddedCAnalyzer } from './embedded-c-analyzer';

function makeTempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'embedded-c-analyzer-test-'));

  const mainC = [
    '#include <avr/io.h>',
    '#include <avr/interrupt.h>',
    '',
    'volatile uint8_t counter = 0;',
    '',
    'ISR(TIMER0_OVF_vect) {',
    '  counter++;',
    '}',
    '',
    'int main(void) {',
    '  DDRB |= (1 << PB0);',
    '  sei();',
    '  while (1) {',
    '    if (counter > 100) {',
    '      PORTB ^= (1 << PB0);',
    '      counter = 0;',
    '    }',
    '  }',
    '  return 0;',
    '}',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'main.c'), mainC);

  return dir;
}

test('EmbeddedCAnalyzer canAnalyze detects AVR interrupt/io evidence', async () => {
  const dir = makeTempProject();
  const analyzer = new EmbeddedCAnalyzer();
  assert.equal(await analyzer.canAnalyze(dir), true);
});

test('EmbeddedCAnalyzer surfaces main() super-loop as lifecycle and ISR as interrupt entry point', async () => {
  const dir = makeTempProject();
  const analyzer = new EmbeddedCAnalyzer();
  const cas = await analyzer.analyze({ projectPath: dir });

  const entryPoints = cas.entry_points || [];
  const lifecycle = entryPoints.find(ep => ep.type === 'lifecycle');
  const interrupt = entryPoints.find(ep => ep.type === 'interrupt');

  assert.ok(lifecycle, 'expected a lifecycle entry point for the super-loop main()');
  assert.equal(lifecycle?.handler?.method_name, 'main');

  assert.ok(interrupt, 'expected an interrupt entry point for the ISR');
  assert.equal(interrupt?.metadata?.vector, 'TIMER0_OVF_vect');
});
