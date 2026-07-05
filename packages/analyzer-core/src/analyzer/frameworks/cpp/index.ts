export { DrogonAnalyzer } from './drogon-analyzer';
export { CrowAnalyzer } from './crow-analyzer';

// Framework registry for automatic detection
export const CPP_FRAMEWORKS = [
  'drogon-analyzer',
  'crow-analyzer'
];

export const FRAMEWORK_DETECTORS = [
  {
    id: 'drogon',
    analyzerClass: 'DrogonAnalyzer',
    dependencies: ['drogon'],
    patterns: [
      /#include\s*[<"]drogon\//,
      /ADD_METHOD_TO\s*\(/,
      /app\s*\(\s*\)\s*\.\s*registerHandler\s*\(/
    ]
  },
  {
    id: 'crow',
    analyzerClass: 'CrowAnalyzer',
    dependencies: ['crow', 'Crow'],
    patterns: [
      /#include\s*[<"]crow(?:\.h|\/[^">]*)?[>"]/,
      /CROW_ROUTE\s*\(/
    ]
  }
];
