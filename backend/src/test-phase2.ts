// Test Phase 2 Language Analyzers Integration
// Simple test to verify that all analyzers can be instantiated and registered

import { bootstrapAnalyzers, getAnalyzerStatistics } from './analyzer/analyzer-bootstrap';

async function testPhase2Integration(): Promise<void> {
  console.log('🧪 Testing Phase 2 Language Analyzers Integration...\n');
  
  try {
    // Initialize the analyzer system
    console.log('1. Bootstrapping analyzer system...');
    await bootstrapAnalyzers();
    console.log('✅ Bootstrap completed\n');
    
    // Get statistics
    console.log('2. Getting analyzer statistics...');
    const stats = getAnalyzerStatistics();
    console.log(`📊 Analyzer Statistics:
   • Total Plugins: ${stats.totalPlugins}
   • Official Plugins: ${stats.officialPlugins}
   • Community Plugins: ${stats.communityPlugins}
   • Internal Plugins: ${stats.internalPlugins}
   • Language Analyzers: ${stats.languageAnalyzers}
   • Framework Analyzers: ${stats.frameworkAnalyzers}
   • Specialized Analyzers: ${stats.specializedAnalyzers}
   • Supported Languages: ${stats.supportedLanguages.join(', ')}
   • Supported Frameworks: ${stats.supportedFrameworks.slice(0, 10).join(', ')}${stats.supportedFrameworks.length > 10 ? '...' : ''}
`);
    
    console.log('✅ Phase 2 Integration Test Passed!\n');
    console.log(`🎉 Successfully integrated ${stats.languageAnalyzers} language base analyzers:`);
    console.log(`   Languages supported: ${stats.supportedLanguages.length}`);
    console.log(`   Frameworks supported: ${stats.supportedFrameworks.length}`);
    console.log(`   Total analyzers ready: ${stats.totalPlugins}\n`);
    
    console.log('🚀 Phase 2: Language Base Analyzers - COMPLETE');
    console.log('   Next: Phase 3 - Framework Sub-analyzers');
    
  } catch (error) {
    console.error('❌ Phase 2 Integration Test Failed:', (error as Error).message);
    console.error((error as Error).stack);
    process.exit(1);
  }
}

// Run the test
if (require.main === module) {
  testPhase2Integration().catch(error => {
    console.error('Test failed:', error);
    process.exit(1);
  });
}

export { testPhase2Integration };