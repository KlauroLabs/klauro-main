import { BaseAnalyzer, AnalysisContext, FileAnalysisContext } from '../core/base-analyzer';
import {
  CASNode,
  CASEdge,
  CASContribution,
  CASEntryPoint,
  CASExitPoint,
  FileAnalysisResult,
} from '../../types/cas.types';
import { AnalyzerError } from '../core/errors';
import * as fs from 'fs-extra';
import * as path from 'path';
import { glob } from 'glob';
import { detectSyntaxDegradation } from '../core/syntax-degradation';

interface DartClass {
  name: string;
  extendsName?: string;
  implementsNames: string[];
  file: string;
  line: number;
  endLine: number;
  body: string;
}

interface DartFunction {
  name: string;
  returnType?: string;
  file: string;
  line: number;
  ownerClass?: string;
}

export class DartAnalyzer extends BaseAnalyzer {
  constructor() {
    super('dart', 'Dart/Flutter Analyzer', '1.0.0', 'language');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    if (await fs.pathExists(path.join(projectPath, 'pubspec.yaml'))) return true;
    const dartFiles = await glob(['**/*.dart'], {
      cwd: projectPath,
      ignore: this.ignorePatterns(),
      nodir: true,
    });
    return dartFiles.length > 0;
  }

  supportsIncrementalAnalysis(): boolean {
    return true;
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    const files = await glob(['**/*.dart'], {
      cwd: projectPath,
      ignore: this.ignorePatterns(),
      nodir: true,
    });
    return files.sort();
  }

  async analyzeFileSingle(context: FileAnalysisContext): Promise<FileAnalysisResult> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];
    const content = await fs.readFile(context.filePath, 'utf8');
    const stat = await fs.stat(context.filePath);
    const pubspec = await this.readPubspec(context.projectPath);
    const isFlutterProject = Boolean(pubspec.match(/\bflutter\s*:/) || pubspec.includes('sdk: flutter'));

    this.analyzeDartFile({
      projectPath: context.projectPath,
      relativeFile: context.relativePath,
      fullPath: context.filePath,
      content,
      isFlutterProject,
      nodes,
      edges,
      entryPoints,
      exitPoints,
    });

    const imports = this.extractImports(content);
    const classes = this.extractClasses(content, context.relativePath);
    const functions = this.extractFunctions(content, context.relativePath, classes);

    return this.createFileAnalysisResult(
      context.filePath,
      context.relativePath,
      context.contentHash || this.computeContentHash(content),
      stat.mtimeMs,
      nodes,
      edges,
      entryPoints,
      exitPoints,
      imports,
      [...classes.map(cls => cls.name), ...functions.map(fn => fn.name)]
    );
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    this.resetAnalysisWarnings();
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];

    try {
      const files = await glob(['**/*.dart'], {
        cwd: context.projectPath,
        ignore: this.ignorePatterns(),
        nodir: true,
      });
      files.sort();
      const pubspec = await this.readPubspec(context.projectPath);
      const isFlutterProject = Boolean(pubspec.match(/\bflutter\s*:/) || pubspec.includes('sdk: flutter'));

      for (const relativeFile of files.sort()) {
        const fullPath = path.join(context.projectPath, relativeFile);
        const content = await fs.readFile(fullPath, 'utf8');
        this.analyzeDartFile({
          projectPath: context.projectPath,
          relativeFile,
          fullPath,
          content,
          isFlutterProject,
          nodes,
          edges,
          entryPoints,
          exitPoints,
        });
      }

      const warnings = this.collectAnalysisWarnings();
      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        ...(warnings.length > 0 ? { warnings } : {}),
        framework_specific: {
          language: 'dart',
          framework: isFlutterProject ? 'flutter' : 'dart',
          files_analyzed: files.length,
        },
      });
    } catch (error) {
      throw new AnalyzerError(
        `Dart/Flutter analysis failed: ${(error as Error).message}`,
        'DART_ANALYSIS_ERROR'
      );
    }
  }

  protected getCapabilities(): string[] {
    return [
      'dart-file-discovery',
      'flutter-widget-discovery',
      'flutter-route-discovery',
      'mobile-lifecycle-entry-points',
      'dart-test-discovery',
      'mobile-exit-boundaries',
    ];
  }

  protected getLevelName(level: number): string {
    const names: Record<number, string> = {
      1: 'File',
      2: 'Widget/Class',
      3: 'Screen/Route',
      4: 'Function/Method',
    };
    return names[level] || 'Code Element';
  }

  private analyzeDartFile(input: {
    projectPath: string;
    relativeFile: string;
    fullPath: string;
    content: string;
    isFlutterProject: boolean;
    nodes: CASNode[];
    edges: CASEdge[];
    entryPoints: CASEntryPoint[];
    exitPoints: CASExitPoint[];
  }): void {
    const { relativeFile, fullPath, content, isFlutterProject, nodes, edges, entryPoints, exitPoints } = input;
    const lines = content.split(/\r?\n/);
    const fileId = `file_${this.sanitizeId(relativeFile)}`;
    const isTest = this.isDartTestFile(relativeFile);

    nodes.push(this.createNodeBuilder(fileId, path.basename(relativeFile), 'file')
      .withLevel(1, this.getLevelName(1))
      .withSource({ file: fullPath, line: 1, end_line: lines.length })
      .withMetadata({
        language: 'dart',
        framework: isFlutterProject ? 'flutter' : 'dart',
        is_test: isTest,
        attributes: {
          relative_path: relativeFile,
          imports: this.extractImports(content),
          is_flutter_project: isFlutterProject,
        },
      })
      .withAnalyzers([this.analyzerId], this.analyzerId)
      .build());

    for (const imported of this.extractImports(content)) {
      const importId = `import_${fileId}_${this.sanitizeId(imported)}`;
      nodes.push(this.createNode(importId, imported, 'import', 2, fullPath, 1, 1, {
        language: 'dart',
        imported,
      }));
      edges.push(this.createEdge(`${fileId}_imports_${importId}`, fileId, importId, 'imports'));
    }

    const classes = this.extractClasses(content, relativeFile);
    const classIds = new Map<string, string>();
    for (const dartClass of classes) {
      const classId = `class_${this.sanitizeId(relativeFile)}_${this.sanitizeId(dartClass.name)}`;
      classIds.set(dartClass.name, classId);
      const nodeType = this.classNodeType(dartClass, relativeFile);
      nodes.push(this.createNodeBuilder(classId, dartClass.name, nodeType)
        .withLevel(nodeType === 'mobile_screen' ? 3 : 2, this.getLevelName(nodeType === 'mobile_screen' ? 3 : 2))
        .withCategory(nodeType === 'mobile_screen' || nodeType === 'widget' ? 'presentation' : 'structures', [nodeType])
        .withSource({ file: fullPath, line: dartClass.line, end_line: dartClass.endLine })
        .withMetadata({
          language: 'dart',
          framework: isFlutterProject ? 'flutter' : 'dart',
          attributes: {
            extends: dartClass.extendsName,
            implements: dartClass.implementsNames,
            is_widget: this.isWidgetClass(dartClass),
            is_screen: nodeType === 'mobile_screen',
          },
        })
        .withAnalyzers([this.analyzerId], this.analyzerId)
        .build());
      edges.push(this.createEdge(`${fileId}_contains_${classId}`, fileId, classId, 'contains'));

      if (nodeType === 'mobile_screen' || nodeType === 'widget') {
        entryPoints.push(this.createEntryPoint(
          `entry_flutter_page_${this.sanitizeId(relativeFile)}_${this.sanitizeId(dartClass.name)}`,
          classId,
          'page',
          `Flutter page: ${dartClass.name}`,
          `${dartClass.name} is a Flutter renderable surface.`,
          { path: this.routePathForClass(dartClass, relativeFile) },
          undefined,
          {
            framework: 'flutter',
            class_name: dartClass.name,
            file: relativeFile,
          },
          {
            node_id: classId,
            method_name: 'build',
            file: fullPath,
            line: dartClass.line,
          }
        ));
      }
    }

    const functions = this.extractFunctions(content, relativeFile, classes);
    const degradation = detectSyntaxDegradation({
      relativePath: relativeFile,
      content,
      language: 'dart',
      extractedNodeCount: classes.length + functions.length,
    });
    if (degradation) this.addAnalysisWarning(degradation);
    for (const fn of functions) {
      const ownerId = fn.ownerClass ? classIds.get(fn.ownerClass) : fileId;
      const functionId = `function_${this.sanitizeId(relativeFile)}_${this.sanitizeId(fn.ownerClass || 'top')}_${this.sanitizeId(fn.name)}_${fn.line}`;
      const functionType = fn.ownerClass ? 'method' : 'function';
      nodes.push(this.createNodeBuilder(functionId, fn.name, functionType)
        .withLevel(4, this.getLevelName(4))
        .withSource({ file: fullPath, line: fn.line })
        .withParent(ownerId)
        .withMetadata({
          language: 'dart',
          framework: isFlutterProject ? 'flutter' : 'dart',
          is_test: isTest || fn.name.startsWith('test') || fn.name.startsWith('testWidgets'),
          attributes: {
            return_type: fn.returnType,
            owner_class: fn.ownerClass,
            lifecycle_method: this.isFlutterLifecycleMethod(fn.name),
          },
        })
        .withAnalyzers([this.analyzerId], this.analyzerId)
        .build());
      if (ownerId) edges.push(this.createEdge(`${ownerId}_has_${functionId}`, ownerId, functionId, fn.ownerClass ? 'has_method' : 'contains'));

      if (!fn.ownerClass && fn.name === 'main') {
        entryPoints.push(this.createEntryPoint(
          `entry_dart_main_${this.sanitizeId(relativeFile)}`,
          functionId,
          isFlutterProject ? 'lifecycle' : 'cli',
          isFlutterProject ? 'Flutter application start' : 'Dart main entry point',
          'Dart main() starts execution for this package.',
          { event: isFlutterProject ? 'app-start' : 'process-start' },
          undefined,
          {
            language: 'dart',
            framework: isFlutterProject ? 'flutter' : 'dart',
            file: relativeFile,
          },
          {
            node_id: functionId,
            method_name: 'main',
            file: fullPath,
            line: fn.line,
          }
        ));
      }

      if (fn.ownerClass && this.isFlutterLifecycleMethod(fn.name)) {
        entryPoints.push(this.createEntryPoint(
          `entry_flutter_lifecycle_${this.sanitizeId(relativeFile)}_${this.sanitizeId(fn.ownerClass)}_${this.sanitizeId(fn.name)}_${fn.line}`,
          functionId,
          'lifecycle',
          `${fn.ownerClass}.${fn.name}`,
          `Flutter lifecycle callback ${fn.name}.`,
          { event: fn.name },
          undefined,
          {
            framework: 'flutter',
            class_name: fn.ownerClass,
            method: fn.name,
          },
          {
            node_id: functionId,
            method_name: fn.name,
            file: fullPath,
            line: fn.line,
          }
        ));
      }
    }

    for (const route of this.extractRouteLiterals(content)) {
      const routeId = `route_${this.sanitizeId(relativeFile)}_${this.sanitizeId(route.path)}_${route.line}`;
      nodes.push(this.createNode(routeId, route.path, 'route', 3, fullPath, route.line, route.line, {
        language: 'dart',
        framework: 'flutter',
        route_kind: route.kind,
      }));
      edges.push(this.createEdge(`${fileId}_declares_${routeId}`, fileId, routeId, 'declares_route'));
      entryPoints.push(this.createEntryPoint(
        `entry_flutter_route_${this.sanitizeId(relativeFile)}_${this.sanitizeId(route.path)}_${route.line}`,
        routeId,
        'route',
        `Flutter route ${route.path}`,
        'Navigation route declared in Flutter code.',
        { path: route.path },
        undefined,
        {
          framework: 'flutter',
          route_kind: route.kind,
          file: relativeFile,
        },
        {
          node_id: routeId,
          method_name: route.kind,
          file: fullPath,
          line: route.line,
        }
      ));
    }

    this.detectExitPoints(content, relativeFile, fullPath, nodes, exitPoints);
  }

  private extractImports(content: string): string[] {
    return [...content.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)].map(match => match[1]);
  }

  private extractClasses(content: string, file: string): DartClass[] {
    const classes: DartClass[] = [];
    const pattern = /class\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+extends\s+([A-Za-z_][A-Za-z0-9_<>]*))?(?:\s+with\s+[A-Za-z0-9_<>,\s]+)?(?:\s+implements\s+([A-Za-z0-9_<>,\s]+))?\s*\{/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const bodyStart = content.indexOf('{', match.index);
      const bodyEnd = this.findMatchingBrace(content, bodyStart);
      const body = bodyEnd > bodyStart ? content.slice(bodyStart + 1, bodyEnd) : '';
      classes.push({
        name: match[1],
        extendsName: match[2],
        implementsNames: match[3]?.split(',').map(value => value.trim()).filter(Boolean) || [],
        file,
        line: this.lineAt(content, match.index),
        endLine: bodyEnd > bodyStart ? this.lineAt(content, bodyEnd) : this.lineAt(content, match.index),
        body,
      });
    }
    return classes;
  }

  private extractFunctions(content: string, file: string, classes: DartClass[]): DartFunction[] {
    const functions: DartFunction[] = [];
    const classRanges = classes.map(cls => {
      const classStart = content.indexOf(`class ${cls.name}`);
      const bodyStart = content.indexOf('{', classStart);
      const bodyEnd = this.findMatchingBrace(content, bodyStart);
      return { cls, classStart, bodyStart, bodyEnd };
    });

    const pattern = /^\s*(?:@override\s*)?(?:(Future<[^>]+>|Future<void>|void|Widget|[A-Za-z_][A-Za-z0-9_<>,?]*)\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\([^;{}]*\)\s*(?:async\s*)?(?:\{|=>)/gm;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const name = match[2];
      if (['if', 'for', 'while', 'switch', 'catch'].includes(name)) continue;
      const owner = classRanges.find(range => match!.index > range.bodyStart && match!.index < range.bodyEnd);
      functions.push({
        name,
        returnType: match[1],
        file,
        line: this.lineAt(content, match.index),
        ownerClass: owner?.cls.name,
      });
    }
    return functions;
  }

  private extractRouteLiterals(content: string): Array<{ path: string; line: number; kind: string }> {
    const routes: Array<{ path: string; line: number; kind: string }> = [];
    const patterns = [
      { kind: 'MaterialApp.routes', regex: /['"]([^'"]+)['"]\s*:\s*\([^)]*\)\s*=>/g },
      { kind: 'GoRoute', regex: /GoRoute\s*\([^)]*path\s*:\s*['"]([^'"]+)['"]/g },
      { kind: 'Navigator.named', regex: /Navigator\.(?:pushNamed|pushReplacementNamed)\s*\([^,]+,\s*['"]([^'"]+)['"]/g },
    ];
    for (const pattern of patterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.regex.exec(content)) !== null) {
        if (!match[1].startsWith('/')) continue;
        routes.push({ path: match[1], line: this.lineAt(content, match.index), kind: pattern.kind });
      }
    }
    return routes;
  }

  private detectExitPoints(content: string, relativeFile: string, fullPath: string, nodes: CASNode[], exitPoints: CASExitPoint[]): void {
    const checks = [
      { regex: /\b(?:http|client)\.(?:get|post|put|delete|patch)\s*\(/g, type: 'api' as const, name: 'Dart HTTP client call' },
      { regex: /\bDio\s*\(/g, type: 'api' as const, name: 'Dio HTTP client' },
      { regex: /\bFirebase[A-Za-z0-9_]*\b/g, type: 'sdk' as const, name: 'Firebase SDK usage' },
      { regex: /\bSharedPreferences\b/g, type: 'client_storage' as const, name: 'SharedPreferences client storage' },
      { regex: /\bMethodChannel\s*\(/g, type: 'sdk' as const, name: 'Native MethodChannel bridge' },
      { regex: /\bNavigator\.(?:push|pushNamed|pop|replace)/g, type: 'navigation' as const, name: 'Flutter navigation' },
    ];

    for (const check of checks) {
      let match: RegExpExecArray | null;
      while ((match = check.regex.exec(content)) !== null) {
        const line = this.lineAt(content, match.index);
        const nodeId = `boundary_${this.sanitizeId(relativeFile)}_${this.sanitizeId(check.name)}_${line}`;
        nodes.push(this.createNode(nodeId, check.name, 'boundary', 4, fullPath, line, line, {
          language: 'dart',
          framework: 'flutter',
          boundary_type: check.type,
        }));
        exitPoints.push(this.createExitPoint(
          `exit_${nodeId}`,
          nodeId,
          check.type,
          check.name,
          `Flutter/Dart boundary detected in ${relativeFile}.`,
          {
            service_id: check.type === 'navigation' ? 'flutter-navigation' : undefined,
            sdk: check.type === 'sdk' ? check.name : undefined,
          },
          {
            action: check.name,
            async: check.type === 'api',
          },
          {
            language: 'dart',
            framework: 'flutter',
            file: relativeFile,
          }
        ));
      }
    }
  }

  private classNodeType(cls: DartClass, file: string): string {
    const lowerName = cls.name.toLowerCase();
    const lowerFile = file.toLowerCase();
    if (this.isWidgetClass(cls) && (lowerName.endsWith('screen') || lowerName.endsWith('page') || lowerFile.includes('/screens/') || lowerFile.includes('/pages/'))) {
      return 'mobile_screen';
    }
    if (this.isWidgetClass(cls)) return 'widget';
    if (lowerName.includes('service') || lowerName.includes('manager') || lowerFile.includes('/services/')) return 'service';
    if (lowerName.includes('model') || lowerFile.includes('/models/')) return 'model';
    return 'class';
  }

  private isWidgetClass(cls: DartClass): boolean {
    const inherited = [cls.extendsName, ...cls.implementsNames].join(' ');
    return /\b(?:StatelessWidget|StatefulWidget|Widget|ConsumerWidget|HookWidget|State<)/.test(inherited) ||
      cls.body.includes('Widget build(');
  }

  private isFlutterLifecycleMethod(name: string): boolean {
    return ['build', 'initState', 'dispose', 'didChangeDependencies', 'didUpdateWidget', 'reassemble'].includes(name);
  }

  private routePathForClass(cls: DartClass, file: string): string {
    const base = cls.name
      .replace(/(?:Screen|Page|View|Widget)$/i, '')
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .toLowerCase();
    if (base === 'home' || file.endsWith('main.dart')) return '/';
    return `/${base || cls.name.toLowerCase()}`;
  }

  private isDartTestFile(file: string): boolean {
    const normalized = file.replace(/\\/g, '/').toLowerCase();
    return normalized.endsWith('_test.dart') || normalized.includes('/test/');
  }

  private async readPubspec(projectPath: string): Promise<string> {
    const file = path.join(projectPath, 'pubspec.yaml');
    return (await fs.pathExists(file)) ? fs.readFile(file, 'utf8') : '';
  }

  private findMatchingBrace(content: string, start: number): number {
    if (start < 0) return -1;
    let depth = 0;
    for (let i = start; i < content.length; i += 1) {
      const char = content[i];
      if (char === '{') depth += 1;
      if (char === '}') {
        depth -= 1;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  private lineAt(content: string, index: number): number {
    return content.slice(0, index).split(/\r?\n/).length;
  }

  private ignorePatterns(): string[] {
    return [
      '**/.dart_tool/**',
      '**/build/**',
      '**/.git/**',
      '**/ios/Pods/**',
      '**/android/.gradle/**',
      '**/android/build/**',
      '**/macos/Pods/**',
      '**/windows/flutter/**',
      '**/linux/flutter/**',
      '**/.klauro-*/**',
    ];
  }
}
