import { RustAnalyzer } from '../../../analyzer/languages/rust-analyzer';
import { AnalysisContext } from '../../../analyzer/core/base-analyzer';
import { 
  setupMockFileSystem, 
  cleanupMocks, 
  createMockRustFile,
  createMockCargoToml,
  createTestContext,
  extractRustDocContent,
  analyzeStructFromCode,
  analyzeFunctionFromCode,
  expectCASNode,
  expectCASEdge,
  expectCASCompliance
} from '../../utils/test-helpers';

describe('RustAnalyzer', () => {
  let analyzer: RustAnalyzer;
  let testContext: AnalysisContext;

  beforeEach(() => {
    analyzer = new RustAnalyzer();
    testContext = createTestContext();
  });

  afterEach(() => {
    cleanupMocks();
  });

  describe('Basic Analysis Capabilities', () => {
    test('should detect Rust project with Cargo.toml', async () => {
      const cargoToml = createMockCargoToml();
      setupMockFileSystem([], cargoToml);

      const canAnalyze = await analyzer.canAnalyze('/test');
      expect(canAnalyze).toBe(true);
    });

    test('should reject non-Rust project', async () => {
      setupMockFileSystem([
        createMockRustFile('main.js', 'console.log("hello");')
      ]);

      const canAnalyze = await analyzer.canAnalyze('/test');
      expect(canAnalyze).toBe(false);
    });

    test('should get analyzer capabilities', () => {
      const capabilities = (analyzer as any).getCapabilities();
      expect(capabilities).toContain('struct-analysis');
      expect(capabilities).toContain('trait-analysis');
      expect(capabilities).toContain('framework-detection');
      expect(capabilities).toContain('perspective-system');
    });
  });

  describe('Struct Analysis', () => {
    test('should extract struct information correctly', async () => {
      const rustCode = `
        /// User information
        pub struct User {
            pub name: String,
            age: u32,
        }
      `;

      setupMockFileSystem([
        createMockRustFile('src/lib.rs', rustCode),
        createMockCargoToml()
      ]);

      const result = await analyzer.analyze(testContext) as any;

      expect(result.nodes).toBeDefined();
      
      const structNode = result.nodes.find((n: any) => n.type === 'struct' && n.name === 'User');
      expectCASNode(structNode, {
        type: 'struct',
        name: 'User',
        tags: expect.arrayContaining(['rust-structs']),
        parent: null
      });

      expect(structNode.metadata).toBeDefined();
      expect(structNode.metadata.attributes.fieldCount).toBe(2);
      expect(structNode.documentation).toBeDefined();
      expect(structNode.documentation?.summary).toBe('User information');
    });

    test('should handle nested structs and generics', async () => {
      const rustCode = `
        pub struct Container<T> {
            value: T,
        }

        pub struct User {
            container: Container<String>,
        }
      `;

      setupMockFileSystem([
        createMockRustFile('src/lib.rs', rustCode),
        createMockCargoToml()
      ]);

      const result = await analyzer.analyze(testContext) as any;

      const containerStruct = result.nodes.find((n: any) => n.name === 'Container');
      const userStruct = result.nodes.find((n: any) => n.name === 'User');

      expect(containerStruct).toBeDefined();
      expect(containerStruct.metadata.attributes.generics).toEqual(['T']);
      expect(userStruct).toBeDefined();
    });

    test('should set parent relationships for fields', async () => {
      const rustCode = `
        pub struct User {
            pub name: String,
            age: u32,
        }
      `;

      setupMockFileSystem([
        createMockRustFile('src/lib.rs', rustCode),
        createMockCargoToml()
      ]);

      const result = await analyzer.analyze(testContext) as any;

      const userStruct = result.nodes.find((n: any) => n.type === 'struct' && n.name === 'User');
      const nameField = result.nodes.find((n: any) => n.type === 'field' && n.name === 'name');
      const ageField = result.nodes.find((n: any) => n.type === 'field' && n.name === 'age');

      expect(nameField.parent).toBe(userStruct.id);
      expect(ageField.parent).toBe(userStruct.id);

      const fieldEdge = result.edges.find((e: any) => 
        e.type === 'has_field' && e.target === nameField.id
      );
      expect(fieldEdge.source).toBe(userStruct.id);
    });
  });

  describe('Function and Method Analysis', () => {
    test('should extract function information with RustDoc', async () => {
      const rustCode = `
        /// Calculate the square of a number
        /// 
        /// # Arguments
        /// 
        /// * \`x\` - Number to square
        /// 
        /// # Returns
        /// 
        /// * \`u32\` - Square of x
        pub fn square(x: u32) -> u32 {
            x * x
        }
      `;

      setupMockFileSystem([
        createMockRustFile('src/lib.rs', rustCode),
        createMockCargoToml()
      ]);

      const result = await analyzer.analyze(testContext) as any;

      const functionNode = result.nodes.find((n: any) => n.type === 'function' && n.name === 'square');
      expectCASNode(functionNode, {
        type: 'function',
        name: 'square',
        signature: {
          parameters: expect.arrayContaining([
            expect.objectContaining({ name: 'x', type: 'u32' })
          ]),
          return_type: 'u32'
        }
      });

      expect(functionNode.documentation).toBeDefined();
      expect(functionNode.documentation?.parameters).toBeDefined();
      expect(functionNode.documentation?.parameters).toHaveLength(1);
      expect(functionNode.documentation?.returns).toBeDefined();
    });

    test('should detect TODO markers and implementation status', async () => {
      const rustCode = `
        pub fn incomplete_function() -> String {
            // TODO: Implement this properly
            todo!("Not implemented yet");
        }

        pub fn deprecated_function() -> i32 {
            #[deprecated(since = "1.0.0", note = "use new_function instead")]
            42
        }
      `;

      setupMockFileSystem([
        createMockRustFile('src/lib.rs', rustCode),
        createMockCargoToml()
      ]);

      const result = await analyzer.analyze(testContext) as any;

      const incompleteFunction = result.nodes.find((n: any) => 
        n.type === 'function' && n.name === 'incomplete_function'
      );
      expect(incompleteFunction.implementation_status).toBeDefined();
      expect(incompleteFunction.implementation_status.status).toBe('partial');
      expect(incompleteFunction.todos).toBeDefined();
      expect(incompleteFunction.todos).toHaveLength(2);

      const deprecatedFunction = result.nodes.find((n: any) => 
        n.type === 'function' && n.name === 'deprecated_function'
      );
      expect(deprecatedFunction.implementation_status).toBeDefined();
      expect(deprecatedFunction.implementation_status.status).toBe('deprecated');
      expect(deprecatedFunction.implementation_status.deprecation.is_deprecated).toBe(true);
    });
  });

  describe('Trait Analysis', () => {
    test('should extract trait and implementations', async () => {
      const rustCode = `
        pub trait Greeter {
            fn greet(&self) -> String;
        }

        pub struct User;

        impl Greeter for User {
            fn greet(&self) -> String {
                "Hello, User!".to_string()
            }
        }
      `;

      setupMockFileSystem([
        createMockRustFile('src/lib.rs', rustCode),
        createMockCargoToml()
      ]);

      const result = await analyzer.analyze(testContext) as any;

      const traitNode = result.nodes.find((n: any) => n.type === 'trait' && n.name === 'Greeter');
      expectCASNode(traitNode, {
        type: 'trait',
        name: 'Greeter'
      });

      const implNode = result.nodes.find((n: any) => n.type === 'impl');
      expect(implNode).toBeDefined();
      expect(implNode.metadata.attributes.typeName).toBe('User');
      expect(implNode.metadata.attributes.traitName).toBe('Greeter');

      // Check trait implementation edge
      const implEdge = result.edges.find((e: any) => 
        e.type === 'implements_for' && e.target === traitNode.id
      );
      expect(implEdge).toBeDefined();
      expect(implEdge.source).toBe(implNode.id);
    });
  });

  describe('Call Graph Analysis', () => {
    test('should detect method calls and build call chains', async () => {
      const rustCode = `
        pub struct Service;

        impl Service {
            pub fn process_data(&self) -> u32 {
                self.calculate().call() + 1
            }
            
            fn calculate(&self) -> u32 {
                42
            }
        }

        pub fn test_call_chain() {
            let service = Service;
            let result = service.process_data();
        }
      `;

      setupMockFileSystem([
        createMockRustFile('src/lib.rs', rustCode),
        createMockCargoToml()
      ]);

      const result = await analyzer.analyze(testContext) as any;

      // Check for method calls
      expect(result.method_calls).toBeDefined();
      expect(result.method_calls.length).toBeGreaterThan(0);

      // Check for call chains
      expect(result.call_chains).toBeDefined();
      expect(result.call_chains.length).toBeGreaterThan(0);
    });
  });

  describe('Pattern Detection', () => {
    test('should detect service layer pattern variations', async () => {
      const rustCode = `
        pub trait UserService {
            fn create_user(&self, name: String) -> Result<User>;
        }

        pub struct DatabaseUserService;

        impl UserService for DatabaseUserService {
            fn create_user(&self, name: String) -> Result<User> {
                Ok(User { name })
            }
        }

        pub struct InMemoryUserService {
            users: std::collections::HashMap<String, User>,
        }

        impl InMemoryUserService {
            pub fn create_user(&self, name: String) -> Result<User> {
                self.users.insert(name, User { name });
                Ok(User { name })
            }
        }
      `;

      setupMockFileSystem([
        createMockRustFile('src/lib.rs', rustCode),
        createMockCargoToml()
      ]);

      const result = await analyzer.analyze(testContext) as any;

      expect(result.patterns).toBeDefined();
      
      const servicePattern = result.patterns.find((p: any) => p.id === 'service-layer-pattern');
      expect(servicePattern).toBeDefined();
      expect(servicePattern.variations).toBeDefined();
      expect(servicePattern.variations).toHaveLength(2);
      
      const traitBasedVariation = servicePattern.variations.find((v: any) => v.id === 'trait-based');
      expect(traitBasedVariation).toBeDefined();
      expect(traitBasedVariation.percentage).toBeGreaterThan(0);
    });

    test('should detect error handling pattern variations', async () => {
      const rustCode = `
        pub mod error_handling {
            pub fn result_approach() -> Result<String> {
                Ok("success".to_string())
            }

            pub fn panic_approach() -> String {
                panic!("This always fails")
            }

            pub fn no_handling() -> String {
                "success".to_string()
            }
        }
      `;

      setupMockFileSystem([
        createMockRustFile('src/lib.rs', rustCode),
        createMockCargoToml()
      ]);

      const result = await analyzer.analyze(testContext) as any;

      expect(result.patterns).toBeDefined();
      
      const errorPattern = result.patterns.find((p: any) => p.id === 'error-handling-pattern');
      expect(errorPattern).toBeDefined();
      expect(errorPattern.variations).toBeDefined();
      expect(errorPattern.variations).toHaveLength(3);
    });
  });

  describe('CAS v1.5.0 Compliance', () => {
    test('should generate CAS v1.5.0 compliant output', async () => {
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

      const result = await analyzer.analyze(testContext) as any;

      // Check for v1.5.0 compliance
      expectCASCompliance(result);

      // Check for enhanced features
      expect(result.nodes).toBeDefined();
      expect(result.edges).toBeDefined();
      expect(result.analyzer_contributions).toBeDefined();

      // Check for required fields
      expect(result.cas_version).toBeDefined();
      expect(result.analysis_timestamp).toBeDefined();
      expect(result.analysis_id).toBeDefined();
    });
  });

  describe('Integration with Framework Analyzers', () => {
    test('should enhance analysis when Actix patterns detected', async () => {
      const rustCode = `
        use actix_web::{get, post, App, HttpServer, HttpResponse};
        
        #[get("/users/{id}")]
        pub async fn get_user(path: web::Path<u32>) -> impl Responder {
            HttpResponse::Ok().json("test")
        }
      `;

      setupMockFileSystem([
        createMockRustFile('src/main.rs', rustCode),
        createMockCargoToml(['actix-web'])
      ]);

      const result = await analyzer.analyze(testContext) as any;

      // Check for framework detection
      expect(result.analyzer_metadata.framework_specific.actixFramework).toBe(true);
      
      // Check for route entry points
      if (result.entry_points) {
        const httpEntryPoints = result.entry_points.filter((ep: any) => ep.type === 'http');
        expect(httpEntryPoints.length).toBeGreaterThan(0);
      }
    });
  });
});

describe('RustAnalyzer CLI entry metadata', () => {
  let analyzer: RustAnalyzer;
  let testContext: AnalysisContext;

  beforeEach(() => {
    analyzer = new RustAnalyzer();
    testContext = createTestContext();
  });

  afterEach(() => {
    cleanupMocks();
  });

  const agentMain = `
use clap::{Parser, Subcommand};

#[derive(Parser)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    Connect { host: String },
    Disconnect,
}

fn main() {
    let cli = Cli::parse();
}
`;

  const workspaceFiles = () => [
    createMockRustFile('bin/agent/Cargo.toml', '[package]\nname = "agent"\nversion = "0.1.0"\n'),
    createMockRustFile('bin/agent/src/main.rs', agentMain),
    createMockRustFile('bin/agent/build.rs', 'fn main() {\n    println!("cargo:rerun-if-changed=build.rs");\n}\n'),
    createMockRustFile('src/bin/zerac-ngrok.rs', 'fn main() {\n    run();\n}\n\nfn run() {}\n'),
  ];

  test('attaches crate and binary metadata to main entry points', async () => {
    setupMockFileSystem(workspaceFiles(), createMockCargoToml(['clap']));

    const result = await analyzer.analyze(testContext);
    const mainEntries = result.entry_points!.filter((ep: any) => ep.id.startsWith('entry:main:'));

    const agentEntry = mainEntries.find((ep: any) => ep.id === 'entry:main:bin/agent/src/main.rs');
    expect(agentEntry).toBeDefined();
    expect(agentEntry!.metadata).toMatchObject({ crate: 'agent', binary: 'agent' });

    const ngrokEntry = mainEntries.find((ep: any) => ep.id === 'entry:main:src/bin/zerac-ngrok.rs');
    expect(ngrokEntry).toBeDefined();
    expect(ngrokEntry!.metadata).toMatchObject({ crate: 'test-project', binary: 'zerac-ngrok' });
  });

  test('marks crate-root build.rs entries as build scripts without a binary', async () => {
    setupMockFileSystem(workspaceFiles(), createMockCargoToml(['clap']));

    const result = await analyzer.analyze(testContext);
    const buildEntry = result.entry_points!.find((ep: any) => ep.id === 'entry:main:bin/agent/build.rs');

    expect(buildEntry).toBeDefined();
    expect(buildEntry!.metadata).toMatchObject({ crate: 'agent', build_script: true });
    expect(buildEntry!.metadata!.binary).toBeUndefined();
  });

  test('attaches binary and subcommand metadata to clap subcommand variants', async () => {
    setupMockFileSystem(workspaceFiles(), createMockCargoToml(['clap']));

    const result = await analyzer.analyze(testContext);
    const connectEntry = result.entry_points!.find((ep: any) =>
      ep.id === 'entry:cli:bin/agent/src/main.rs:subcommand:Connect');

    expect(connectEntry).toBeDefined();
    expect(connectEntry!.metadata).toMatchObject({
      crate: 'agent',
      binary: 'agent',
      subcommand: 'Connect',
      command_type: 'subcommand_variant',
    });
  });

  test('attaches command metadata to clap parser structs and subcommand enums', async () => {
    setupMockFileSystem(workspaceFiles(), createMockCargoToml(['clap']));

    const result = await analyzer.analyze(testContext);

    const cliStruct = result.entry_points!.find((ep: any) => ep.id === 'entry:cli:bin/agent/src/main.rs:Cli');
    expect(cliStruct).toBeDefined();
    expect(cliStruct!.metadata).toMatchObject({
      crate: 'agent',
      binary: 'agent',
      command: 'Cli',
      command_type: 'command_struct',
    });

    const commandsEnum = result.entry_points!.find((ep: any) => ep.id === 'entry:cli:bin/agent/src/main.rs:Commands');
    expect(commandsEnum).toBeDefined();
    expect(commandsEnum!.metadata).toMatchObject({
      crate: 'agent',
      command: 'Commands',
      command_type: 'subcommand_enum',
    });
  });
});
