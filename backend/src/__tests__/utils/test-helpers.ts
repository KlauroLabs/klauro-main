/**
 * Test helper utilities for Rust analyzer tests
 */

export interface MockRustFile {
  path: string;
  content: string;
  exists: boolean;
}

export interface MockCargoToml {
  content: string;
  exists: boolean;
}

/**
 * Create mock Rust file for testing
 */
export function createMockRustFile(path: string, content: string): MockRustFile {
  return {
    path,
    content,
    exists: true
  };
}

/**
 * Create mock Cargo.toml for testing
 */
export function createMockCargoToml(dependencies: string[] = []): MockCargoToml {
  const depsSection = dependencies.length > 0 ? 
    dependencies.map(dep => `${dep} = "1.0"`).join('\n') : '';
  
  const content = `[package]
name = "test-project"
version = "0.1.0"
edition = "2021"

[dependencies]
${depsSection}`;

  return {
    content,
    exists: true
  };
}

/**
 * Setup mock file system
 */
export function setupMockFileSystem(files: MockRustFile[], cargoToml?: MockCargoToml): void {
  const fs = require('fs');
  const glob = require('glob');
  
  // Mock glob.sync
  (glob as jest.MockedFunction<typeof glob>).mockImplementation((pattern, options) => {
    return files.filter(f => {
      // Simple path matching for test files
      const pathParts = f.path.split('/');
      const fileName = pathParts[pathParts.length - 1];
      return fileName.includes(pattern.replace('**/*.rs', '')) || fileName === pattern.replace('**/*.rs', '');
    }).map(f => f.path);
  });

  // Mock fs.promises.readFile
  const readFile = fs.promises.readFile as jest.MockedFunction<typeof fs.promises.readFile>;
  readFile.mockImplementation((filePath: string) => {
    const file = files.find(f => f.path === filePath);
    if (file) {
      return Promise.resolve(file.content);
    }
    
    if (filePath.includes('Cargo.toml') && cargoToml) {
      return Promise.resolve(cargoToml.content);
    }
    
    return Promise.reject(new Error('File not found'));
  });

  // Mock fs.promises.access
  const access = fs.promises.access as jest.MockedFunction<typeof fs.promises.access>;
  access.mockImplementation((filePath: string) => {
    const file = files.find(f => f.path === filePath);
    if (file && file.exists) {
      return Promise.resolve();
    }
    
    if (filePath.includes('Cargo.toml') && cargoToml?.exists) {
      return Promise.resolve();
    }
    
    return Promise.reject(new Error('File not found'));
  });
}

/**
 * Clean up mocks
 */
export function cleanupMocks(): void {
  jest.restoreAllMocks();
}

/**
 * Extract content between rust doc comments
 */
export function extractRustDocContent(content: string): string {
  const lines = content.split('\n');
  const docLines: string[] = [];
  let inDoc = false;

  for (const line of lines) {
    if (line.trim().startsWith('///') || line.trim().startsWith('//!')) {
      inDoc = true;
      const commentText = line.replace(/^\/\/[\/!]\s*/, '');
      if (commentText) {
        docLines.push(commentText);
      }
    } else if (inDoc && !line.trim().startsWith('//') && line.trim() !== '') {
      inDoc = false;
      break;
    }
  }

  return docLines.join('\n').trim();
}

/**
 * Analyze struct from Rust code
 */
export function analyzeStructFromCode(code: string): any {
  const structMatch = code.match(/pub\s+struct\s+(\w+)/);
  if (structMatch) {
    return {
      name: structMatch[1],
      isPublic: true,
      hasFields: code.includes('{') && code.includes('}'),
      fieldCount: (code.match(/\w+:\s*\w+/g) || []).length
    };
  }
  return null;
}

/**
 * Analyze function from Rust code
 */
export function analyzeFunctionFromCode(code: string): any {
  const functionMatch = code.match(/pub\s+fn\s+(\w+)/);
  if (functionMatch) {
    return {
      name: functionMatch[1],
      isPublic: true,
      hasParams: code.includes('(') && code.includes(')'),
      isAsync: code.includes('async'),
      hasReturn: code.includes('->'),
      hasBody: code.includes('{') && code.includes('}')
    };
  }
  return null;
}

/**
 * Create test analysis context
 */
export function createTestContext(projectPath: string = '/test'): AnalysisContext {
  return {
    projectPath,
    options: {
      includeTests: true,
      verbose: false
    }
  };
}

/**
 * Assert CAS node properties
 */
export function expectCASNode(node: any, expectedProperties: any): void {
  if (expectedProperties.id) {
    expect(node).toHaveProperty('id');
    expect(node.id).toMatch(/^(struct|enum|trait|method|function)_/);
  }
  
  if (expectedProperties.type) {
    expect(node).toHaveProperty('type');
    expect(node.type).toBe(expectedProperties.type);
  }
  
  if (expectedProperties.name) {
    expect(node).toHaveProperty('name');
    expect(node.name).toBe(expectedProperties.name);
  }
  
  if (expectedProperties.parent) {
    expect(node).toHaveProperty('parent');
    if (expectedProperties.parent === null) {
      expect(node.parent).toBeNull();
    } else {
      expect(node.parent).toBe(expectedProperties.parent);
    }
  }
  
  if (expectedProperties.tags) {
    expect(node).toHaveProperty('tags');
    expect(Array.isArray(node.tags)).toBe(true);
  }
  
  if (expectedProperties.source) {
    expect(node).toHaveProperty('source');
    expect(node.source).toMatchObject(expectedProperties.source);
  }
}

/**
 * Assert CAS edge properties
 */
export function expectCASEdge(edge: any, expectedProperties: any): void {
  if (expectedProperties.id) {
    expect(edge).toHaveProperty('id');
    expect(edge.id).toBeDefined();
  }
  
  if (expectedProperties.type) {
    expect(edge).toHaveProperty('type');
    expect(edge.type).toBe(expectedProperties.type);
  }
  
  if (expectedProperties.source) {
    expect(edge).toHaveProperty('source');
    expect(edge.source).toBeDefined();
  }
  
  if (expectedProperties.target) {
    expect(edge).toHaveProperty('target');
    expect(edge.target).toBeDefined();
  }
}

/**
 * Check if analysis result has required CAS v1.5.0 fields
 */
export function expectCASCompliance(contribution: any): void {
  // Check for v1.5.0 compliance
  expect(contribution).toHaveProperty('nodes');
  expect(contribution).toHaveProperty('edges');
  expect(contribution).toHaveProperty('analyzer_metadata');
  
  // Check for enhanced features
  if (contribution.method_calls) {
    expect(Array.isArray(contribution.method_calls)).toBe(true);
  }
  
  if (contribution.call_chains) {
    expect(Array.isArray(contribution.call_chains)).toBe(true);
  }
  
  if (contribution.patterns) {
    expect(Array.isArray(contribution.patterns)).toBe(true);
    expect(contribution.patterns[0]).toHaveProperty('variations');
  }
  
  // Check parent field compliance
  const nodes = contribution.nodes || [];
  const structNodes = nodes.filter(n => n.type === 'struct');
  const methodNodes = nodes.filter(n => n.type === 'method');
  
  methodNodes.forEach(method => {
    const parentStruct = structNodes.find(s => s.id === method.parent);
    if (method.parent && method.parent !== null) {
      expect(parentStruct).toBeDefined();
    }
  });
}