import { BaseAnalyzer, AnalysisContext, FileAnalysisContext } from '../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint, FileAnalysisResult
} from '../../types/cas.types';
import { AnalyzerError } from '../core/errors';
import * as fs from 'fs-extra';
import * as path from 'path';
import { glob } from 'glob';

interface RubyMethod {
  name: string;
  visibility: 'public' | 'private' | 'protected';
  isSingleton: boolean;
  parameters: string[];
  lineStart: number;
  lineEnd: number;
}

interface RubyAttribute {
  name: string;
  kind: 'accessor' | 'reader' | 'writer';
  lineNumber: number;
}

interface RubyConstant {
  name: string;
  value: string;
  lineNumber: number;
}

interface RubyClass {
  name: string;
  qualifiedName: string;
  superclass?: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  methods: RubyMethod[];
  constants: RubyConstant[];
  attributes: RubyAttribute[];
  includedModules: string[];
  extendedModules: string[];
}

interface RubyModule {
  name: string;
  qualifiedName: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  methods: RubyMethod[];
  constants: RubyConstant[];
}

interface RubyRequire {
  target: string;
  relative: boolean;
  lineNumber: number;
}

interface RubyFileAnalysis {
  classes: RubyClass[];
  modules: RubyModule[];
  topLevelMethods: RubyMethod[];
  topLevelConstants: RubyConstant[];
  requires: RubyRequire[];
}

interface ScopeFrame {
  kind: 'class' | 'module' | 'def' | 'singleton' | 'block';
  classRef?: RubyClass;
  moduleRef?: RubyModule;
  methodRef?: RubyMethod;
  visibility: 'public' | 'private' | 'protected';
  lineStart: number;
}

const BLOCK_KEYWORD_PATTERN = /^(if|unless|while|until|case|begin|for)\b/;
const TRAILING_DO_PATTERN = /(^|[\s)])do(\s*\|[^|]*\|)?\s*$/;
const END_PATTERN = /^end\b/;
const CLASS_PATTERN = /^class\s+([A-Z][\w:]*)(?:\s*<\s*([A-Z][\w:]*))?/;
const SINGLETON_CLASS_PATTERN = /^class\s*<<\s*self/;
const MODULE_PATTERN = /^module\s+([A-Z][\w:]*)/;
const DEF_PATTERN = /^def\s+(self\.)?([\w?!=\[\]<>+\-*\/%~^&|]+)\s*(?:\(([^)]*)\))?/;
const ENDLESS_DEF_PATTERN = /^def\s+(self\.)?[\w?!=]+\s*(?:\([^)]*\))?\s*=/;
const REQUIRE_PATTERN = /^require(_relative)?\s+['"]([^'"]+)['"]/;
const CONSTANT_PATTERN = /^([A-Z][A-Z0-9_]*)\s*=\s*(.+)$/;
const ATTR_PATTERN = /^attr_(accessor|reader|writer)\s+(.+)$/;
const MIXIN_PATTERN = /^(include|extend|prepend)\s+([A-Z][\w:]*(?:\s*,\s*[A-Z][\w:]*)*)/;
const VISIBILITY_PATTERN = /^(private|protected|public)\s*$/;
const GEM_PATTERN = /^\s*gem\s+['"]([^'"]+)['"]/;

export class RubyAnalyzer extends BaseAnalyzer {
  constructor() {
    super(
      'ruby',
      'Ruby Analyzer',
      '1.0.0',
      'language'
    );
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const rubyFiles = await glob(['**/*.rb'], {
        cwd: projectPath,
        ignore: this.getRubyIgnorePatterns({ projectPath }),
        nodir: true
      });
      if (rubyFiles.length > 0) return true;

      const manifests = await glob(['Gemfile', 'Gemfile.lock', 'Rakefile', '*.gemspec'], {
        cwd: projectPath,
        nodir: true
      });
      return manifests.length > 0;
    } catch {
      return false;
    }
  }

  supportsIncrementalAnalysis(): boolean {
    return true;
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    const files = await glob(['**/*.rb', '**/*.rake', 'Rakefile'], {
      cwd: projectPath,
      ignore: this.getRubyIgnorePatterns({ projectPath }),
      nodir: true
    });
    return files.sort();
  }

  protected getCapabilities(): string[] {
    return [
      'class-analysis',
      'module-analysis',
      'method-extraction',
      'constant-extraction',
      'attribute-extraction',
      'mixin-detection',
      'require-tracking',
      'inheritance-mapping',
      'gem-dependency-detection'
    ];
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

  private getRubyIgnorePatterns(context: AnalysisContext): string[] {
    return [
      ...this.getIgnorePatterns(context),
      '**/tmp/**',
      '**/log/**',
      '**/.bundle/**',
      '**/db/schema.rb'
    ];
  }

  async analyzeFileSingle(context: FileAnalysisContext): Promise<FileAnalysisResult> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const content = await fs.readFile(context.filePath, 'utf-8');
    const stat = await fs.stat(context.filePath);
    const analysis = this.parseRubySource(content, context.relativePath);

    this.emitFileNodes(analysis, context.relativePath, context.filePath, nodes, edges);
    this.buildInheritanceEdges([analysis], nodes, edges);

    const imports = analysis.requires.map(item => item.target);
    const exports = [
      ...analysis.classes.map(item => item.name),
      ...analysis.modules.map(item => item.name),
      ...analysis.topLevelMethods.map(item => item.name),
      ...analysis.topLevelConstants.map(item => item.name)
    ];

    return this.createFileAnalysisResult(
      context.filePath,
      context.relativePath,
      context.contentHash || this.computeContentHash(content),
      stat.mtimeMs,
      nodes,
      edges,
      [],
      [],
      imports,
      exports
    );
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];

    try {
      const rubyFiles = (await glob(['**/*.rb', '**/*.rake', 'Rakefile'], {
        cwd: context.projectPath,
        ignore: this.getRubyIgnorePatterns(context),
        nodir: true
      })).sort();

      const fileAnalyses: RubyFileAnalysis[] = [];
      for (const file of rubyFiles) {
        const fullPath = path.join(context.projectPath, file);
        let content: string;
        try {
          content = await fs.readFile(fullPath, 'utf-8');
        } catch {
          continue;
        }
        const analysis = this.parseRubySource(content, file);
        fileAnalyses.push(analysis);
        this.emitFileNodes(analysis, file, fullPath, nodes, edges);
      }

      this.buildInheritanceEdges(fileAnalyses, nodes, edges);

      const gems = await this.extractGems(context.projectPath);

      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        framework_specific: {
          language: 'ruby',
          files_analyzed: rubyFiles.length,
          rails: gems.includes('rails'),
          sinatra: gems.includes('sinatra'),
          rspec: gems.includes('rspec') || gems.includes('rspec-rails'),
          sidekiq: gems.includes('sidekiq'),
          gems_detected: gems.length
        }
      });
    } catch (error) {
      throw new AnalyzerError(
        `Ruby analysis failed: ${(error as Error).message}`,
        'RUBY_ANALYSIS_ERROR'
      );
    }
  }

  parseRubySource(content: string, filePath: string): RubyFileAnalysis {
    const analysis: RubyFileAnalysis = {
      classes: [],
      modules: [],
      topLevelMethods: [],
      topLevelConstants: [],
      requires: []
    };

    const lines = content.split('\n');
    const stack: ScopeFrame[] = [];
    let insideBlockComment = false;

    const currentVisibility = (): 'public' | 'private' | 'protected' => {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].kind === 'class' || stack[i].kind === 'module') return stack[i].visibility;
      }
      return 'public';
    };

    const enclosingClass = (): RubyClass | undefined => {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].kind === 'def') return undefined;
        if (stack[i].classRef) return stack[i].classRef;
        if (stack[i].moduleRef) return undefined;
      }
      return undefined;
    };

    const enclosingModule = (): RubyModule | undefined => {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].kind === 'def') return undefined;
        if (stack[i].classRef) return undefined;
        if (stack[i].moduleRef) return stack[i].moduleRef;
      }
      return undefined;
    };

    const insideMethod = (): boolean => stack.some(frame => frame.kind === 'def');

    const qualifiedPrefix = (): string => {
      const parts: string[] = [];
      for (const frame of stack) {
        if (frame.classRef) parts.push(frame.classRef.name);
        if (frame.moduleRef) parts.push(frame.moduleRef.name);
      }
      return parts.join('::');
    };

    for (let index = 0; index < lines.length; index++) {
      const lineNumber = index + 1;
      const raw = lines[index];
      const trimmed = raw.trim();

      if (insideBlockComment) {
        if (trimmed.startsWith('=end')) insideBlockComment = false;
        continue;
      }
      if (trimmed.startsWith('=begin')) {
        insideBlockComment = true;
        continue;
      }
      if (trimmed === '' || trimmed.startsWith('#')) continue;

      const requireMatch = trimmed.match(REQUIRE_PATTERN);
      if (requireMatch) {
        analysis.requires.push({
          target: requireMatch[2],
          relative: Boolean(requireMatch[1]),
          lineNumber
        });
        continue;
      }

      const endMatch = trimmed.match(END_PATTERN);
      if (endMatch) {
        const frame = stack.pop();
        if (frame) {
          if (frame.classRef) frame.classRef.lineEnd = lineNumber;
          if (frame.moduleRef) frame.moduleRef.lineEnd = lineNumber;
          if (frame.methodRef) frame.methodRef.lineEnd = lineNumber;
        }
        continue;
      }

      if (SINGLETON_CLASS_PATTERN.test(trimmed)) {
        stack.push({ kind: 'singleton', visibility: 'public', lineStart: lineNumber });
        continue;
      }

      const classMatch = trimmed.match(CLASS_PATTERN);
      if (classMatch && !insideMethod()) {
        const prefix = qualifiedPrefix();
        const rubyClass: RubyClass = {
          name: classMatch[1].split('::').pop()!,
          qualifiedName: prefix ? `${prefix}::${classMatch[1]}` : classMatch[1],
          superclass: classMatch[2],
          filePath,
          lineStart: lineNumber,
          lineEnd: lines.length,
          methods: [],
          constants: [],
          attributes: [],
          includedModules: [],
          extendedModules: []
        };
        analysis.classes.push(rubyClass);
        stack.push({ kind: 'class', classRef: rubyClass, visibility: 'public', lineStart: lineNumber });
        continue;
      }

      const moduleMatch = trimmed.match(MODULE_PATTERN);
      if (moduleMatch && !insideMethod()) {
        const prefix = qualifiedPrefix();
        const rubyModule: RubyModule = {
          name: moduleMatch[1].split('::').pop()!,
          qualifiedName: prefix ? `${prefix}::${moduleMatch[1]}` : moduleMatch[1],
          filePath,
          lineStart: lineNumber,
          lineEnd: lines.length,
          methods: [],
          constants: []
        };
        analysis.modules.push(rubyModule);
        stack.push({ kind: 'module', moduleRef: rubyModule, visibility: 'public', lineStart: lineNumber });
        continue;
      }

      const visibilityMatch = trimmed.match(VISIBILITY_PATTERN);
      if (visibilityMatch) {
        for (let i = stack.length - 1; i >= 0; i--) {
          if (stack[i].kind === 'class' || stack[i].kind === 'module') {
            stack[i].visibility = visibilityMatch[1] as 'public' | 'private' | 'protected';
            break;
          }
        }
        continue;
      }

      const inlineVisibility = trimmed.match(/^(private|protected)\s+def\s/);
      const defSource = inlineVisibility ? trimmed.replace(/^(private|protected)\s+/, '') : trimmed;
      const defMatch = defSource.match(DEF_PATTERN);
      if (defMatch && !insideMethod()) {
        const isEndless = ENDLESS_DEF_PATTERN.test(defSource);
        const inSingleton = stack.some(frame => frame.kind === 'singleton');
        const method: RubyMethod = {
          name: defMatch[2],
          visibility: inlineVisibility ? inlineVisibility[1] as 'private' | 'protected' : currentVisibility(),
          isSingleton: Boolean(defMatch[1]) || inSingleton,
          parameters: defMatch[3]
            ? defMatch[3].split(',').map(parameter => parameter.trim().split(/[:=\s]/)[0].replace(/^[*&]+/, '')).filter(Boolean)
            : [],
          lineStart: lineNumber,
          lineEnd: lineNumber
        };

        const ownerClass = enclosingClass();
        const ownerModule = enclosingModule();
        if (ownerClass) ownerClass.methods.push(method);
        else if (ownerModule) ownerModule.methods.push(method);
        else analysis.topLevelMethods.push(method);

        if (!isEndless) {
          stack.push({ kind: 'def', methodRef: method, visibility: 'public', lineStart: lineNumber });
        }
        continue;
      }

      const attrMatch = trimmed.match(ATTR_PATTERN);
      if (attrMatch && !insideMethod()) {
        const ownerClass = enclosingClass();
        if (ownerClass) {
          const kind = attrMatch[1] as 'accessor' | 'reader' | 'writer';
          const names = attrMatch[2].match(/:(\w+)/g) || [];
          for (const symbol of names) {
            ownerClass.attributes.push({ name: symbol.slice(1), kind, lineNumber });
          }
        }
        continue;
      }

      const mixinMatch = trimmed.match(MIXIN_PATTERN);
      if (mixinMatch && !insideMethod()) {
        const ownerClass = enclosingClass();
        if (ownerClass) {
          const targets = mixinMatch[2].split(',').map(item => item.trim()).filter(Boolean);
          if (mixinMatch[1] === 'extend') ownerClass.extendedModules.push(...targets);
          else ownerClass.includedModules.push(...targets);
        }
        continue;
      }

      const constantMatch = trimmed.match(CONSTANT_PATTERN);
      if (constantMatch && !insideMethod()) {
        const constant: RubyConstant = {
          name: constantMatch[1],
          value: constantMatch[2].trim(),
          lineNumber
        };
        const ownerClass = enclosingClass();
        const ownerModule = enclosingModule();
        if (ownerClass) ownerClass.constants.push(constant);
        else if (ownerModule) ownerModule.constants.push(constant);
        else analysis.topLevelConstants.push(constant);
        continue;
      }

      if (BLOCK_KEYWORD_PATTERN.test(trimmed) || TRAILING_DO_PATTERN.test(trimmed.replace(/#.*$/, '').trimEnd())) {
        stack.push({ kind: 'block', visibility: 'public', lineStart: lineNumber });
      }
    }

    return analysis;
  }

  private emitFileNodes(
    analysis: RubyFileAnalysis,
    relativePath: string,
    fullPath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): void {
    for (const rubyModule of analysis.modules) {
      const moduleId = this.generateId('module', relativePath, rubyModule.qualifiedName);
      nodes.push(this.createNodeBuilder(moduleId, rubyModule.name, 'module')
        .withLevel(3, 'code')
        .withCategory('module', ['ruby'])
        .withSource({ file: fullPath, line: rubyModule.lineStart, end_line: rubyModule.lineEnd })
        .withDescription(`Ruby module: ${rubyModule.qualifiedName}`)
        .withMetadata({
          framework: 'ruby',
          attributes: {
            qualified_name: rubyModule.qualifiedName,
            methods_count: rubyModule.methods.length,
            constants_count: rubyModule.constants.length
          }
        })
        .withTags(['analyzer:ruby'])
        .build());

      this.emitMethods(rubyModule.methods, moduleId, rubyModule.qualifiedName, relativePath, fullPath, nodes, edges);
      this.emitConstants(rubyModule.constants, moduleId, rubyModule.qualifiedName, relativePath, fullPath, nodes, edges);
    }

    for (const rubyClass of analysis.classes) {
      const classId = this.generateId('class', relativePath, rubyClass.qualifiedName);
      nodes.push(this.createNodeBuilder(classId, rubyClass.name, 'class')
        .withLevel(3, 'code')
        .withCategory('class', ['ruby'])
        .withSource({ file: fullPath, line: rubyClass.lineStart, end_line: rubyClass.lineEnd })
        .withDescription(`Ruby class: ${rubyClass.qualifiedName}`)
        .withMetadata({
          framework: 'ruby',
          attributes: {
            qualified_name: rubyClass.qualifiedName,
            superclass: rubyClass.superclass,
            methods_count: rubyClass.methods.length,
            constants_count: rubyClass.constants.length,
            attributes_count: rubyClass.attributes.length,
            included_modules: rubyClass.includedModules,
            extended_modules: rubyClass.extendedModules
          }
        })
        .withTags(['analyzer:ruby'])
        .build());

      this.emitMethods(rubyClass.methods, classId, rubyClass.qualifiedName, relativePath, fullPath, nodes, edges);
      this.emitConstants(rubyClass.constants, classId, rubyClass.qualifiedName, relativePath, fullPath, nodes, edges);

      for (const attribute of rubyClass.attributes) {
        const attributeId = this.generateId('property', relativePath, `${rubyClass.qualifiedName}#${attribute.name}`);
        nodes.push(this.createNodeBuilder(attributeId, attribute.name, 'property')
          .withLevel(4, 'member')
          .withCategory('property', ['ruby'])
          .withSource({ file: fullPath, line: attribute.lineNumber, end_line: attribute.lineNumber })
          .withDescription(`Ruby attribute (${attribute.kind}) on ${rubyClass.qualifiedName}: ${attribute.name}`)
          .withParent(classId)
          .withMetadata({ framework: 'ruby', attributes: { kind: attribute.kind } })
          .withTags(['analyzer:ruby'])
          .build());
        edges.push(this.createEdge(
          this.generateEdgeId(classId, attributeId, 'contains'),
          classId,
          attributeId,
          'contains',
          'structural'
        ));
      }
    }

    for (const method of analysis.topLevelMethods) {
      const functionId = this.generateId('function', relativePath, method.name);
      nodes.push(this.createNodeBuilder(functionId, method.name, 'function')
        .withLevel(3, 'code')
        .withCategory('function', ['ruby'])
        .withSource({ file: fullPath, line: method.lineStart, end_line: method.lineEnd })
        .withDescription(`Ruby top-level method: ${method.name}`)
        .withSignature({ parameters: method.parameters.map(name => ({ name, type: 'Object' })) })
        .withMetadata({ framework: 'ruby' })
        .withTags(['analyzer:ruby'])
        .build());
    }

    for (const constant of analysis.topLevelConstants) {
      const constantId = this.generateId('constant', relativePath, constant.name);
      nodes.push(this.createNodeBuilder(constantId, constant.name, 'constant')
        .withLevel(3, 'code')
        .withCategory('constant', ['ruby'])
        .withSource({ file: fullPath, line: constant.lineNumber, end_line: constant.lineNumber })
        .withDescription(`Ruby constant: ${constant.name}`)
        .withMetadata({ framework: 'ruby', attributes: { value: constant.value } })
        .withTags(['analyzer:ruby'])
        .build());
    }
  }

  private emitMethods(
    methods: RubyMethod[],
    ownerId: string,
    ownerQualifiedName: string,
    relativePath: string,
    fullPath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): void {
    for (const method of methods) {
      const separator = method.isSingleton ? '.' : '#';
      const methodId = this.generateId('method', relativePath, `${ownerQualifiedName}${separator}${method.name}`);
      nodes.push(this.createNodeBuilder(methodId, method.name, 'method')
        .withLevel(4, 'member')
        .withCategory('method', ['ruby'])
        .withSource({ file: fullPath, line: method.lineStart, end_line: method.lineEnd })
        .withDescription(`Ruby method ${ownerQualifiedName}${separator}${method.name}`)
        .withParent(ownerId)
        .withSignature({ parameters: method.parameters.map(name => ({ name, type: 'Object' })) })
        .withMetadata({
          framework: 'ruby',
          attributes: {
            visibility: method.visibility,
            singleton: method.isSingleton
          }
        })
        .withTags(['analyzer:ruby'])
        .build());
      edges.push(this.createEdge(
        this.generateEdgeId(ownerId, methodId, 'contains'),
        ownerId,
        methodId,
        'contains',
        'structural'
      ));
    }
  }

  private emitConstants(
    constants: RubyConstant[],
    ownerId: string,
    ownerQualifiedName: string,
    relativePath: string,
    fullPath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): void {
    for (const constant of constants) {
      const constantId = this.generateId('constant', relativePath, `${ownerQualifiedName}::${constant.name}`);
      nodes.push(this.createNodeBuilder(constantId, constant.name, 'constant')
        .withLevel(4, 'member')
        .withCategory('constant', ['ruby'])
        .withSource({ file: fullPath, line: constant.lineNumber, end_line: constant.lineNumber })
        .withDescription(`Ruby constant ${ownerQualifiedName}::${constant.name}`)
        .withParent(ownerId)
        .withMetadata({ framework: 'ruby', attributes: { value: constant.value } })
        .withTags(['analyzer:ruby'])
        .build());
      edges.push(this.createEdge(
        this.generateEdgeId(ownerId, constantId, 'contains'),
        ownerId,
        constantId,
        'contains',
        'structural'
      ));
    }
  }

  private buildInheritanceEdges(
    fileAnalyses: RubyFileAnalysis[],
    nodes: CASNode[],
    edges: CASEdge[]
  ): void {
    const classNodesByName = new Map<string, CASNode>();
    const moduleNodesByName = new Map<string, CASNode>();
    for (const node of nodes) {
      if (node.type === 'class') classNodesByName.set(node.name, node);
      if (node.type === 'module') moduleNodesByName.set(node.name, node);
    }

    const existingEdgeIds = new Set(edges.map(edge => edge.id));
    const pushEdge = (edge: CASEdge) => {
      if (!existingEdgeIds.has(edge.id)) {
        existingEdgeIds.add(edge.id);
        edges.push(edge);
      }
    };

    for (const analysis of fileAnalyses) {
      for (const rubyClass of analysis.classes) {
        const classNode = classNodesByName.get(rubyClass.name);
        if (!classNode) continue;

        if (rubyClass.superclass) {
          const superclassNode = classNodesByName.get(rubyClass.superclass.split('::').pop()!);
          if (superclassNode && superclassNode.id !== classNode.id) {
            pushEdge(this.createEdge(
              this.generateEdgeId(classNode.id, superclassNode.id, 'extends'),
              classNode.id,
              superclassNode.id,
              'extends',
              'structural',
              { superclass: rubyClass.superclass }
            ));
          }
        }

        for (const mixin of [...rubyClass.includedModules, ...rubyClass.extendedModules]) {
          const moduleNode = moduleNodesByName.get(mixin.split('::').pop()!);
          if (moduleNode) {
            pushEdge(this.createEdge(
              this.generateEdgeId(classNode.id, moduleNode.id, 'includes'),
              classNode.id,
              moduleNode.id,
              'includes',
              'structural',
              { mixin }
            ));
          }
        }
      }
    }
  }

  async extractGems(projectPath: string): Promise<string[]> {
    const gems = new Set<string>();
    const gemfilePath = path.join(projectPath, 'Gemfile');
    try {
      if (await fs.pathExists(gemfilePath)) {
        const content = await fs.readFile(gemfilePath, 'utf-8');
        for (const line of content.split('\n')) {
          const match = line.match(GEM_PATTERN);
          if (match) gems.add(match[1]);
        }
      }
    } catch {
    }
    return [...gems];
  }
}
