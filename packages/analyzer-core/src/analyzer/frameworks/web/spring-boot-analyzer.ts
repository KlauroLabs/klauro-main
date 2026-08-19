import { BaseAnalyzer, AnalysisContext } from '../../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint,
  CASDocumentation, CASComment, CASTodo, CASImplementationStatus
} from "../../../types/cas.types";
import { AnalyzerError } from '../../core/errors';
import * as path from 'path';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../../core/glob-cache';
import { extractSpringEndpointParameters, extractSpringResponseStatus, type SpringEndpointParameter } from './spring-web-contract';
import { discoverSpringOperationalDependencies } from './spring-operational-dependencies';

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
  parameters: SpringEndpointParameter[];
  responseType: string;
  responseStatus?: number;
  produces: string[];
  consumes: string[];
  authenticated: boolean;

  line: number;
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

  private getJavaIgnorePatterns(context: AnalysisContext | { projectPath: string }): string[] {
    return this.getPackageDirSafeIgnorePatterns(context as AnalysisContext);
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

      const application = await this.analyzeApplication(javaFiles, context.projectPath, nodes, entryPoints);
      const controllers = await this.analyzeControllers(javaFiles, context.projectPath, nodes, edges, entryPoints);
      const services = await this.analyzeServices(javaFiles, context.projectPath, nodes, edges);
      const configurations = await this.analyzeConfigurations(javaFiles, context.projectPath, nodes, edges);
      const entities = await this.analyzeEntities(javaFiles, context.projectPath, nodes, edges, exitPoints);
      const security = await this.analyzeSecurity(javaFiles, context.projectPath, nodes, edges);

      await this.analyzeMessagingTriggers(javaFiles, context.projectPath, nodes, entryPoints);
      const operationalDependencies = await discoverSpringOperationalDependencies({
        projectPath: context.projectPath,
        application,
        ignorePatterns: this.getJavaIgnorePatterns(context),
      });
      nodes.push(...operationalDependencies.nodes);
      exitPoints.push(...operationalDependencies.exitPoints);

      this.buildSpringBootRelationships(controllers, services, configurations, entities, nodes, edges);
      this.identifyDatabaseConnections(entities, nodes, exitPoints);

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
    nodes: CASNode[],
    entryPoints: CASEntryPoint[]
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
            .withSource({ file: file, line: 1, end_line: content.split('\n').length })
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
          entryPoints.push(this.createEntryPoint(
            `entry_${appId}`,
            appId,
            'lifecycle',
            `${className} startup`,
            `Spring Boot application startup for ${className}`,
            { event: 'application-start' },
            undefined,
            { framework: 'spring-boot', mainClass: className },
            { node_id: appId, method_name: 'main', file, line: 1 }
          ));

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
            .withSource({ file: file, line: 1, end_line: content.split('\n').length })
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

            const routePath = `${requestMapping}${endpoint.path}`.replace('//', '/');

            const endpointNode = this.createNodeBuilder(endpointId, `${endpoint.method.toUpperCase()} ${routePath}`, 'route')
              .withLevel(3, 'code')
              .withCategory('route', ['http', 'endpoint'])
              .withSource({ file: file, line: endpoint.line, end_line: endpoint.line })
              .withDescription(`Spring Boot HTTP endpoint: ${endpoint.method.toUpperCase()} ${routePath}`)
              .withMetadata({
                framework: 'spring-boot',
                attributes: {
                  method: endpoint.method,
                  path: routePath,
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

            const canonicalPath = routePath.replace(/\{([^}]+)\}/g, ':$1');
            const entryPoint = this.createEntryPoint(
              `entry_${endpointId}`,
              endpointId,
              'http',
              `${endpoint.method.toUpperCase()} ${canonicalPath}`,
              `Spring Boot HTTP endpoint: ${endpoint.method.toUpperCase()} ${canonicalPath}`,
              {
                method: endpoint.method.toUpperCase(),
                path: canonicalPath,
                parameters: endpoint.parameters.map(parameter => ({
                  name: parameter.name,
                  type: parameter.type,
                  required: parameter.required,
                  location: parameter.location
                }))
              },
              { authenticated: endpoint.authenticated },
              { method: endpoint.method, path: canonicalPath, controller: className, handler: endpoint.handlerName, authenticated: endpoint.authenticated },
              { node_id: endpointId, method_name: endpoint.handlerName, file: file, line: endpoint.line }
            );
            entryPoint.input = {
              type: endpoint.parameters.some(parameter => parameter.location === 'body') ? 'request-body' : 'parameters',
              fields: endpoint.parameters.map(parameter => ({ name: parameter.name, type: parameter.type })),
              validation: [...new Set(endpoint.parameters.flatMap(parameter => parameter.validations))]
            };
            entryPoint.output = {
              type: endpoint.responseType,
              status_codes: endpoint.responseStatus ? [endpoint.responseStatus] : undefined,
              is_void: endpoint.responseType === 'void'
            };
            entryPoints.push(entryPoint);
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
            .withSource({ file: file, line: 1, end_line: content.split('\n').length })
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
              .withSource({ file: file, line: 1, end_line: 1 })
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
            .withSource({ file: file, line: 1, end_line: content.split('\n').length })
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
              .withSource({ file: file, line: 1, end_line: 1 })
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
            .withSource({ file: file, line: 1, end_line: content.split('\n').length })
            .withDescription(`JPA entity: ${className}`)
            .withMetadata({
              framework: 'spring-boot',
              attributes: {
                table,
                relationships: relationships.length,

                fields
              }
            })
            .build();
          nodes.push(entityNode);

          exitPoints.push({
            id: `exit_db_${entityId}`,
            name: `Database table: ${table}`,
            type: 'database',
            source_node: entityId,
            target: { resource: table },
            operation: { action: 'persistence' },
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
            .withSource({ file: file, line: 1, end_line: content.split('\n').length })
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

  private async analyzeMessagingTriggers(
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    entryPoints: CASEntryPoint[]
  ): Promise<void> {
    const TRIGGER_ANNOTATIONS = [
      '@KafkaListener', '@RabbitListener', '@JmsListener', '@Scheduled',
      '@EventListener', '@TransactionalEventListener', '@MessageMapping',
      '@SubscribeMapping', '@QueryMapping', '@MutationMapping', '@SchemaMapping'
    ];

    for (const file of files) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');
      if (!TRIGGER_ANNOTATIONS.some(marker => content.includes(marker))) continue;

      const className = this.extractClassName(content);
      if (!className) continue;

      this.emitAnnotatedTriggers(content, className, file, 'KafkaListener', 'message',
        (rawArgs, handlerName) => {
          const topics = this.extractNamedListLiteral(rawArgs, 'topics?');
          const groupId = rawArgs?.match(/groupId\s*=\s*["']([^"']+)["']/)?.[1];
          const label = topics.length ? topics.join(', ') : 'unknown-topic';
          return {
            name: `Kafka listener: ${label}`,
            description: `Spring Kafka listener ${className}.${handlerName} on topic(s) ${label}`,
            trigger: { event: label },
            metadata: { topics, groupId }
          };
        }, nodes, entryPoints);

      this.emitAnnotatedTriggers(content, className, file, 'RabbitListener', 'message',
        (rawArgs, handlerName) => {
          const queues = this.extractNamedListLiteral(rawArgs, 'queues?');
          const label = queues.length ? queues.join(', ') : 'unknown-queue';
          return {
            name: `RabbitMQ listener: ${label}`,
            description: `Spring RabbitMQ listener ${className}.${handlerName} on queue(s) ${label}`,
            trigger: { event: label },
            metadata: { queues }
          };
        }, nodes, entryPoints);

      this.emitAnnotatedTriggers(content, className, file, 'JmsListener', 'message',
        (rawArgs, handlerName) => {
          const destinations = this.extractNamedListLiteral(rawArgs, 'destination');
          const label = destinations.length ? destinations.join(', ') : 'unknown-destination';
          return {
            name: `JMS listener: ${label}`,
            description: `Spring JMS listener ${className}.${handlerName} on destination ${label}`,
            trigger: { event: label },
            metadata: { destinations }
          };
        }, nodes, entryPoints);

      this.emitAnnotatedTriggers(content, className, file, 'Scheduled', 'schedule',
        (rawArgs, handlerName) => {
          const cron = rawArgs?.match(/cron\s*=\s*["']([^"']+)["']/)?.[1];
          const fixedRate = rawArgs?.match(/fixedRate\s*=\s*["']?(\d+)["']?/)?.[1];
          const fixedDelay = rawArgs?.match(/fixedDelay\s*=\s*["']?(\d+)["']?/)?.[1];
          const label = cron
            ? `cron: ${cron}`
            : fixedRate
              ? `every ${fixedRate}ms`
              : fixedDelay
                ? `every ${fixedDelay}ms (delay)`
                : 'unspecified schedule';
          return {
            name: `Scheduled task: ${className}.${handlerName}`,
            description: `Spring @Scheduled task ${className}.${handlerName} (${label})`,
            trigger: { schedule: cron || (fixedRate ? `fixedRate:${fixedRate}` : fixedDelay ? `fixedDelay:${fixedDelay}` : undefined) },
            metadata: {
              cron,
              fixedRate: fixedRate ? Number(fixedRate) : undefined,
              fixedDelay: fixedDelay ? Number(fixedDelay) : undefined
            }
          };
        }, nodes, entryPoints);

      for (const annotationName of ['EventListener', 'TransactionalEventListener'] as const) {
        this.emitAnnotatedTriggers(content, className, file, annotationName, 'event',
          (rawArgs, handlerName) => {
            const eventType = rawArgs?.match(/(\w+)\.class/)?.[1];
            const label = eventType || 'application event';
            return {
              name: `Event listener: ${className}.${handlerName}`,
              description: `Spring ${annotationName} ${className}.${handlerName} for ${label}`,
              trigger: { event: label },
              metadata: { eventType }
            };
          }, nodes, entryPoints);
      }

      for (const annotationName of ['MessageMapping', 'SubscribeMapping'] as const) {
        this.emitAnnotatedTriggers(content, className, file, annotationName, 'message',
          (rawArgs, handlerName) => {
            const destination = this.extractAnnotationPathLiteral(rawArgs);
            const label = destination || 'unknown-destination';
            return {
              name: `${annotationName === 'MessageMapping' ? 'STOMP message handler' : 'STOMP subscription handler'}: ${label}`,
              description: `Spring ${annotationName} ${className}.${handlerName} on destination ${label}`,
              trigger: { event: label, path: destination || undefined },
              metadata: { destination }
            };
          }, nodes, entryPoints);
      }

      for (const annotationName of ['QueryMapping', 'MutationMapping', 'SchemaMapping'] as const) {
        this.emitAnnotatedTriggers(content, className, file, annotationName, 'http',
          (rawArgs, handlerName) => {
            const name = rawArgs?.match(/name\s*=\s*["']([^"']+)["']/)?.[1] || handlerName;
            const opKind = annotationName === 'QueryMapping' ? 'Query'
              : annotationName === 'MutationMapping' ? 'Mutation'
              : 'SchemaMapping';
            return {
              name: `GraphQL ${opKind}: ${name}`,
              description: `Spring GraphQL ${opKind} ${className}.${handlerName} (${name})`,
              trigger: { method: opKind.toUpperCase(), path: name },
              metadata: { operation: name, operationType: opKind }
            };
          }, nodes, entryPoints);
      }
    }
  }

  private emitAnnotatedTriggers(
    content: string,
    className: string,
    relativeFile: string,
    annotationName: string,
    entryType: CASEntryPoint['type'],
    buildMeta: (rawArgs: string | undefined, handlerName: string) => {
      name: string;
      description: string;
      trigger?: CASEntryPoint['trigger'];
      metadata: Record<string, any>;
    },
    nodes: CASNode[],
    entryPoints: CASEntryPoint[]
  ): void {
    if (!content.includes(`@${annotationName}`)) return;

    const pattern = new RegExp(
      `@${annotationName}\\s*(?:\\(([^)]*)\\))?[\\s\\S]*?\\b(?:public|protected)\\s+(?:static\\s+)?[\\w.]+(?:<[^;{}]*>)?(?:\\[\\])*\\s+(\\w+)\\s*\\([^)]*\\)`,
      'g'
    );

    let match;
    let seq = 0;
    while ((match = pattern.exec(content)) !== null) {
      const rawArgs = match[1];
      const handlerName = match[2];
      const line = this.getLineNumber(content, match.index);
      const built = buildMeta(rawArgs, handlerName);

      const nodeId = `trigger_${this.sanitizeId(className)}_${this.sanitizeId(annotationName)}_${this.sanitizeId(handlerName)}_${seq}`;
      const node = this.createNodeBuilder(nodeId, built.name, 'trigger')
        .withLevel(3, 'code')
        .withCategory('trigger', [entryType, annotationName])
        .withSource({ file: relativeFile, line, end_line: line })
        .withDescription(built.description)
        .withMetadata({
          framework: 'spring-boot',
          attributes: { annotation: annotationName, handlerName, class: className, ...built.metadata }
        })
        .build();
      nodes.push(node);

      entryPoints.push(this.createEntryPoint(
        `entry_${nodeId}`,
        nodeId,
        entryType,
        built.name,
        built.description,
        built.trigger,
        undefined,
        { annotation: annotationName, handlerName, class: className, ...built.metadata },
        { node_id: nodeId, method_name: handlerName, file: relativeFile, line }
      ));

      seq++;
    }
  }

  private extractNamedListLiteral(rawArgs: string | undefined, keyPattern: string): string[] {
    if (!rawArgs) return [];
    const keyMatch = rawArgs.match(new RegExp(`${keyPattern}\\s*=\\s*(\\{[^}]*\\}|["'][^"']*["'])`));
    if (!keyMatch) return [];
    const literals: string[] = [];
    const literalPattern = /["']([^"']+)["']/g;
    let match;
    while ((match = literalPattern.exec(keyMatch[1])) !== null) {
      literals.push(match[1]);
    }
    return literals;
  }

  private extractClassName(content: string): string | null {
    const classMatch = content.match(/(?:\b(?:public|protected|private|abstract|final|static)\s+)*class\s+(\w+)/);
    return classMatch ? classMatch[1] : null;
  }

  private extractAnnotationPathLiteral(rawArgs: string | undefined): string {
    if (!rawArgs) return '';
    const literalMatch = rawArgs.match(/(?:(?:value|path)\s*=\s*)?["']([^"']+)["']/);
    return literalMatch ? literalMatch[1] : '';
  }

  private extractRequestMapping(content: string): string {

    const classDeclIdx = content.search(/\bclass\s+\w/);
    const header = classDeclIdx >= 0 ? content.slice(0, classDeclIdx) : content;
    const mappingMatch = header.match(/@RequestMapping\s*\(([^)]*)\)/);
    return mappingMatch ? this.extractAnnotationPathLiteral(mappingMatch[1]) : '';
  }

  private extractEndpoints(content: string): SpringEndpoint[] {

    const methodPattern = /@(Get|Post|Put|Delete|Patch)Mapping\s*(?:\(([^)]*)\))?[\s\S]*?\b(?:public|protected)\s+(?:static\s+)?([\w.$]+(?:\s*<[^;{}]*>)?(?:\[\])*)\s+(\w+)\s*\(([\s\S]*?)\)\s*(?:throws\s+[^{]+)?\{/g;

    const classDeclIdx = content.search(/\bclass\s+\w/);
    const classHeader = classDeclIdx >= 0 ? content.slice(0, classDeclIdx) : '';
    const classGuarded = /@(?:PreAuthorize|Secured|RolesAllowed)\b/.test(classHeader);

    interface RawMapping {
      index: number;
      end: number;
      verbs: string[];
      rawArgs?: string;
      handlerName: string;
      responseType: string;
      parameterSource: string;
    }
    const rawMappings: RawMapping[] = [];

    let match;
    while ((match = methodPattern.exec(content)) !== null) {
      rawMappings.push({
        index: match.index,
        end: match.index + match[0].length,
        verbs: [match[1].toLowerCase()],
        rawArgs: match[2],
        responseType: match[3].replace(/\s+/g, ' ').trim(),
        handlerName: match[4],
        parameterSource: match[5]
      });
    }

    const bareRequestMappingPattern = /@RequestMapping\s*(?:\(([^)]*)\))?[\s\S]*?\b(?:public|protected)\s+(?:static\s+)?[\w.]+(?:<[^;{}]*>)?(?:\[\])*\s+(\w+)\s*\([^)]*\)/g;
    while ((match = bareRequestMappingPattern.exec(content)) !== null) {
      if (classDeclIdx >= 0 && match.index < classDeclIdx) continue;
      rawMappings.push({
        index: match.index,
        end: match.index + match[0].length,
        verbs: this.extractRequestMappingVerbs(match[1]),
        rawArgs: match[1],
        handlerName: match[2],
        responseType: 'Object',
        parameterSource: ''
      });
    }

    rawMappings.sort((a, b) => a.index - b.index);

    const endpoints: SpringEndpoint[] = [];
    let prevEnd = 0;
    rawMappings.forEach((rm, i) => {
      const path = this.extractAnnotationPathLiteral(rm.rawArgs);
      const line = this.getLineNumber(content, rm.index);

      const windowStart = i === 0
        ? Math.max(0, content.lastIndexOf('}', rm.index) + 1, prevEnd)
        : prevEnd;
      const window = content.slice(windowStart, rm.end);
      const methodGuarded = /@(?:PreAuthorize|Secured|RolesAllowed)\b/.test(window);
      prevEnd = rm.end;

      for (const method of rm.verbs) {
        endpoints.push({
          method,
          path,
          handlerName: rm.handlerName,
          parameters: extractSpringEndpointParameters(rm.parameterSource),
          responseType: rm.responseType,
          responseStatus: extractSpringResponseStatus(window),
          produces: [],
          consumes: [],
          authenticated: classGuarded || methodGuarded,
          line
        });
      }
    });

    return endpoints;
  }

  private extractRequestMappingVerbs(rawArgs: string | undefined): string[] {
    if (!rawArgs) return ['all'];
    const verbs: string[] = [];
    const verbPattern = /RequestMethod\.(\w+)/g;
    let match;
    while ((match = verbPattern.exec(rawArgs)) !== null) {
      verbs.push(match[1].toLowerCase());
    }
    return verbs.length > 0 ? verbs : ['all'];
  }

  private getLineNumber(content: string, index: number): number {
    return content.slice(0, index).split('\n').length;
  }

  private extractFieldDependencies(content: string): string[] {
    const dependencies = new Set<string>();

    const fieldPattern = /@Autowired[\s\S]*?private\s+(\w+)\s+\w+;/g;
    let match;
    while ((match = fieldPattern.exec(content)) !== null) {
      dependencies.add(match[1]);
    }

    const className = this.extractClassName(content);
    if (className) {
      const ctor = new RegExp(`(?:public\\s+)?${className}\\s*\\(([^)]*)\\)`).exec(content);
      if (ctor && ctor[1].trim()) {
        for (const param of ctor[1].split(',')) {

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
    const resolveNodeId = (name: string, fallbackType: string): string => {
      const normalizedName = name.replace(/<.*>$/, '').split(/[.$]/).filter(Boolean).pop() || name;
      const candidates = nodes.filter(node => {
        const nodeName = node.name.replace(/<.*>$/, '').split(/[.$]/).filter(Boolean).pop() || node.name;
        return nodeName === normalizedName && (node.level === undefined || node.level <= 3);
      });
      const candidateIds = [...new Set(candidates.map(node => node.id))];
      if (candidateIds.length === 1) return candidateIds[0];

      const nodeId = `${fallbackType}_${this.sanitizeId(name)}`;
      if (!nodes.some(node => node.id === nodeId)) {
        nodes.push(this.createNode(
          nodeId,
          name,
          fallbackType,
          3,
          undefined,
          undefined,
          undefined,
          {
            framework: 'spring-boot',
            resolution: candidateIds.length === 0 ? 'unresolved' : 'ambiguous',
            candidate_node_ids: candidateIds,
          }
        ));
      }
      return nodeId;
    };

    controllers.forEach(controller => {
      const controllerId = `controller_${this.sanitizeId(controller.name)}`;

      controller.dependencies.forEach(depName => {
        const serviceId = resolveNodeId(depName, 'injected_dependency');
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
        const depServiceId = resolveNodeId(depName, 'injected_dependency');
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
        const targetEntityId = resolveNodeId(relationship.target, 'entity_reference');
        edges.push(this.createEdge(
          `${entityId}_${relationship.type}_${targetEntityId}`,
          entityId,
          targetEntityId,
          relationship.type.toLowerCase()
        ));
      });
    });
  }

  private identifyDatabaseConnections(entities: SpringEntity[], nodes: CASNode[], exitPoints: CASExitPoint[]): void {
    if (entities.length > 0) {
      const nodeId = 'spring_data_jpa';
      if (!nodes.some(node => node.id === nodeId)) {
        nodes.push(this.createNodeBuilder(nodeId, 'JPA Database', 'repository')
          .withLevel(2, 'architectural')
          .withCategory('repository', ['database', 'jpa', 'hibernate'])
          .withDescription('JPA persistence boundary')
          .withMetadata({
            framework: 'spring-data-jpa',
            attributes: { entities: entities.map(entity => entity.name), tables: entities.map(entity => entity.table) }
          })
          .build());
      }
      exitPoints.push(this.createExitPoint(
        'exit_jpa_database',
        nodeId,
        'database',
        'JPA Database Connection',
        'JPA and Hibernate persistence boundary',
        { resource: entities.map(entity => entity.table).join(',') },
        { action: 'persist' },
        { entities: entities.map(entity => entity.name), tables: entities.map(entity => entity.table), orm: 'JPA/Hibernate' }
      ));
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

  private extractDocumentation(content: string, filePath: string): CASDocumentation | undefined {
    if (!content || content.trim().length === 0) return undefined;

    const lines = content.split('\n');

    const apiOperationMatches = content.matchAll(/@ApiOperation\s*\(\s*value\s*=\s*['"]([^'"]+)['"]/g);
    const apiOperations = [];
    for (const match of apiOperationMatches) {
      apiOperations.push(match[1]);
    }

    const javadocMatches = content.matchAll(/\/\*\*\s*\n[^*]*\*\s*([^@\n][^\n]*)\n[^*]*\*\//g);
    const javadocs = [];
    for (const match of javadocMatches) {
      javadocs.push(match[1].trim());
    }

    const entityDocMatches = content.matchAll(/@Entity[^\n]*\n[^\n]*\/\*\*\s*\n[^*]*\*\s*([^@\n][^\n]*)\n[^*]*\*\/\s*(?:public\s+)?class/g);
    const entityDocs = [];
    for (const match of entityDocMatches) {
      entityDocs.push(match[1].trim());
    }

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

        i = j - 1;
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
