# Analyzer Orchestration & Determination Algorithm

## Overview

This document describes how Unravl determines which analyzers to run on a codebase and how multiple analyzers work together to produce a unified Code Analysis Specification (CAS) output.

## Analyzer Types

Unravl uses a multi-layered analyzer system where each layer provides increasingly specific insights:

### 1. Language Analyzers (Base Layer)
- **Purpose**: Parse and understand language-specific syntax and constructs
- **Examples**: TypeScript, Python, Java, Go, Rust, C#, PHP
- **Responsibility**: Create base nodes for functions, classes, variables, imports
- **Level Range**: Typically levels 3-5 (code elements → implementation)

### 2. Framework Analyzers (Enhancement Layer)
- **Purpose**: Understand framework-specific patterns and architectures
- **Examples**: React, NestJS, Django, Spring Boot, Rails, Express
- **Responsibility**: Enhance nodes with framework context, create architectural nodes
- **Level Range**: Typically levels 1-3 (system → architectural → code)
- **Dependencies**: Requires corresponding language analyzer

### 3. Library Analyzers (Specialization Layer)
- **Purpose**: Understand library-specific patterns and usage
- **Examples**: Redux, MikroORM, Mongoose, Sequelize, Passport
- **Responsibility**: Add library-specific nodes and relationships
- **Level Range**: Varies by library (usually levels 2-4)
- **Dependencies**: Requires language analyzer, may require framework analyzer

### 4. Pattern Analyzers (Cross-cutting)
- **Purpose**: Detect design patterns, anti-patterns, and architectural styles
- **Examples**: Repository pattern, MVC, Microservices, Event-driven
- **Responsibility**: Tag nodes with pattern information, create pattern relationships
- **Level Range**: All levels
- **Dependencies**: Works on top of other analyzer outputs

## Analyzer Determination Algorithm

```typescript
interface AnalyzerDetermination {
  detectAnalyzers(projectPath: string): AnalyzerSet;
  orderAnalyzers(analyzers: AnalyzerSet): AnalyzerChain;
  orchestrateAnalysis(chain: AnalyzerChain): CASOutput;
}
```

### Phase 1: Detection

1. **File System Scan**
   ```
   - Look for manifest files (package.json, requirements.txt, pom.xml, go.mod)
   - Scan file extensions to determine languages
   - Check for configuration files (tsconfig.json, .eslintrc, webpack.config)
   - Identify framework markers (next.config.js, nest-cli.json, django settings.py)
   ```

2. **Language Detection**
   ```
   Priority Order:
   1. Manifest files (most reliable)
   2. File extensions weighted by count
   3. Shebang lines in scripts
   4. File content patterns
   ```

3. **Framework Detection**
   ```
   For each detected language:
   - Check dependencies in manifest files
   - Look for framework-specific files/folders
   - Scan imports in entry files
   - Check for framework decorators/annotations
   ```

4. **Library Detection**
   ```
   - Parse all dependency lists
   - Match against known library analyzers
   - Check import statements for usage confirmation
   - Verify library is actually used (not just installed)
   ```

### Phase 2: Ordering

Analyzers run in dependency order:

```
1. Language Analyzers (parallel by language)
   ↓
2. Framework Analyzers (parallel by framework)
   ↓
3. Library Analyzers (parallel by library)
   ↓
4. Pattern Analyzers (sequential)
   ↓
5. Integration Analyzer (merges all outputs)
```

### Phase 3: Orchestration

```typescript
async function orchestrateAnalysis(projectPath: string): Promise<CASOutput> {
  // Phase 1: Detection
  const detected = await detectAnalyzers(projectPath);

  // Phase 2: Language Analysis (Base)
  const languageResults = await Promise.all(
    detected.languages.map(lang => lang.analyze(projectPath))
  );

  // Merge language results
  let casOutput = mergeLanguageResults(languageResults);

  // Phase 3: Framework Enhancement
  const frameworkResults = await Promise.all(
    detected.frameworks.map(fw => fw.enhance(casOutput, projectPath))
  );

  // Merge framework enhancements
  casOutput = mergeFrameworkEnhancements(casOutput, frameworkResults);

  // Phase 4: Library Specialization
  const libraryResults = await Promise.all(
    detected.libraries.map(lib => lib.enhance(casOutput, projectPath))
  );

  // Merge library specializations
  casOutput = mergeLibraryEnhancements(casOutput, libraryResults);

  // Phase 5: Pattern Detection
  for (const patternAnalyzer of detected.patterns) {
    casOutput = await patternAnalyzer.detect(casOutput);
  }

  // Phase 6: Final Integration
  casOutput = await integrateAndValidate(casOutput);

  return casOutput;
}
```

## Merge Strategy

When multiple analyzers contribute to the same node:

### Node Merging Rules

1. **ID Conflicts**: Same ID = same node, merge metadata
2. **Level Assignment**: Use the most specific analyzer's level
3. **Priority**: Framework > Library > Language > Pattern
4. **Metadata Merge**:
   - Arrays: Concatenate and deduplicate
   - Objects: Deep merge with priority order
   - Primitives: Higher priority wins
   - Descriptions: Concatenate with separator

### Edge Merging Rules

1. **Duplicate Edges**: Increase confidence/weight
2. **Conflicting Types**: Keep both, tag as multi-type
3. **Metadata**: Merge same as nodes

### Example Merge Scenario

```typescript
// TypeScript Analyzer creates:
{
  id: "class_UserService",
  name: "UserService",
  type: "class",
  level: 3,
  metadata: { language: "typescript" }
}

// NestJS Analyzer enhances:
{
  id: "class_UserService",
  type: "service",
  level: 2,
  metadata: {
    framework: "nestjs",
    injectable: true,
    providers: ["UserRepository"]
  }
}

// Merged Result:
{
  id: "class_UserService",
  name: "UserService",
  type: "service",  // Framework wins
  level: 2,          // Framework wins
  metadata: {
    language: "typescript",
    framework: "nestjs",
    injectable: true,
    providers: ["UserRepository"]
  }
}
```

## Analyzer Registration

New analyzers register themselves with capabilities:

```typescript
interface AnalyzerRegistration {
  id: string;
  name: string;
  type: "language" | "framework" | "library" | "pattern";
  version: string;

  // Detection
  detectPatterns: {
    files?: string[];        // Files that indicate this analyzer applies
    dependencies?: string[];  // Package dependencies
    imports?: string[];       // Import patterns
    content?: RegExp[];       // Content patterns
  };

  // Dependencies
  requires?: string[];       // Other analyzers required
  enhances?: string[];       // Analyzers this can enhance

  // Capabilities
  capabilities: {
    createNodes: string[];    // Node types this creates
    createEdges: string[];    // Edge types this creates
    levels: number[];         // Levels this analyzer uses
    entryPoints: boolean;     // Can detect entry points
    exitPoints: boolean;      // Can detect exit points
  };

  // Execution
  analyze: (context: AnalysisContext) => Promise<CASContribution>;
}
```

## Configuration

Analyzer behavior can be configured via `.unravl.yml`:

```yaml
analyzers:
  # Force enable/disable specific analyzers
  enable:
    - typescript
    - nestjs
    - react
  disable:
    - deprecated-analyzer

  # Analyzer-specific options
  options:
    typescript:
      includeTests: true
      maxComplexity: 10
    nestjs:
      detectMicroservices: true
    react:
      componentDetection: "aggressive"

  # Performance settings
  performance:
    parallel: true
    maxWorkers: 4
    timeout: 300000  # 5 minutes

  # Output preferences
  output:
    maxLevels: 7
    includeSourceCode: false
    minConfidence: 0.7
```

## Analyzer Communication

Analyzers communicate through the CAS structure:

1. **Language analyzers** create the foundation
2. **Framework analyzers** query existing nodes and enhance them
3. **Library analyzers** add specialized relationships
4. **Pattern analyzers** tag and categorize

Each analyzer can:
- Query existing nodes by type, level, or metadata
- Add new nodes at any level
- Enhance existing nodes with metadata
- Create new edges between nodes
- Add entry/exit points
- Contribute to external service definitions

## Quality Assurance

### Analyzer Validation

Each analyzer must:
1. Produce valid CAS output (validated against schema)
2. Include confidence scores for uncertain detections
3. Handle errors gracefully (partial analysis is better than failure)
4. Provide analyzer metadata in contributions
5. Respect level hierarchy (child level > parent level)

### Conflict Resolution

When analyzers conflict:
1. Log the conflict for debugging
2. Use confidence scores to determine winner
3. Preserve both pieces of information when possible
4. Mark nodes with conflict metadata for review

### Performance Monitoring

Track for each analyzer:
- Execution time
- Memory usage
- Nodes/edges created
- Error rate
- Contribution quality score

## Future Extensibility

The system is designed to support:

1. **Custom Analyzers**: Users can add domain-specific analyzers
2. **AI-Enhanced Analysis**: ML models can contribute insights
3. **Remote Analyzers**: Analyzers can run as separate services
4. **Incremental Analysis**: Only re-analyze changed portions
5. **Cross-Repository**: Analyzers that understand multi-repo systems

## Testing

Analyzer integration tests verify:
1. Correct detection on sample projects
2. Proper ordering and dependencies
3. Successful merging of outputs
4. Performance within limits
5. Graceful degradation on errors

---

This orchestration ensures that Unravl can understand any codebase by combining the insights of multiple specialized analyzers into a single, comprehensive CAS output.