import * as fs from 'node:fs';
import * as path from 'node:path';
import { TreeSitterTSExtractor } from '../../analyzer/core/tree-sitter-ts-extractor';

describe('TreeSitterTSExtractor output parity', () => {
  it('matches the extraction produced by the pre-optimization implementation', () => {
    const fixturePath = path.join(__dirname, '..', 'fixtures', 'tree-sitter-ts-extractor-parity.fixture.txt');
    const baselinePath = path.join(__dirname, '..', 'fixtures', 'tree-sitter-ts-extractor-parity.baseline.json');
    const source = fs.readFileSync(fixturePath, 'utf8');
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));

    const extraction = new TreeSitterTSExtractor().extractFromSource(source, 'golden.ts');

    expect(extraction).toEqual(baseline.output);
  });
});
