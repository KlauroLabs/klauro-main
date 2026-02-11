import { analyzeProjectIncremental } from './mcp-server/src/analyzer';
import * as fs from 'fs-extra';
import * as path from 'path';

const projectPath = '/Users/michaelshattuck/dev/unravl/proof-of-concept';
const testFile = path.join(projectPath, 'backend/src/analyzer/core/base-analyzer.ts');

async function test() {
  console.log('Starting incremental analysis test...');
  console.log('');
  
  // First run - should populate cache
  console.log('Run 1: Fresh incremental analysis (should populate cache)');
  const start1 = Date.now();
  const result1 = await analyzeProjectIncremental(projectPath);
  const time1 = Date.now() - start1;
  console.log(`  Time: ${time1}ms`);
  console.log(`  Was full rebuild: ${result1.wasFullRebuild}`);
  console.log(`  Nodes: ${result1.output.nodes.length}`);
  console.log('');
  
  // Touch a file to trigger change detection
  const content = await fs.readFile(testFile, 'utf-8');
  await fs.writeFile(testFile, content + '\n// test');
  
  // Second run - should use cache for unchanged files
  console.log('Run 2: After touching base-analyzer.ts (should use cache for other files)');
  const start2 = Date.now();
  const result2 = await analyzeProjectIncremental(projectPath);
  const time2 = Date.now() - start2;
  console.log(`  Time: ${time2}ms`);
  console.log(`  Was full rebuild: ${result2.wasFullRebuild}`);
  console.log(`  Changes: ${result2.changeReport.summary.filesModified} modified`);
  console.log('');
  
  // Restore the file
  await fs.writeFile(testFile, content);
  
  // Third run - should get cache hit for base-analyzer.ts
  console.log('Run 3: After restoring file (should get cache hit for everything)');
  const start3 = Date.now();
  const result3 = await analyzeProjectIncremental(projectPath);
  const time3 = Date.now() - start3;
  console.log(`  Time: ${time3}ms`);
  console.log(`  Was full rebuild: ${result3.wasFullRebuild}`);
  console.log(`  Changes: ${result3.changeReport.summary.filesModified} modified`);
  console.log('');
  
  console.log('Summary:');
  console.log(`  Run 1 (populate cache): ${time1}ms`);
  console.log(`  Run 2 (1 file changed): ${time2}ms`);
  console.log(`  Run 3 (cache hit): ${time3}ms`);
}

test().catch(console.error);
