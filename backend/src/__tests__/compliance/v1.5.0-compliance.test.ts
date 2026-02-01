/**
 * CAS v1.5.0 Compliance Tests for Rust Analyzer
 */
import { RustAnalyzer } from '../../analyzer/languages/rust-analyzer';
import { AnalysisContext } from '../../types/cas.types';
import { 
  setupMockFileSystem, 
  cleanupMocks, 
  createMockRustFile,
  createMockCargoToml,
  createTestContext,
  expectCASCompliance
} from '../utils/test-helpers';

describe('CAS v1.5.0 Compliance Tests', () => {
  let analyzer: RustAnalyzer;
  let testContext: AnalysisContext;

  beforeEach(() => {
    analyzer = new RustAnalyzer();
    testContext = createTestContext();
  });

  afterEach(() => {
    cleanupMocks();
  });

  describe('Required CAS v1.5.0 Fields', () => {
    test('must include method_calls array', async () => {
      const rustCode = `
        pub fn caller() {
            callee();
        }
        
        pub fn callee() {}
      `;

      setupMockFileSystem([
        createMockRustFile('src/lib.rs', rustCode),
        createMockCargoToml()
      ]);

      const result = await analyzer.analyze(testContext);

      expect(result.method_calls).toBeDefined();
      expect(Array.isArray(result.method_calls)).toBe(true);
      expect(result.method_calls.length).toBeGreaterThan(0);
    });

    test('must include call_chains array', async () => {
      const rustCode = `
        pub fn a() -> i32 { b() + 1 }
        pub fn b() -> i32 { c() * 2 }
        pub fn c() -> i32 { 42 }
      `;

      setupMockFileSystem([
        createMockRustFile('src/lib.rs', rustCode),
        createMockCargoToml()
      ]);

      const result = await analyzer.analyze(testContext);

      expect(result.call_chains).toBeDefined();
      expect(Array.isArray(result.call_chains)).toBe(true);
    });

    test('must include patterns with variations support', async () => {
      const rustCode = `
        pub struct Service;
        pub struct Repository;
        
        impl Service {
            fn use_repository(&self) -> Repository {
                Repository::new()
            }
        }
      `;

      setupMockFileSystem([
        createMockRustFile('src/lib.rs', rustCode),
        createMockCargoToml()
      ]);

      const result = await analyzer.analyze(testContext);

      expect(result.patterns).toBeDefined();
      expect(Array.isArray(result.patterns)).toBe(true);
      
      const patterns = result.patterns as any[];
      const patternWithVariations = patterns.find(p => p.variations && p.variations.length > 0);
      if (patternWithVariations) {
        expect(patternWithVariations.variations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: expect.any(String),
              implementation: expect.any(String),
              description: expect.any(String),
              instances: expect.any(Array),
              percentage: expect.any(Number),
              characteristics: expect.any(Object)
            })
          ])
        );
      }
    });

    test('must include perspectives array', async () => {
      const rustCode = `
        pub struct User;
        impl User { fn new() -> Self { User } }
      `;

      setupMockFileSystem([
        createMockRustFile('src/lib.rs', rustCode),
        createMockCargoToml()
      ]);

      const result = await analyzer.analyze(testContext);

      expect(result.perspectives).toBeDefined();
      expect(Array.isArray(result.perspectives)).toBe(true);
      expect(result.perspectives.length).toBeGreaterThan(0);
      
      // Check for Rust-specific perspectives
      const rustStructurePerspective = result.perspectives.find((p: any) => p.id === 'rust-structure');
      expect(rustStructurePerspective).toBeDefined();
      expect(rustStructurePerspective.analyzer_id).toBe('rust-analyzer');
      expect(rustStructurePerspective.type).toBe('structure');
    });
  });

  describe('Parent Field Compliance (v1.5.0 requirement)', () => {
    test('class members must have parent field set', async () => {
      const rustCode = `
        pub struct User {
            pub name: String,
            pub age: u32,
        }

        impl User {
            pub fn new(name: String, age: u32) -> Self {
                User { name, age }
            }
        }
      `;

      setupMockFileSystem([
        createMockRustFile('src/lib.rs', rustCode),
        createMockCargoToml()
      ]);

      const result = await analyzer.analyze(testContext);

      const userStruct = result.nodes.find((n: any) => n.type === 'struct' && n.name === 'User');
      const nameField = result.nodes.find((n: any) => n.type === 'field' && n.name === 'name');
      const ageField = result.nodes.find((n: any) => n.type === 'field' && n.name === 'age');
      const newMethod = result.nodes.find((n: any) => n.type === 'method' && n.name === 'new');

      // Check parent relationships
      expect(nameField.parent).toBe(userStruct.id);
      expect(ageField.parent).toBe(userStruct.id);
      
      // Methods should have parent set to struct, not impl block
      expect(newMethod.parent).toBe(userStruct.id);
    });
  });

  describe('Enhanced Edge Types (v1.5.0)', () => {
    test('should create class-level relationship edges', async () => {
      const rustCode = `
        pub struct ServiceA;
        pub struct ServiceB;
        
        impl ServiceA {
            fn process(&self) {
                ServiceB::execute(); // Should create 'uses' edge
            }
        }
        
        impl ServiceB {
            fn execute() {}
        }
      `;

      setupMockFileSystem([
        createMockRustFile('src/lib.rs', rustCode),
        createMockCargoToml()
      ]);

      const result = await analyzer.analyze(testContext);

      // Check for class-level 'uses' edge
      const usesEdge = result.edges.find((e: any) => 
        e.type === 'uses' && 
        e.source.includes('ServiceA') && 
        e.target.includes('ServiceB')
      );
      expect(usesEdge).toBeDefined();
      expect(usesEdge.aggregated_from).toBeDefined();
      expect(Array.isArray(usesEdge.aggregated_from)).toBe(true);
    });

    test('should create dependency injection edges', async () => {
      const rustCode = `
        pub struct Service;
        pub struct Repository;
        
        pub struct App {
            repository: Repository, // Should create 'depends_on' edge
        }
        
        impl App {
            pub fn new(repository: Repository) -> Self {
                App { repository }
            }
        }
      `;

      setupMockFileSystem([
        createMockRustFile('src/lib.rs', rustCode),
        createMockCargoToml()
      ]);

      const result = await analyzer.analyze(testContext);

      // Check for class-level 'depends_on' edge
      const dependsOnEdge = result.edges.find((e: any) => 
        e.type === 'depends_on' && 
        e.source.includes('App') && 
        e.target.includes('Repository')
      );
      expect(dependsOnEdge).toBeDefined();
    });
  });

  describe('Documentation and Implementation Status', () => {
    test('should extract comprehensive RustDoc documentation', async () => {
      const rustCode = `
        /// User representation
        /// 
        /// This struct represents a user in the system.
        /// 
        /// # Arguments
        /// 
        /// None - constructed with User::new()
        /// 
        /// # Examples
        /// 
        /// ```
        /// use crate::User;
        /// let user = User::new("Alice", 25);
        /// ```
        pub struct User {
            /// User's full name
            pub name: String,
            /// User's age in years
            pub age: u32,
        }
      `;

      setupMockFileSystem([
        createMockRustFile('src/lib.rs', rustCode),
        createMockCargoToml()
      ]);

      const result = await analyzer.analyze(testContext);

      const userStruct = result.nodes.find((n: any) => n.type === 'struct' && n.name === 'User');
      expect(userStruct.documentation).toBeDefined();
      expect(userStruct.documentation.type).toBe('rustdoc');
      expect(userStruct.documentation.summary).toBe('User representation');
      expect(userStruct.documentation.description).toContain('represents a user');
      expect(userStruct.documentation.examples).toBeDefined();
      expect(userStruct.documentation.examples).toHaveLength(1);
    });

    test('should detect implementation status indicators', async () => {
      const rustCode = `
        pub fn complete_function() -> String {
            "complete".to_string()
        }

        pub fn partial_function() -> String {
            // TODO: Implement this properly
            "incomplete".to_string()
        }

        pub fn stub_function() -> String {
            "stub".to_string()
        }

        pub fn panic_function() {
            panic!("This function panics")
        }
      `;

      setupMockFileSystem([
        createMockRustFile('src/lib.rs', rustCode),
        createMockCargoToml()
      ]);

      const result = await analyzer.analyze(testContext);

      const completeFunction = result.nodes.find((n: any) => n.name === 'complete_function');
      expect(completeFunction.implementation_status.status).toBe('complete');

      const partialFunction = result.nodes.find((n: any) => n.name === 'partial_function');
      expect(partialFunction.implementation_status.status).toBe('partial');
      expect(partialFunction.implementation_status.indicators.has_todo_markers).toBe(true);

      const stubFunction = result.nodes.find((n: any) => n.name === 'stub_function');
      expect(stubFunction.implementation_status.status).toBe('stub');

      const panicFunction = result.nodes.find((n: any) => n.name === 'panic_function');
      expect(panicFunction.implementation_status.indicators.has_not_implemented_exceptions).toBe(true);
    });
  });

  describe('Full CAS Compliance', () => {
    test('should be fully CAS v1.5.0 compliant', async () => {
      const rustCode = `
        pub mod models {
            pub struct User {
                pub id: u32,
                pub name: String,
            }
            
            pub struct Post {
                pub id: u32,
                pub user_id: u32,
            }
        }

        pub mod services {
            pub trait UserService {
                fn create_user(&self, name: String) -> Result<models::User, String>;
                fn get_user(&self, id: u32) -> Option<models::User>;
            }

            pub struct DatabaseUserService;

            impl UserService for DatabaseUserService {
                fn create_user(&self, name: String) -> Result<models::User, String> {
                    if name.is_empty() {
                        return Err("Name cannot be empty".to_string());
                    }
                    Ok(models::User { id: 1, name })
                }

                fn get_user(&self, id: u32) -> Option<models::User> {
                    Some(models::User { id, name: "Test User".to_string() })
                }
            }
        }
      `;

      setupMockFileSystem([
        createMockRustFile('src/lib.rs', rustCode),
        createMockCargoToml()
      ]);

      const result = await analyzer.analyze(testContext);

      // Full compliance check
      expectCASCompliance(result);

      // Check all v1.5.0 features
      expect(result.method_calls).toBeDefined();
      expect(result.call_chains).toBeDefined();
      expect(result.patterns).toBeDefined();
      expect(result.perspectives).toBeDefined();
      expect(result.entry_points).toBeDefined();
      expect(result.exit_points).toBeDefined();
      expect(result.external_services).toBeDefined();

      // Check parent field compliance
      const nodes = result.nodes as any[];
      const methodNodes = nodes.filter(n => n.type === 'method');
      methodNodes.forEach(method => {
        if (method.parent !== null) {
          const parent = nodes.find(n => n.id === method.parent);
          expect(parent).toBeDefined();
          expect(['struct', 'enum']).toContain(parent.type);
        }
      });
    });
  });
});