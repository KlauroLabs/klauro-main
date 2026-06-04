import { analyzeProjectIncremental, getIncrementalState } from './src/analyzer';
import * as fs from 'fs-extra';
import * as path from 'path';

const projectPath = path.resolve(__dirname, '..');
const testFile = path.join(projectPath, 'packages/analyzer-core/src/analyzer/core/base-analyzer.ts');

async function test() {
  console.log('=== Phase 1: Establish baseline (full analysis) ===');
  const start1 = Date.now();
  const result1 = await analyzeProjectIncremental(projectPath);
  const time1 = Date.now() - start1;
  console.log('Time:', time1, 'ms (was full rebuild:', result1.wasFullRebuild, ')');
  console.log('Nodes:', result1.output.nodes.length);
  console.log('Files in state:', Object.keys(result1.state.files).length);

  await new Promise(r => setTimeout(r, 100));

  console.log('\n=== Phase 2: Immediate re-run (no changes, should be fast) ===');
  const start2 = Date.now();
  const result2 = await analyzeProjectIncremental(projectPath);
  const time2 = Date.now() - start2;
  console.log('Time:', time2, 'ms (was full rebuild:', result2.wasFullRebuild, ')');
  console.log('Changes:', result2.changeReport.summary.filesModified, 'files modified');

  console.log('\n=== Phase 3: Touch a file ===');
  const content = await fs.readFile(testFile, 'utf-8');
  await fs.writeFile(testFile, content + '\n// test increment');

  console.log('\n=== Phase 4: Incremental after file touch ===');
  const start3 = Date.now();
  const result3 = await analyzeProjectIncremental(projectPath);
  const time3 = Date.now() - start3;
  console.log('Time:', time3, 'ms (was full rebuild:', result3.wasFullRebuild, ')');
  console.log('Changes: added=' + result3.changeReport.summary.filesAdded +
              ', modified=' + result3.changeReport.summary.filesModified +
              ', deleted=' + result3.changeReport.summary.filesDeleted);

  await fs.writeFile(testFile, content);

  console.log('\n=== Phase 5: After restore (should use cache) ===');
  const start4 = Date.now();
  const result4 = await analyzeProjectIncremental(projectPath);
  const time4 = Date.now() - start4;
  console.log('Time:', time4, 'ms (was full rebuild:', result4.wasFullRebuild, ')');

  console.log('\n=== Summary ===');
  console.log('Phase 1 (baseline):', time1, 'ms');
  console.log('Phase 2 (no changes):', time2, 'ms');
  console.log('Phase 4 (1 file touched):', time3, 'ms');
  console.log('Phase 5 (restored):', time4, 'ms');
}

test().catch(console.error);
