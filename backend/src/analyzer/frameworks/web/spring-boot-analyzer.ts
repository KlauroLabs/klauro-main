import { BaseAnalyzer, AnalysisContext } from '../../core/base-analyzer';
import { CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint } from '../../../types/cas.types';
import { AnalyzerError } from '../../core/errors';
import * as path from 'path';
import * as fs from 'fs-extra';
import { glob } from 'glob';

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
      'spring-boot-analyzer',
      'Spring Boot Framework Analyzer',
      '1.0.0',
      'framework'
    );
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
        ignore: ['**/target/**', '**/build/**', '**/.git/**', '**/bin/**', '**/out/**', '**/*.class']
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
        ignore: ['**/target/**', '**/build/**', '**/.git/**', '**/bin/**', '**/out/**', '**/*.class', '**/test/**']
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
          const appNode = this.createNodeBuilder(appId, className, 'application')
            .withLevel(1, 'system')
            .withCategory('application', ['framework', 'spring-boot'])
            .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
            .withDescription(`Spring Boot application: ${className}`)
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

            entryPoints.push({
              id: `entry_${endpointId}`,
              name: `${endpoint.method.toUpperCase()} ${fullPath}`,
              type: 'rest_api',
              source_node: endpointId,
              metadata: {
                method: endpoint.method,
                path: fullPath,
                controller: className,
                authenticated: endpoint.authenticated
              }
            });
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
                fields: fields.length
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

  private extractClassName(content: string): string | null {
    const classMatch = content.match(/public\s+class\s+(\w+)/);
    return classMatch ? classMatch[1] : null;
  }

  private extractRequestMapping(content: string): string {
    const mappingMatch = content.match(/@RequestMapping\s*\(\s*["']([^"']+)["']/);
    return mappingMatch ? mappingMatch[1] : '';
  }

  private extractEndpoints(content: string): SpringEndpoint[] {
    const endpoints: SpringEndpoint[] = [];
    const methodPattern = /@(Get|Post|Put|Delete|Patch)Mapping\s*(?:\(\s*["']([^"']+)["'])?[\s\S]*?public\s+\w+\s+(\w+)\s*\([^)]*\)/g;

    let match;
    while ((match = methodPattern.exec(content)) !== null) {
      const method = match[1].toLowerCase();
      const path = match[2] || '';
      const handlerName = match[3];

      endpoints.push({
        method,
        path,
        handlerName,
        parameters: [],
        responseType: 'Object',
        produces: [],
        consumes: [],
        authenticated: content.includes('@PreAuthorize') || content.includes('@Secured')
      });
    }

    return endpoints;
  }

  private extractFieldDependencies(content: string): string[] {
    const dependencies: string[] = [];
    const fieldPattern = /@Autowired[\s\S]*?private\s+(\w+)\s+\w+;/g;

    let match;
    while ((match = fieldPattern.exec(content)) !== null) {
      dependencies.push(match[1]);
    }

    return dependencies;
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
          'depends_on'
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
          'depends_on'
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
}