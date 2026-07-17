import { BaseAnalyzer, AnalysisContext } from '../../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint,
  CASDocumentation, CASComment, CASTodo, CASImplementationStatus
} from "../../../types/cas.types";
import { AnalyzerError } from '../../core/errors';
import * as path from 'path';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../../core/glob-cache';

interface SpringBootApplication {
  name: string;
  filePath: string;
  mainClass: string;
  configurationProperties: string[];
  enabledFeatures: string[];
}

interface SpringController {
  name: string;
  filePath: string;
  requestMapping: string;
  endpoints: SpringEndpoint[];
  crossOrigin: boolean;
  dependencies: string[];
}

interface SpringEndpoint {
  method: string;
  path: string;
  handlerName: string;
  parameters: Array<{ name: string; type: string; annotation: string }>;
  responseType: string;
  produces: string[];
  consumes: string[];
  authenticated: boolean;
}

interface SpringService {
  name: string;
  filePath: string;
  stereotype: 'service' | 'component' | 'repository';
  transactional: boolean;
  dependencies: string[];
  methods: Array<{ name: string; parameters: any[]; returnType: string; transactional: boolean }>;
}

interface SpringConfiguration {
  name: string;
  filePath: string;
  beans: SpringBean[];
  properties: string[];
  profiles: string[];
}

interface SpringBean {
  name: string;
  type: string;
  scope: string;
  primary: boolean;
  conditional: string[];
}

interface SpringEntity {
  name: string;
  filePath: string;
  table: string;
  relationships: Array<{ type: string; target: string; mappedBy?: string }>;
  fields: Array<{ name: string; type: string; annotations: string[] }>;
}

interface SpringSecurity {
  name: string;
  filePath: string;
  endpoints: Array<{ pattern: string; access: string }>;
  authenticationProvider: string;
  passwordEncoder: string;
}

export class SpringBootAnalyzer extends BaseAnalyzer {

  constructor() {
    super(
      'spring-boot',
      'Spring Boot Framework Analyzer',
      '1.0.0',
      'framework'
    );
  }

  /**
   * See JavaAnalyzer.getJavaIgnorePatterns (packages/analyzer-core/src/analyzer/
   * languages/java-analyzer.ts) for the full rationale: the shared base-analyzer
   * denylist excludes any `samples/**`, `examples/**`, `fixtures/**`, or
   * `testdata/**` directory to skip vendored example code in JS/Python repos,
   * but Java's package-to-directory convention turns those into common REAL
   * package segments (e.g. `org.springframework.samples.<app>`). Left
   * unfiltered, this analyzer's own java-file glob silently excludes every
   * controller/entity/service in a codebase using that package name — which is
   * exactly the shape of a benchmarked Spring Boot reference app this analyzer targets.
   */
  private getJavaIgnorePatterns(context: AnalysisContext | { projectPath: string }): string[] {
    const unsafeForJavaPackages = /^(\*\*\/)?(samples|examples|fixtures|testdata)\/\*\*$/;
    return this.getIgnorePatterns(context as AnalysisContext).filter(p => !unsafeForJavaPackages.test(p));
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const pomPath = path.join(projectPath, 'pom.xml');
      const gradlePath = path.join(projectPath, 'build.gradle');
      const gradleKtsPath = path.join(projectPath, 'build.gradle.kts');

      if (await fs.pathExists(pomPath)) {
        const pomContent = await fs.readFile(pomPath, 'utf-8');
        return pomContent.includes('spring-boot-starter') || pomContent.includes('org.springframework.boot');
      }

      if (await fs.pathExists(gradlePath)) {
        const gradleContent = await fs.readFile(gradlePath, 'utf-8');
        return gradleContent.includes('spring-boot-starter') || gradleContent.includes('org.springframework.boot');
      }

      if (await fs.pathExists(gradleKtsPath)) {
        const gradleKtsContent = await fs.readFile(gradleKtsPath, 'utf-8');
        return gradleKtsContent.includes('spring-boot-starter') || gradleKtsContent.includes('org.springframework.boot');
      }

      const javaFiles = await glob(['**/*.java'], {
        cwd: projectPath,
        ignore: [...this.getJavaIgnorePatterns({ projectPath }), '**/*.class'],
        nodir: true
      });

      for (const file of javaFiles) {
        const content = await fs.readFile(path.join(projectPath, file), 'utf-8');
        if (content.includes('@SpringBootApplication') || content.includes('import org.springframework')) {
          return true;
        }
      }

      return false;
    } catch {
      return false;
    }
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];

    try {
      const javaFiles = await glob(['**/*.java'], {
        cwd: context.projectPath,
        ignore: [...this.getJavaIgnorePatterns(context), '**/*.class', '**/test/**'],
        nodir: true
      });

      const application = await this.analyzeApplication(javaFiles, context.projectPath, nodes);
      const controllers = await this.analyzeControllers(javaFiles, context.projectPath, nodes, edges, entryPoints);
      const services = await this.analyzeServices(javaFiles, context.projectPath, nodes, edges);
      const configurations = await this.analyzeConfigurations(javaFiles, context.projectPath, nodes, edges);
      const entities = await this.analyzeEntities(javaFiles, context.projectPath, nodes, edges, exitPoints);
      const security = await this.analyzeSecurity(javaFiles, context.projectPath, nodes, edges);

      this.buildSpringBootRelationships(controllers, services, configurations, entities, nodes, edges);
      this.identifyDatabaseConnections(entities, exitPoints);

      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        framework_specific: {
          version: await this.detectSpringBootVersion(context.projectPath),
          applicationFound: application !== null,
          controllersFound: controllers.length,
          servicesFound: services.length,
          configurationsFound: configurations.length,
          entitiesFound: entities.length,
          securityConfigured: security !== null
        }
      });

    } catch (error) {
      throw new AnalyzerError(
        `Spring Boot analysis failed: ${(error as Error).message}`,
        'SPRING_BOOT_ANALYSIS_ERROR'
      );
    }
  }

  private async analyzeApplication(
    files: string[],
    projectPath: string,
    nodes: CASNode[]
  ): Promise<SpringBootApplication | null> {
    for (const file of files) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      if (content.includes('@SpringBootApplication')) {
        const className = this.extractClassName(content);
        if (className) {
          const application: SpringBootApplication = {
            name: className,
            filePath: file,
            mainClass: className,
            configurationProperties: this.extractConfigurationProperties(content),
            enabledFeatures: this.extractEnabledFeatures(content)
          };

          const appId = `app_${this.sanitizeId(className)}`;
          const documentation = this.extractDocumentation(content, fullPath);
          const comments = this.extractComments(content, fullPath);
          const todos = this.extractTodos(comments);
          const implementationStatus = this.determineImplementationStatus(content, comments);

          const appNode = this.createNodeBuilder(appId, className, 'application')
            .withLevel(1, 'system')
            .withCategory('application', ['framework', 'spring-boot'])
            .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
            .withDescription(`Spring Boot application: ${className}`)
            .withDocumentation(documentation)
            .withComments(comments)
            .withTodos(todos)
            .withImplementationStatus(implementationStatus)
            .withMetadata({
              framework: 'spring-boot',
              attributes: {
                mainClass: className,
                configurationProperties: application.configurationProperties,
                enabledFeatures: application.enabledFeatures
              }
            })
            .build();
          nodes.push(appNode);

          return application;
        }
      }
    }
    return null;
  }

  private async analyzeControllers(
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: any[]
  ): Promise<SpringController[]> {
    const controllers: SpringController[] = [];

    for (const file of files) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      if (content.includes('@Controller') || content.includes('@RestController')) {
        const className = this.extractClassName(content);
        if (className) {
          const requestMapping = this.extractRequestMapping(content);
          const endpoints = this.extractEndpoints(content);
          const crossOrigin = content.includes('@CrossOrigin');
          const dependencies = this.extractFieldDependencies(content);

          const controller: SpringController = {
            name: className,
            filePath: file,
            requestMapping,
            endpoints,
            crossOrigin,
            dependencies
          };

          controllers.push(controller);

          const controllerId = `controller_${this.sanitizeId(className)}`;
          const controllerNode = this.createNodeBuilder(controllerId, className, 'controller')
            .withLevel(2, 'architectural')
            .withCategory('controller', ['api', 'rest'])
            .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
            .withDescription(`Spring Boot REST controller: ${className}`)
            .withMetadata({
              framework: 'spring-boot',
              attributes: {
                requestMapping,
                endpointCount: endpoints.length,
                crossOrigin,
                dependencies
              }
            })
            .build();
          nodes.push(controllerNode);

          endpoints.forEach((endpoint, index) => {
            const endpointId = `endpoint_${controllerId}_${endpoint.handlerName}_${index}`;
            const fullPath = `${requestMapping}${endpoint.path}`.replace('//', '/');

            const endpointNode = this.createNodeBuilder(endpointId, `${endpoint.method.toUpperCase()} ${fullPath}`, 'route')
              .withLevel(3, 'code')
              .withCategory('route', ['http', 'endpoint'])
              .withSource({ file: fullPath, line: 1, end_line: 1 })
              .withDescription(`Spring Boot HTTP endpoint: ${endpoint.method.toUpperCase()} ${fullPath}`)
              .withMetadata({
                framework: 'spring-boot',
                attributes: {
                  method: endpoint.method,
                  path: fullPath,
                  handlerName: endpoint.handlerName,
                  parameters: endpoint.parameters,
                  produces: endpoint.produces,
                  consumes: endpoint.consumes,
                  authenticated: endpoint.authenticated
                }
              })
              .build();
            nodes.push(endpointNode);

            edges.push(this.createEdge(
              `${controllerId}_exposes_${endpointId}`,
              controllerId,
              endpointId,
              'exposes'
            ));

            // Canonical HTTP entry point so the orchestrator's buildRouteTable
            // (filters ep.type==='http', reads trigger.method/path + security)
            // surfaces Spring routes in get_route_table, like Express/NestJS.
            // Normalize Spring's `{id}` path params to the `:id` route convention.
            const canonicalPath = fullPath.replace(/\{([^}]+)\}/g, ':$1');
            entryPoints.push(this.createEntryPoint(
              `entry_${endpointId}`,
              endpointId,
              'http',
              `${endpoint.method.toUpperCase()} ${canonicalPath}`,
              `Spring Boot HTTP endpoint: ${endpoint.method.toUpperCase()} ${canonicalPath}`,
              { method: endpoint.method.toUpperCase(), path: canonicalPath },
              { authenticated: endpoint.authenticated },
              { method: endpoint.method, path: canonicalPath, controller: className, handler: endpoint.handlerName, authenticated: endpoint.authenticated }
            ));
          });
        }
      }
    }

    return controllers;
  }

  private async analyzeServices(
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<SpringService[]> {
    const services: SpringService[] = [];

    for (const file of files) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      if (content.includes('@Service') || content.includes('@Component') || content.includes('@Repository')) {
        const className = this.extractClassName(content);
        if (className) {
          let stereotype: 'service' | 'component' | 'repository' = 'component';
          if (content.includes('@Service')) stereotype = 'service';
          else if (content.includes('@Repository')) stereotype = 'repository';

          const transactional = content.includes('@Transactional');
          const dependencies = this.extractFieldDependencies(content);
          const methods = this.extractMethods(content);

          const service: SpringService = {
            name: className,
            filePath: file,
            stereotype,
            transactional,
            dependencies,
            methods
          };

          services.push(service);

          const serviceId = `service_${this.sanitizeId(className)}`;
          let nodeType = 'service';
          let subcategories = ['injectable'];
          if (stereotype === 'repository') {
            nodeType = 'repository';
            subcategories = ['data-access', 'persistence'];
          } else if (stereotype === 'service') {
            subcategories = ['business-logic'];
          }

          const serviceNode = this.createNodeBuilder(serviceId, className, nodeType)
            .withLevel(2, 'architectural')
            .withCategory(nodeType, subcategories)
            .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
            .withDescription(`Spring Boot ${stereotype}: ${className}`)
            .withMetadata({
              framework: 'spring-boot',
              attributes: {
                stereotype,
                transactional,
                dependencies,
                methodCount: methods.length
              }
            })
            .build();
          nodes.push(serviceNode);

          methods.forEach((method, index) => {
            const methodId = `method_${serviceId}_${method.name}_${index}`;
            const methodNode = this.createNodeBuilder(methodId, method.name, 'method')
              .withLevel(4, 'member')
              .withCategory('method', ['function'])
              .withSource({ file: fullPath, line: 1, end_line: 1 })
              .withDescription(`Method in ${className}: ${method.name}`)
              .withMetadata({
                framework: 'spring-boot',
                attributes: {
                  parameters: method.parameters,
                  returnType: method.returnType,
                  transactional: method.transactional
                }
              })
              .build();
            nodes.push(methodNode);

            edges.push(this.createEdge(
              `${serviceId}_contains_${methodId}`,
              serviceId,
              methodId,
              'contains'
            ));
          });
        }
      }
    }

    return services;
  }

  private async analyzeConfigurations(
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<SpringConfiguration[]> {
    const configurations: SpringConfiguration[] = [];

    for (const file of files) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      if (content.includes('@Configuration')) {
        const className = this.extractClassName(content);
        if (className) {
          const beans = this.extractBeans(content);
          const properties = this.extractConfigurationProperties(content);
          const profiles = this.extractProfiles(content);

          const configuration: SpringConfiguration = {
            name: className,
            filePath: file,
            beans,
            properties,
            profiles
          };

          configurations.push(configuration);

          const configId = `config_${this.sanitizeId(className)}`;
          const configNode = this.createNodeBuilder(configId, className, 'service')
            .withLevel(2, 'architectural')
            .withCategory('service', ['configuration', 'spring'])
            .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
            .withDescription(`Spring Boot configuration: ${className}`)
            .withMetadata({
              framework: 'spring-boot',
              attributes: {
                beanCount: beans.length,
                properties,
                profiles
              }
            })
            .build();
          nodes.push(configNode);

          beans.forEach((bean, index) => {
            const beanId = `bean_${configId}_${bean.name}_${index}`;
            const beanNode = this.createNodeBuilder(beanId, bean.name, 'service')
              .withLevel(3, 'code')
              .withCategory('service', ['bean', 'spring'])
              .withSource({ file: fullPath, line: 1, end_line: 1 })
              .withDescription(`Spring bean: ${bean.name}`)
              .withMetadata({
                framework: 'spring-boot',
                attributes: {
                  type: bean.type,
                  scope: bean.scope,
                  primary: bean.primary,
                  conditional: bean.conditional
                }
              })
              .build();
            nodes.push(beanNode);

            edges.push(this.createEdge(
              `${configId}_defines_${beanId}`,
              configId,
              beanId,
              'defines'
            ));
          });
        }
      }
    }

    return configurations;
  }

  private async analyzeEntities(
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    exitPoints: any[]
  ): Promise<SpringEntity[]> {
    const entities: SpringEntity[] = [];

    for (const file of files) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      if (content.includes('@Entity') || content.includes('@Table')) {
        const className = this.extractClassName(content);
        if (className) {
          const table = this.extractTableName(content) || className.toLowerCase();
          const relationships = this.extractEntityRelationships(content);
          const fields = this.extractEntityFields(content);

          const entity: SpringEntity = {
            name: className,
            filePath: file,
            table,
            relationships,
            fields
          };

          entities.push(entity);

          const entityId = `entity_${this.sanitizeId(className)}`;
          const entityNode = this.createNodeBuilder(entityId, className, 'model')
            .withLevel(3, 'code')
            .withCategory('model', ['data', 'entity'])
            .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
            .withDescription(`JPA entity: ${className}`)
            .withMetadata({
              framework: 'spring-boot',
              attributes: {
                table,
                relationships: relationships.length,
                // The orchestrator's buildDataEntities() promotes a 'model'-type
                // node into a database_entities entry with real field evidence by
                // reading metadata.attributes.fields as an ARRAY of {name,type}
                // (its fallback path for schema-file-style analyzers that don't
                // emit one node per field, which is how this analyzer works).
                // Storing `fields.length` (a number) here made that Array.isArray
                // check fail silently, so every JPA entity surfaced with zero
                // fields even once the entity node itself was detected.
                fields
              }
            })
            .build();
          nodes.push(entityNode);

          exitPoints.push({
            id: `exit_db_${entityId}`,
            name: `Database table: ${table}`,
            type: 'database_table',
            source_node: entityId,
            metadata: {
              table,
              entity: className,
              fields: fields.map(f => f.name)
            }
          });
        }
      }
    }

    return entities;
  }

  private async analyzeSecurity(
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<SpringSecurity | null> {
    for (const file of files) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      if (content.includes('@EnableWebSecurity') || content.includes('SecurityConfig')) {
        const className = this.extractClassName(content);
        if (className) {
          const endpoints = this.extractSecurityEndpoints(content);
          const authenticationProvider = this.extractAuthenticationProvider(content);
          const passwordEncoder = this.extractPasswordEncoder(content);

          const security: SpringSecurity = {
            name: className,
            filePath: file,
            endpoints,
            authenticationProvider,
            passwordEncoder
          };

          const securityId = `security_${this.sanitizeId(className)}`;
          const securityNode = this.createNodeBuilder(securityId, className, 'service')
            .withLevel(2, 'architectural')
            .withCategory('service', ['security', 'configuration'])
            .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
            .withDescription(`Spring Security configuration: ${className}`)
            .withMetadata({
              framework: 'spring-boot',
              attributes: {
                endpointRules: endpoints.length,
                authenticationProvider,
                passwordEncoder
              }
            })
            .build();
          nodes.push(securityNode);

          return security;
        }
      }
    }
    return null;
  }

  /**
   * A class needs no access modifier to be a valid, fully-functional Spring
   * bean/controller/entity — package-private (default-visibility) classes are
   * a routine, idiomatic choice (a benchmarked Spring Boot reference app itself
   * declares its `@RestController`s as bare `class OwnerResource { ... }`,
   * no `public`). The previous `public\s+class` requirement silently dropped
   * every non-public component: 0 controllers/services/entities detected on
   * any codebase that follows this common style. Optional modifiers in any
   * order/combination (public|protected|abstract|final|static, though real
   * Java only uses valid combinations) now match, matching how JavaAnalyzer's
   * own `extractClasses` already treats modifiers as optional.
   */
  private extractClassName(content: string): string | null {
    const classMatch = content.match(/(?:\b(?:public|protected|private|abstract|final|static)\s+)*class\s+(\w+)/);
    return classMatch ? classMatch[1] : null;
  }

  /** Parse the string literal out of an annotation's parenthesized arguments,
   *  tolerating the `value = "..."` / `path = "..."` forms Spring allows in
   *  addition to the bare positional `@Xyz("...")` form — both are common in
   *  real code (`@GetMapping(value = "/{ownerId}")`) and the bare-literal-only
   *  match previously used here silently treated any `value=`/`path=` mapping
   *  as if the annotation had no path at all. */
  private extractAnnotationPathLiteral(rawArgs: string | undefined): string {
    if (!rawArgs) return '';
    const literalMatch = rawArgs.match(/(?:(?:value|path)\s*=\s*)?["']([^"']+)["']/);
    return literalMatch ? literalMatch[1] : '';
  }

  private extractRequestMapping(content: string): string {
    // Class-level @RequestMapping precedes the `class` keyword; restricting the
    // search to that header (rather than the whole file) keeps a method-level
    // @RequestMapping from being mistaken for the class-level base path.
    const classDeclIdx = content.search(/\bclass\s+\w/);
    const header = classDeclIdx >= 0 ? content.slice(0, classDeclIdx) : content;
    const mappingMatch = header.match(/@RequestMapping\s*\(([^)]*)\)/);
    return mappingMatch ? this.extractAnnotationPathLiteral(mappingMatch[1]) : '';
  }

  private extractEndpoints(content: string): SpringEndpoint[] {
    const endpoints: SpringEndpoint[] = [];
    // Return type must allow generics/arrays (`Optional<Owner>`, `List<Owner>`,
    // `ResponseEntity<List<Pet>>`, `Owner[]`) in addition to a bare type/`void` —
    // real handler methods routinely wrap their response, and the previous
    // `\w+`-only return type silently dropped every endpoint whose handler
    // returned a generic type (i.e. nearly all of them: `findOwner`/`findAll`
    // in the reference app both return `Optional<Owner>`/`List<Owner>`).
    // The mapping's own arguments are captured whole (group 2) so both the
    // bare-literal and `value=`/`path=` forms can be parsed uniformly.
    const methodPattern = /@(Get|Post|Put|Delete|Patch)Mapping\s*(?:\(([^)]*)\))?[\s\S]*?\b(?:public|protected)\s+(?:static\s+)?[\w.]+(?:<[^;{}]*>)?(?:\[\])*\s+(\w+)\s*\([^)]*\)/g;
    // A class-level @PreAuthorize/@Secured/@RolesAllowed (declared above the class
    // declaration) protects every endpoint. Method-level ones protect only their
    // own endpoint. Class-level = a security annotation appearing before `class`.
    const classDeclIdx = content.search(/\bclass\s+\w/);
    const classHeader = classDeclIdx >= 0 ? content.slice(0, classDeclIdx) : '';
    const classGuarded = /@(?:PreAuthorize|Secured|RolesAllowed)\b/.test(classHeader);

    let match;
    let prevEnd = 0;
    while ((match = methodPattern.exec(content)) !== null) {
      const method = match[1].toLowerCase();
      const path = this.extractAnnotationPathLiteral(match[2]);
      const handlerName = match[3];

      // Per-endpoint auth: a security annotation in the window from the previous
      // endpoint's end through this endpoint's signature guards THIS method only —
      // whether it sits just before the @…Mapping or between the mapping and
      // `public`. File-level inclusion would wrongly mark sibling open endpoints.
      const windowStart = endpoints.length === 0
        ? Math.max(0, content.lastIndexOf('}', match.index) + 1, prevEnd)
        : prevEnd;
      const window = content.slice(windowStart, match.index + match[0].length);
      const methodGuarded = /@(?:PreAuthorize|Secured|RolesAllowed)\b/.test(window);
      prevEnd = match.index + match[0].length;

      endpoints.push({
        method,
        path,
        handlerName,
        parameters: [],
        responseType: 'Object',
        produces: [],
        consumes: [],
        authenticated: classGuarded || methodGuarded
      });
    }

    return endpoints;
  }

  private extractFieldDependencies(content: string): string[] {
    const dependencies = new Set<string>();

    // Field injection: @Autowired private Type field;
    const fieldPattern = /@Autowired[\s\S]*?private\s+(\w+)\s+\w+;/g;
    let match;
    while ((match = fieldPattern.exec(content)) !== null) {
      dependencies.add(match[1]);
    }

    // Constructor injection (the modern Spring idiom, no @Autowired needed): the
    // ctor parameters of the component are its injected collaborators.
    const className = this.extractClassName(content);
    if (className) {
      const ctor = new RegExp(`(?:public\\s+)?${className}\\s*\\(([^)]*)\\)`).exec(content);
      if (ctor && ctor[1].trim()) {
        for (const param of ctor[1].split(',')) {
          // `final Type name` / `Type name` / `@Qualifier(..) Type name` -> Type.
          const pm = param.trim().match(/(?:@\w+(?:\([^)]*\))?\s+)*(?:final\s+)?([A-Z]\w*)\s+\w+\s*$/);
          if (pm) dependencies.add(pm[1]);
        }
      }
    }

    return [...dependencies];
  }

  private extractMethods(content: string): Array<{ name: string; parameters: any[]; returnType: string; transactional: boolean }> {
    const methods: Array<{ name: string; parameters: any[]; returnType: string; transactional: boolean }> = [];
    const methodPattern = /public\s+(\w+)\s+(\w+)\s*\([^)]*\)/g;

    let match;
    while ((match = methodPattern.exec(content)) !== null) {
      const returnType = match[1];
      const name = match[2];
      const transactional = content.includes('@Transactional');

      methods.push({
        name,
        parameters: [],
        returnType,
        transactional
      });
    }

    return methods;
  }

  private extractConfigurationProperties(content: string): string[] {
    const properties: string[] = [];
    const propertyPattern = /@Value\s*\(\s*["']\$\{([^}]+)\}["']\s*\)/g;

    let match;
    while ((match = propertyPattern.exec(content)) !== null) {
      properties.push(match[1]);
    }

    return properties;
  }

  private extractEnabledFeatures(content: string): string[] {
    const features: string[] = [];
    const enablePattern = /@Enable(\w+)/g;

    let match;
    while ((match = enablePattern.exec(content)) !== null) {
      features.push(match[1]);
    }

    return features;
  }

  private extractBeans(content: string): SpringBean[] {
    const beans: SpringBean[] = [];
    const beanPattern = /@Bean[\s\S]*?public\s+(\w+)\s+(\w+)\s*\(/g;

    let match;
    while ((match = beanPattern.exec(content)) !== null) {
      const type = match[1];
      const name = match[2];

      beans.push({
        name,
        type,
        scope: 'singleton',
        primary: content.includes('@Primary'),
        conditional: []
      });
    }

    return beans;
  }

  private extractProfiles(content: string): string[] {
    const profiles: string[] = [];
    const profilePattern = /@Profile\s*\(\s*["']([^"']+)["']\s*\)/g;

    let match;
    while ((match = profilePattern.exec(content)) !== null) {
      profiles.push(match[1]);
    }

    return profiles;
  }

  private extractTableName(content: string): string | null {
    const tableMatch = content.match(/@Table\s*\(\s*name\s*=\s*["']([^"']+)["']/);
    return tableMatch ? tableMatch[1] : null;
  }

  private extractEntityRelationships(content: string): Array<{ type: string; target: string; mappedBy?: string }> {
    const relationships: Array<{ type: string; target: string; mappedBy?: string }> = [];
    const relationPattern = /@(OneToOne|OneToMany|ManyToOne|ManyToMany)[\s\S]*?private\s+(?:List<)?(\w+)(?:>)?\s+\w+/g;

    let match;
    while ((match = relationPattern.exec(content)) !== null) {
      const type = match[1];
      const target = match[2];

      relationships.push({
        type,
        target
      });
    }

    return relationships;
  }

  private extractEntityFields(content: string): Array<{ name: string; type: string; annotations: string[] }> {
    const fields: Array<{ name: string; type: string; annotations: string[] }> = [];
    const fieldPattern = /private\s+(\w+)\s+(\w+);/g;

    let match;
    while ((match = fieldPattern.exec(content)) !== null) {
      const type = match[1];
      const name = match[2];

      fields.push({
        name,
        type,
        annotations: []
      });
    }

    return fields;
  }

  private extractSecurityEndpoints(content: string): Array<{ pattern: string; access: string }> {
    const endpoints: Array<{ pattern: string; access: string }> = [];
    const endpointPattern = /\.antMatchers\s*\(\s*["']([^"']+)["']\s*\)\.(\w+)\s*\(\s*(?:["']([^"']*)["']\s*)?\)/g;

    let match;
    while ((match = endpointPattern.exec(content)) !== null) {
      const pattern = match[1];
      const access = match[2];

      endpoints.push({
        pattern,
        access
      });
    }

    return endpoints;
  }

  private extractAuthenticationProvider(content: string): string {
    if (content.includes('DaoAuthenticationProvider')) return 'DaoAuthenticationProvider';
    if (content.includes('LdapAuthenticationProvider')) return 'LdapAuthenticationProvider';
    if (content.includes('JwtAuthenticationProvider')) return 'JwtAuthenticationProvider';
    return 'Default';
  }

  private extractPasswordEncoder(content: string): string {
    if (content.includes('BCryptPasswordEncoder')) return 'BCryptPasswordEncoder';
    if (content.includes('Pbkdf2PasswordEncoder')) return 'Pbkdf2PasswordEncoder';
    if (content.includes('SCryptPasswordEncoder')) return 'SCryptPasswordEncoder';
    return 'NoOpPasswordEncoder';
  }

  private async detectSpringBootVersion(projectPath: string): Promise<string> {
    try {
      const pomPath = path.join(projectPath, 'pom.xml');
      if (await fs.pathExists(pomPath)) {
        const pomContent = await fs.readFile(pomPath, 'utf-8');
        const versionMatch = pomContent.match(/<spring-boot\.version>([^<]+)<\/spring-boot\.version>/);
        if (versionMatch) return versionMatch[1];

        const parentVersionMatch = pomContent.match(/<parent>[\s\S]*?<version>([^<]+)<\/version>[\s\S]*?<\/parent>/);
        if (parentVersionMatch) return parentVersionMatch[1];
      }
    } catch {
      // Continue with other methods
    }

    return 'unknown';
  }

  private buildSpringBootRelationships(
    controllers: SpringController[],
    services: SpringService[],
    configurations: SpringConfiguration[],
    entities: SpringEntity[],
    nodes: CASNode[],
    edges: CASEdge[]
  ): void {
    controllers.forEach(controller => {
      const controllerId = `controller_${this.sanitizeId(controller.name)}`;

      controller.dependencies.forEach(depName => {
        const serviceId = `service_${this.sanitizeId(depName)}`;
        edges.push(this.createEdge(
          `${controllerId}_depends_on_${serviceId}`,
          controllerId,
          serviceId,
          'depends_on',
          'data',
          { dependency_type: 'injection' }
        ));
      });
    });

    services.forEach(service => {
      const serviceId = `service_${this.sanitizeId(service.name)}`;

      service.dependencies.forEach(depName => {
        const depServiceId = `service_${this.sanitizeId(depName)}`;
        edges.push(this.createEdge(
          `${serviceId}_depends_on_${depServiceId}`,
          serviceId,
          depServiceId,
          'depends_on',
          'data',
          { dependency_type: 'injection' }
        ));
      });
    });

    entities.forEach(entity => {
      const entityId = `entity_${this.sanitizeId(entity.name)}`;

      entity.relationships.forEach(relationship => {
        const targetEntityId = `entity_${this.sanitizeId(relationship.target)}`;
        edges.push(this.createEdge(
          `${entityId}_${relationship.type}_${targetEntityId}`,
          entityId,
          targetEntityId,
          relationship.type.toLowerCase()
        ));
      });
    });
  }

  private identifyDatabaseConnections(entities: SpringEntity[], exitPoints: any[]): void {
    if (entities.length > 0) {
      exitPoints.push({
        id: 'exit_jpa_database',
        name: 'JPA Database Connection',
        type: 'database_connection',
        source_node: 'spring_data_jpa',
        metadata: {
          entities: entities.map(e => e.name),
          tables: entities.map(e => e.table),
          orm: 'JPA/Hibernate'
        }
      });
    }
  }

  protected sanitizeId(name: string): string {
    return name.replace(/[^a-zA-Z0-9]/g, '_');
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'system';
      case 2: return 'architectural';
      case 3: return 'code';
      case 4: return 'member';
      case 5: return 'implementation';
      default: return `level_${level}`;
    }
  }

  protected getCapabilities(): string[] {
    return [
      'spring-boot-application-detection',
      'controller-mapping',
      'service-analysis',
      'entity-relationship-mapping',
      'security-configuration',
      'dependency-injection-analysis'
    ];
  }

  // CAS v1.4.0 Documentation and Comment extraction methods

  private extractDocumentation(content: string, filePath: string): CASDocumentation | undefined {
    if (!content || content.trim().length === 0) return undefined;

    const lines = content.split('\n');

    // Look for Spring Boot-specific documentation patterns

    // 1. @ApiOperation annotations
    const apiOperationMatches = content.matchAll(/@ApiOperation\s*\(\s*value\s*=\s*['"]([^'"]+)['"]/g);
    const apiOperations = [];
    for (const match of apiOperationMatches) {
      apiOperations.push(match[1]);
    }

    // 2. Controller method JavaDoc
    const javadocMatches = content.matchAll(/\/\*\*\s*\n[^*]*\*\s*([^@\n][^\n]*)\n[^*]*\*\//g);
    const javadocs = [];
    for (const match of javadocMatches) {
      javadocs.push(match[1].trim());
    }

    // 3. Entity class documentation
    const entityDocMatches = content.matchAll(/@Entity[^\n]*\n[^\n]*\/\*\*\s*\n[^*]*\*\s*([^@\n][^\n]*)\n[^*]*\*\/\s*(?:public\s+)?class/g);
    const entityDocs = [];
    for (const match of entityDocMatches) {
      entityDocs.push(match[1].trim());
    }

    // 4. Configuration property docs
    const configPropMatches = content.matchAll(/@ConfigurationProperties\s*\([^)]*\)[^\n]*\n[^\n]*\/\*\*\s*\n[^*]*\*\s*([^@\n][^\n]*)\n[^*]*\*\//g);
    const configDocs = [];
    for (const match of configPropMatches) {
      configDocs.push(match[1].trim());
    }

    if (apiOperations.length > 0 || javadocs.length > 0 || entityDocs.length > 0 || configDocs.length > 0) {
      const doc: CASDocumentation = {
        type: 'spring_boot_documentation',
        raw: content,
        location: { start_line: 1, end_line: lines.length }
      };

      if (javadocs.length > 0) {
        doc.summary = javadocs[0].split('\n')[0].trim();
        doc.description = javadocs[0].trim();
      }

      doc.framework_docs = {
        spring_boot: {}
      };

      return doc;
    }

    return undefined;
  }

  private extractComments(content: string, filePath: string): CASComment[] {
    if (!content || content.trim().length === 0) return [];

    const comments: CASComment[] = [];
    let commentSeq = 0;
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmedLine = line.trim();

      // Java single-line comments
      if (trimmedLine.startsWith('//')) {
        const commentText = trimmedLine.substring(2).trim();
        if (commentText.length > 0) {
          const comment: CASComment = {
            id: `comment_${filePath}_${++commentSeq}`,
            type: 'single-line',
            style: '//',
            text: commentText,
            purpose: this.classifyCommentPurpose(commentText),
            location: {
              file: filePath,
              line: i + 1
            },
            markers: {
              is_todo: commentText.toUpperCase().includes('TODO'),
              is_fixme: commentText.toUpperCase().includes('FIXME'),
              is_hack: commentText.toUpperCase().includes('HACK'),
              is_warning: commentText.toUpperCase().includes('WARNING'),
              is_note: commentText.toUpperCase().includes('NOTE')
            }
          };
          comments.push(comment);
        }
      }

      // Multi-line comments /* */
      if (trimmedLine.includes('/*') && !trimmedLine.includes('/**')) {
        let commentText = '';
        let j = i;
        let foundEnd = false;

        while (j < lines.length && !foundEnd) {
          const currentLine = lines[j].trim();
          if (currentLine.includes('*/')) {
            commentText += currentLine.replace('*/', '').replace('/*', '').trim();
            foundEnd = true;
          } else {
            commentText += currentLine.replace('/*', '').replace(/^\s*\*\s?/, '').trim() + ' ';
          }
          j++;
        }

        if (commentText.trim().length > 0) {
          const comment: CASComment = {
            id: `comment_${filePath}_${++commentSeq}`,
            type: 'multi-line',
            style: '/* */',
            text: commentText.trim(),
            purpose: this.classifyCommentPurpose(commentText.trim()),
            location: {
              file: filePath,
              line: i + 1
            },
            markers: {
              is_todo: commentText.toUpperCase().includes('TODO'),
              is_fixme: commentText.toUpperCase().includes('FIXME'),
              is_hack: commentText.toUpperCase().includes('HACK'),
              is_warning: commentText.toUpperCase().includes('WARNING'),
              is_note: commentText.toUpperCase().includes('NOTE')
            }
          };
          comments.push(comment);
        }

        i = j - 1; // Skip processed lines
      }
    }

    return comments;
  }

  private extractTodos(comments: CASComment[]): CASTodo[] {
    const todos: CASTodo[] = [];
    let todoSeq = 0;

    for (const comment of comments) {
      if (comment.markers?.is_todo || comment.markers?.is_fixme || comment.markers?.is_hack) {
        const text = comment.text;
        const typeMatch = text.match(/(TODO|FIXME|HACK|NOTE|WARNING|XXX)/i);
        const type = typeMatch ? typeMatch[0].toUpperCase() as CASTodo['type'] : 'TODO';

        const assigneeMatch = text.match(/TODO\s*\(\s*([^)]+)\s*\)/i);
        const assignee = assigneeMatch ? assigneeMatch[1].trim() : undefined;

        const priorityMatch = text.match(/\[(CRITICAL|HIGH|MEDIUM|LOW)\]/i);
        let priority: CASTodo['priority'] = 'medium';
        if (priorityMatch) {
          priority = priorityMatch[1].toLowerCase() as CASTodo['priority'];
        }

        const todo: CASTodo = {
          id: `todo_${comment.location.file}_${comment.location.line}_${++todoSeq}`,
          type,
          text: text.replace(/^(TODO|FIXME|HACK|NOTE|WARNING|XXX)\s*(\([^)]+\))?\s*:?\s*/i, '').trim(),
          priority,
          location: {
            file: comment.location.file,
            line: comment.location.line
          },
          assignee,
          classification: {
            category: this.classifyTodoCategory(text),
            technical_debt: type === 'TODO' || type === 'FIXME' || type === 'HACK'
          }
        };

        todos.push(todo);
      }
    }

    return todos;
  }

  private determineImplementationStatus(content: string, comments: CASComment[]): CASImplementationStatus {
    const indicators = {
      has_todo_markers: comments.some(c => c.markers?.is_todo),
      has_not_implemented_exceptions: content.includes('throw new UnsupportedOperationException') || content.includes('// TODO: implement'),
      has_stub_returns: content.includes('return null;') || content.includes('return Collections.emptyList();'),
      has_placeholder_code: content.includes('// TODO') || content.includes('// FIXME') || content.includes('// PLACEHOLDER'),
      has_hardcoded_values: /['\"](localhost|127\.0\.0\.1|test|example|demo|placeholder)['\"]/. test(content),
      has_commented_out_code: comments.some(c => c.text.includes('public ') || c.text.includes('private ') || c.text.includes('@'))
    };

    const indicatorCount = Object.values(indicators).filter(Boolean).length;
    let status: CASImplementationStatus['status'];
    let confidence = 0.8;

    if (content.includes('throw new UnsupportedOperationException')) {
      status = 'not-implemented';
      confidence = 0.95;
    } else if (indicatorCount >= 3) {
      status = 'stub';
      confidence = 0.7;
    } else if (indicatorCount >= 1) {
      status = 'partial';
      confidence = 0.6;
    } else if (content.includes('@Deprecated') || content.includes('// deprecated')) {
      status = 'deprecated';
      confidence = 0.9;
    } else if (content.includes('experimental') || content.includes('beta')) {
      status = 'experimental';
      confidence = 0.8;
    } else {
      status = 'complete';
      confidence = 0.7;
    }

    const missingFeatures = [];
    if (indicators.has_not_implemented_exceptions) missingFeatures.push('Core implementation');
    if (indicators.has_todo_markers) missingFeatures.push('TODO items');
    if (indicators.has_stub_returns) missingFeatures.push('Method implementations');

    return {
      status,
      indicators,
      confidence,
      completeness: {
        estimated_percentage: status === 'complete' ? 90 : status === 'partial' ? 60 : status === 'stub' ? 30 : 10,
        missing_features: missingFeatures,
        implemented_features: status === 'complete' ? ['Core functionality'] : []
      }
    };
  }

  private classifyCommentPurpose(text: string): CASComment['purpose'] {
    const upperText = text.toUpperCase();
    if (upperText.includes('TODO') || upperText.includes('FIXME')) return 'todo';
    if (upperText.includes('WARNING') || upperText.includes('WARN')) return 'warning';
    if (upperText.includes('HACK') || upperText.includes('WORKAROUND')) return 'hack';
    if (upperText.includes('NOTE') || upperText.includes('INFO')) return 'note';
    if (upperText.includes('DISABLED') || upperText.includes('COMMENTED')) return 'disabled-code';
    return 'explanation';
  }

  private classifyTodoCategory(text: string): 'bug' | 'feature' | 'refactor' | 'performance' | 'security' | 'documentation' | 'test' | undefined {
    const lowerText = text.toLowerCase();
    if (lowerText.includes('bug') || lowerText.includes('fix') || lowerText.includes('error')) return 'bug';
    if (lowerText.includes('security') || lowerText.includes('auth') || lowerText.includes('permission')) return 'security';
    if (lowerText.includes('performance') || lowerText.includes('optimize') || lowerText.includes('slow')) return 'performance';
    if (lowerText.includes('test') || lowerText.includes('spec') || lowerText.includes('coverage')) return 'test';
    if (lowerText.includes('refactor') || lowerText.includes('cleanup') || lowerText.includes('reorganize')) return 'refactor';
    if (lowerText.includes('doc') || lowerText.includes('comment') || lowerText.includes('explain')) return 'documentation';
    return 'feature';
  }
}
