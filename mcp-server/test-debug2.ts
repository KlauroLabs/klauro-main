import { loadIncrementalState, loadAnalysis } from './src/storage';
import { ChangeDetector } from '../backend/src/analyzer/core/change-detector';

const projectPath = '/Users/michaelshattuck/dev/unravl/proof-of-concept';

async function test() {
  const previousState = await loadIncrementalState(projectPath);
  const previousOutput = await loadAnalysis(projectPath);
  
  console.log('=== Previous state ===');
  console.log('Has previous state:', !!previousState);
  console.log('Has previous output:', !!previousOutput);
  
  if (previousState) {
    console.log('State version:', previousState.version);
    console.log('Files tracked:', Object.keys(previousState.files).length);
    console.log('Git commit:', previousState.gitCommitHash?.slice(0, 8));
  }
  
  console.log('\n=== Running change detection ===');
  const detector = new ChangeDetector(projectPath);
  const changeSet = await detector.detectChanges(previousState);
  
  console.log('Change set:');
  console.log('  requiresFullRebuild:', changeSet.requiresFullRebuild);
  console.log('  reason:', changeSet.reason);
  console.log('  added:', changeSet.added.length);
  console.log('  modified:', changeSet.modified.length);
  console.log('  deleted:', changeSet.deleted.length);
  console.log('  detection method:', changeSet.detectionMethod);
  
  if (changeSet.modified.length > 0) {
    console.log('  Modified files:', changeSet.modified.slice(0, 10));
  }
}

test().catch(console.error);
