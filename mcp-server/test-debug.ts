import { analyzeProjectIncremental, getIncrementalState } from './src/analyzer';
import * as fs from 'fs-extra';
import * as path from 'path';

const projectPath = '/Users/michaelshattuck/dev/unravl/proof-of-concept';

async function test() {
  console.log('=== Checking existing state ===');
  
  const existingState = await getIncrementalState(projectPath);
  if (existingState) {
    console.log('State version:', existingState.version);
    console.log('Files tracked:', Object.keys(existingState.files).length);
    console.log('Last analysis:', existingState.lastAnalysisTimestamp);
    console.log('Git commit:', existingState.gitCommitHash?.slice(0, 8));
    console.log('Sample files:', Object.keys(existingState.files).slice(0, 5));
  } else {
    console.log('No existing state found');
  }
  
  console.log('\n=== Running incremental analysis ===');
  const start = Date.now();
  const result = await analyzeProjectIncremental(projectPath);
  console.log('Time:', Date.now() - start, 'ms');
  console.log('Was full rebuild:', result.wasFullRebuild);
  console.log('Change report:', JSON.stringify(result.changeReport.summary, null, 2));
  
  console.log('\n=== Checking state after analysis ===');
  const newState = await getIncrementalState(projectPath);
  if (newState) {
    console.log('State version:', newState.version);
    console.log('Files tracked:', Object.keys(newState.files).length);
  }
}

test().catch(console.error);
