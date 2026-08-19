import { RustAnalyzer } from '../../../analyzer/languages/rust-analyzer';
import { AnalysisContext, FileAnalysisContext } from '../../../analyzer/core/base-analyzer';
import { 
  setupMockFileSystem, 
  cleanupMocks, 
  createMockRustFile,
  createMockCargoToml,
  createTestContext,
  expectCASNode,
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

    test('represents imports and public reexports in the relationship graph', async () => {
      setupMockFileSystem([
        createMockRustFile('src/config.rs', 'pub use zerac::config::{PhysicalGatewayConfig, PhysicalGatewayFile};'),
        createMockCargoToml(['zerac'])
      ]);

      const result = await analyzer.analyze(testContext) as any;
      const file = result.nodes.find((node: any) => node.type === 'file' && node.name === 'config.rs');
      const imported = result.nodes.find((node: any) => node.type === 'import' && node.name.startsWith('zerac::config'));

      expect(file).toBeDefined();
      expect(imported?.metadata?.reexport).toBe(true);
      expect(result.edges).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: file.id, target: imported.id, type: 'imports' })
      ]));
    });
  });

  describe('HTTP service alias inference', () => {
    test('derives service aliases from generic variable names and Rust service paths', async () => {
      setupMockFileSystem([
        createMockRustFile('bin/drop-server/src/client.rs', `
          pub async fn call_admin(client: &reqwest::Client, admin_api_url: url::Url) {
              client
                  .post(admin_api_url.join("/v1/users").unwrap())
                  .send()
                  .await
                  .unwrap();
          }

          pub struct DropBroker {
              url: url::Url,
          }

          impl DropBroker {
              pub async fn forward(&self, client: &reqwest::Client) {
                  let request_url = self.url.clone().join("/drops").unwrap();
                  client
                      .post(request_url.as_str())
                      .send()
                      .await
                      .unwrap();
              }
          }
        `),
        createMockCargoToml(['reqwest'])
      ]);

      const result = await analyzer.analyze(testContext) as any;
      const reqwestExits = result.exit_points.filter((exit: any) => exit.metadata?.library === 'reqwest');

      expect(reqwestExits.some((exit: any) =>
        exit.target?.service_id === 'admin-api' &&
        exit.target?.endpoint === 'http://admin-api/v1/users'
      )).toBe(true);

      expect(reqwestExits.some((exit: any) =>
        exit.target?.service_id === 'drop-server' &&
        exit.target?.endpoint === 'http://drop-server/drops'
      )).toBe(true);
    });

    test('exit-point ids are project-relative and carry no absolute snapshot path', async () => {
      setupMockFileSystem([
        createMockRustFile('src/client.rs', `
          use some_external_crate::do_thing;
          pub async fn call_admin(client: &reqwest::Client, admin_api_url: url::Url) {
              client.post(admin_api_url.join("/v1/users").unwrap()).send().await.unwrap();
              some_external_crate::do_thing();
          }
        `),
        createMockCargoToml(['reqwest', 'some_external_crate'])
      ]);

      const result = await analyzer.analyze(testContext) as any;
      const rustExits = (result.exit_points as any[]).filter(
        (exit: any) => typeof exit.id === 'string' &&
          (exit.id.startsWith('reqwest_call:') || exit.id.startsWith('ext_call:'))
      );
      expect(rustExits.length).toBeGreaterThan(0);
      for (const exit of rustExits) {
        // Project root is '/test'; ids must not embed the absolute project path,
        // any tmp-snapshot path, or a leading slash into the file segment.
        expect(exit.id).not.toContain('/test/');
        expect(exit.id).not.toContain('/var/folders');
        expect(exit.id).toContain('src/client.rs');
        expect(exit.id).not.toMatch(/:\/[^:]*src\/client\.rs/); // no leading slash before rel path
      }
    });

    test('does not emit duplicate exit-point ids on a cargo workspace (same rel path in two crates)', async () => {
      // Two crates share the same project-relative source path; previously each
      // crate re-linked the file and emitted colliding exit-point ids.
      const clientSrc = `
        use shared_crate::helper;
        pub async fn ping(client: &reqwest::Client) {
            client.post("https://api.example.com/ping").send().await.unwrap();
            shared_crate::helper();
        }
      `;
      setupMockFileSystem([
        createMockRustFile('crates/a/src/client.rs', clientSrc),
        createMockRustFile('crates/b/src/client.rs', clientSrc),
        createMockCargoToml(['reqwest', 'shared_crate'])
      ]);

      const result = await analyzer.analyze(testContext) as any;
      const ids = (result.exit_points as any[]).map((exit: any) => exit.id);
      const rustIds = ids.filter((id: any) =>
        typeof id === 'string' && (id.startsWith('reqwest_call:') || id.startsWith('ext_call:'))
      );
      const uniqueRustIds = new Set(rustIds);
      expect(rustIds.length).toBe(uniqueRustIds.size);
    });
  });

  describe('External receiver classification', () => {
    test('does not classify in-process state named db as an external service', async () => {
      setupMockFileSystem([
        createMockRustFile('src/main.rs', `
          use std::sync::{Arc, RwLock};
          type Db = Arc<RwLock<Vec<String>>>;
          async fn list(State(db): State<Db>) {
              let values = db.read().unwrap();
              let router = Router::new();
              let id = Uuid::new_v4();
          }
        `),
        createMockCargoToml(['axum'])
      ]);

      const result = await analyzer.analyze(testContext) as any;
      expect(result.exit_points.some((exit: any) => exit.target?.sdk === 'db')).toBe(false);
      expect(result.method_calls.some((call: any) => call.external_details?.library === 'db')).toBe(false);
      expect(result.exit_points.some((exit: any) => ['Router', 'Uuid'].includes(exit.target?.sdk))).toBe(false);
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

    test('publishes serializable struct classification on the node contract', async () => {
      setupMockFileSystem([
        createMockRustFile('src/lib.rs', `
          #[derive(Debug, Serialize, Deserialize)]
          struct Todo {
            id: Uuid,
            text: String,
          }
        `),
        createMockCargoToml(),
      ]);

      const result = await analyzer.analyze(testContext) as any;
      const todo = result.nodes.find((node: any) => node.type === 'struct' && node.name === 'Todo');

      expect(todo.subcategories).toEqual(expect.arrayContaining(['struct', 'serializable']));
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
      expect(result.analyzer_metadata).toBeDefined();

      expect(result.analyzer_metadata.analyzer_id).toBe('rust');
      expect(result.analyzer_metadata.version).toBeDefined();
      expect(result.analyzer_metadata.contribution_type).toBe('language');
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

  test('emits clap Subcommand variants as cli_command registration nodes, not enum_variant', async () => {
    setupMockFileSystem(workspaceFiles(), createMockCargoToml(['clap']));

    const result = await analyzer.analyze(testContext);

    const connectNode = result.nodes!.find((n: any) => n.id === 'cli_command:bin/agent/src/main.rs:Connect');
    expect(connectNode).toBeDefined();
    expect(connectNode!.type).toBe('cli_command');

    const disconnectNode = result.nodes!.find((n: any) => n.id === 'cli_command:bin/agent/src/main.rs:Disconnect');
    expect(disconnectNode).toBeDefined();
    expect(disconnectNode!.type).toBe('cli_command');

    // No enum_variant node should be emitted for a clap-derived enum's
    // variants — that node type is reserved for plain (non-clap) enums.
    const staleVariantNodes = result.nodes!.filter((n: any) =>
      n.type === 'enum_variant' && (n.name === 'Connect' || n.name === 'Disconnect'));
    expect(staleVariantNodes).toHaveLength(0);

    // The Connect/Disconnect entry point still resolves to the (now
    // cli_command-typed) variant node — behavior for consumers is unchanged.
    const connectEntry = result.entry_points!.find((ep: any) =>
      ep.id === 'entry:cli:bin/agent/src/main.rs:subcommand:Connect');
    expect(connectEntry!.source_node).toBe('cli_command:bin/agent/src/main.rs:Connect');
  });

  test('plain (non-clap) enums keep enum_variant-shaped node emission unaffected', async () => {
    const plainEnumSource = `
enum Color {
    Red,
    Green,
    Blue,
}

fn main() {}
`;
    setupMockFileSystem([
      createMockRustFile('src/main.rs', plainEnumSource),
    ], createMockCargoToml([]));

    const result = await analyzer.analyze(testContext);

    // extractEnums emits one 'enum' node for the declaration; this analyzer
    // does not (and still does not, after this change) emit a per-variant
    // node for enums with no clap Subcommand/Parser/Args framing.
    const enumNode = result.nodes!.find((n: any) => n.id === 'enum:src/main.rs:Color');
    expect(enumNode).toBeDefined();
    expect(enumNode!.type).toBe('enum');

    const anyVariantNode = result.nodes!.find((n: any) =>
      n.type === 'cli_command' || n.type === 'enum_variant');
    expect(anyVariantNode).toBeUndefined();
  });
});

describe('Pattern detection with reclassified structs', () => {
  let analyzer: RustAnalyzer;
  let testContext: AnalysisContext;

  beforeEach(() => {
    analyzer = new RustAnalyzer();
    testContext = createTestContext();
  });

  afterEach(() => {
    cleanupMocks();
  });

  test('reclassified Builder/Config structs appear in builder-pattern instances', async () => {
    setupMockFileSystem([
      createMockRustFile('src/config.rs', `
        pub struct ServerBuilder {
            port: u16,
        }

        pub struct TunnelConfig {
            endpoint: String,
        }
      `)
    ], createMockCargoToml());

    const result = await analyzer.analyze(testContext) as any;

    const builderNode = result.nodes.find((n: any) => n.name === 'ServerBuilder');
    const configNode = result.nodes.find((n: any) => n.name === 'TunnelConfig');
    expect(builderNode).toBeDefined();
    expect(configNode).toBeDefined();
    expect(builderNode.type).not.toBe('struct');

    const builderPattern = result.patterns.find((p: any) => p.id === 'pattern:rust:builder');
    expect(builderPattern).toBeDefined();
    expect(builderPattern.instances).toContain(builderNode.id);
    expect(builderPattern.instances).toContain(configNode.id);
  });

  test('reclassified Error struct appears in error-handling pattern instances', async () => {
    setupMockFileSystem([
      createMockRustFile('src/error.rs', `
        pub struct Error {
            message: String,
        }

        pub enum ParseError {
            Invalid,
        }
      `)
    ], createMockCargoToml());

    const result = await analyzer.analyze(testContext) as any;

    const errorStruct = result.nodes.find((n: any) => n.name === 'Error');
    expect(errorStruct).toBeDefined();
    expect(errorStruct.type).toBe('error');

    const errorPattern = result.patterns.find((p: any) => p.id === 'pattern:rust:error-handling');
    expect(errorPattern).toBeDefined();
    expect(errorPattern.instances).toContain(errorStruct.id);
    const enumNode = result.nodes.find((n: any) => n.name === 'ParseError');
    expect(errorPattern.instances).toContain(enumNode.id);
  });

  test('reclassified Service struct appears in service-pattern instances', async () => {
    setupMockFileSystem([
      createMockRustFile('src/service.rs', `
        pub struct ScanService {
            jobs: Vec<String>,
        }
      `)
    ], createMockCargoToml());

    const result = await analyzer.analyze(testContext) as any;

    const serviceNode = result.nodes.find((n: any) => n.name === 'ScanService');
    expect(serviceNode).toBeDefined();

    const servicePattern = result.patterns.find((p: any) =>
      Array.isArray(p.instances) && p.instances.includes(serviceNode.id)
    );
    expect(servicePattern).toBeDefined();
  });
});

describe('RustAnalyzer incremental cross-file resolution', () => {
  afterEach(() => {
    cleanupMocks();
  });

  test('resolves edited-file calls against the existing analysis snapshot', async () => {
    setupMockFileSystem([
      createMockRustFile('src/current.rs', `
        pub struct Current {
            helper: Helper,
        }

        pub fn current() {
            helper();
        }
      `),
    ], createMockCargoToml());
    jest.spyOn(require('fs-extra'), 'stat').mockResolvedValue({ mtimeMs: 1 } as any);
    const context: FileAnalysisContext = {
      projectPath: '/test',
      filePath: '/test/src/current.rs',
      relativePath: 'src/current.rs',
      contentHash: 'current',
      existingAnalysis: [{
        nodes: [{
          id: 'function:src/helper.rs:helper',
          name: 'helper',
          type: 'function',
          source: { file: 'src/helper.rs', line: 1 },
        } as any, {
          id: 'struct:src/helper.rs:Helper',
          name: 'Helper',
          type: 'struct',
          source: { file: 'src/helper.rs', line: 2 },
        } as any],
        edges: [],
        entry_points: [],
        exit_points: [],
        analyzer_metadata: {
          analyzer_id: 'rust',
          analyzer_name: 'Rust Analyzer',
          version: '1.0.0',
          contribution_type: 'language',
          nodes_contributed: 2,
          edges_contributed: 0,
          contributed_entry_points: 0,
          contributed_exit_points: 0,
        },
      }],
    };

    const result = await new RustAnalyzer().analyzeFileSingle(context);

    expect(result.nodes.some(node => node.id === 'function:src/helper.rs:helper')).toBe(false);
    expect(result.nodes.some(node => node.id === 'struct:src/helper.rs:Helper')).toBe(false);
    expect(result.edges.some(edge =>
      edge.source === 'function:src/current.rs:current' &&
      edge.target === 'function:src/helper.rs:helper' &&
      edge.type === 'calls'
    )).toBe(true);
    expect(result.edges.some(edge =>
      edge.source === 'struct:src/current.rs:Current' &&
      edge.target === 'struct:src/helper.rs:Helper' &&
      edge.type === 'depends_on'
    )).toBe(true);
  });

  test('assigns stable distinct ids to repeated declarations', async () => {
    setupMockFileSystem([
      createMockRustFile('src/error.rs', `
        pub enum ScanError { Failed }
        pub struct NetworkError;
        pub struct ParseError;

        impl From<NetworkError> for ScanError {
            fn from(value: NetworkError) -> Self { ScanError::Failed }
        }

        impl From<ParseError> for ScanError {
            fn from(value: ParseError) -> Self { ScanError::Failed }
        }
      `),
    ], createMockCargoToml());

    const result = await new RustAnalyzer().analyze(createTestContext()) as any;
    const declarations = result.nodes.filter((node: any) =>
      node.name === 'from' && node.source?.file === 'src/error.rs'
    );

    expect(declarations.map((node: any) => node.id)).toEqual([
      'method:src/error.rs:From:from',
      'method:src/error.rs:From:from:2',
    ]);
    expect(declarations.map((node: any) => node.signature.parameters[0].type)).toEqual([
      'NetworkError',
      'ParseError',
    ]);
  });
});
