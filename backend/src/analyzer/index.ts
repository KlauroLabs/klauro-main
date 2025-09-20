// Main exports from the analyzer module
export { BaseAnalyzer, CASAnalysisResult, CASNode, CASEdge, AnalysisContext } from './core/base-analyzer';
export { AnalyzerOrchestrator, CASOutput, AnalyzerRegistration } from './core/orchestrator';
export { AnalyzerError } from './core/errors';
export { CASAnalyzerService } from './services/cas-analyzer.service';

// Export all language analyzers
export * from './languages';

// Export pattern detectors
export { PatternDetector } from './patterns/pattern-detector';