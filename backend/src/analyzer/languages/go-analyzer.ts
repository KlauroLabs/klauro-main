import { BaseAnalyzer, AnalysisContext } from '../core/base-analyzer';
import { CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint } from '../../types/cas.types';
import { AnalyzerError } from '../core/errors';
import * as fs from 'fs-extra';
import { glob } from 'glob';

interface GoStruct {
  name: string;
  packageName: string;
  filePath: string;
  fields: GoField[];
  methods: GoMethod[];
  tags: string[];
  embedded: string[];
  lineStart: number;
  lineEnd: number;
  isExported: boolean;
}

interface GoInterface {
  name: string;
  packageName: string;
  filePath: string;
  methods: GoMethod[];
  embedded: string[];
  lineStart: number;
  lineEnd: number;
  isExported: boolean;
}

interface GoFunction {
  name: string;
  packageName: string;
  filePath: string;
  parameters: GoParameter[];
  returnTypes: string[];
  receiver?: GoReceiver;
  lineStart: number;
  lineEnd: number;
  isExported: boolean;
  isMain: boolean;
  isInit: boolean;
}

interface GoMethod {
  name: string;
  parameters: GoParameter[];
  returnTypes: string[];
  receiver?: GoReceiver;
  lineStart: number;
  lineEnd: number;
  isExported: boolean;
}

interface GoParameter {
  name: string;
  type: string;
  isVariadic: boolean;
}

interface GoReceiver {
  name: string;
  type: string;
  isPointer: boolean;
}

interface GoField {
  name: string;
  type: string;
  tag?: string;
  lineNumber: number;
  isExported: boolean;
  isEmbedded: boolean;
}

interface GoImport {
  path: string;
  alias?: string;
  lineNumber: number;
  isStandard: boolean;
  isDotImport: boolean;
  isBlankImport: boolean;
}

interface GoVariable {
  name: string;
  type?: string;
  value?: string;
  lineNumber: number;
  isExported: boolean;
  isConst: boolean;
  scope: 'package' | 'function' | 'block';
}

interface GoConstant {
  name: string;
  type?: string;
  value?: string;
  lineNumber: number;
  isExported: boolean;
  iota?: boolean;
}

interface GoType {
  name: string;
  packageName: string;
  filePath: string;
  underlying: string;
  methods: GoMethod[];
  lineNumber: number;
  isExported: boolean;
}

export class GoAnalyzer extends BaseAnalyzer {
  private ginFrameworkDetected = false;
  private echoFrameworkDetected = false;
  private gorillaFrameworkDetected = false;
  private fiberFrameworkDetected = false;
  private goModulesProject = false;
  private vendorProject = false;

  constructor() {
    super(
      'go-analyzer',
      'Go Language Analyzer',
      '1.0.0',
      'language'
    );
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const goFiles = await glob(['**/*.go'], {
        cwd: projectPath,
        ignore: ['**/vendor/**', '**/.git/**']
      });

      const projectFiles = await glob(['go.mod', 'go.sum', 'Gopkg.toml'], {
        cwd: projectPath
      });

      return goFiles.length > 0 || projectFiles.length > 0;
    } catch {
      return false;
    }
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];
    const libraries: any[] = [];

    try {
      await this.detectProjectType(context.projectPath);
      await this.extractDependencies(context.projectPath, libraries);

      const goFiles = await glob(['**/*.go'], {
        cwd: context.projectPath,
        ignore: ['**/vendor/**', '**/.git/**', '**/*_test.go']
      });

      const packages = new Map<string, string[]>();

      for (const file of goFiles) {
        const fullPath = `${context.projectPath}/${file}`;
        await this.analyzeGoFile(fullPath, file, nodes, edges, entryPoints, exitPoints, packages, context);
      }

      this.buildPackageHierarchy(packages, nodes, edges);
      this.detectFrameworkPatterns(nodes, edges, entryPoints);
      this.buildTypeRelationships(nodes, edges);

      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        framework_specific: {
          language: 'go',
          ginFramework: this.ginFrameworkDetected,
          echoFramework: this.echoFrameworkDetected,
          gorillaFramework: this.gorillaFrameworkDetected,
          fiberFramework: this.fiberFrameworkDetected,
          packageManager: this.goModulesProject ? 'go_modules' : this.vendorProject ? 'vendor' : 'go_get',
          libraries,
          filesAnalyzed: goFiles.length,
          packagesFound: packages.size
        }
      });

    } catch (error) {
      throw new AnalyzerError(
        `Go analysis failed: ${(error as Error).message}`,
        'GO_ANALYSIS_ERROR'
      );
    }
  }

  private async detectProjectType(projectPath: string): Promise<void> {
    const goModPath = `${projectPath}/go.mod`;
    const vendorPath = `${projectPath}/vendor`;

    this.goModulesProject = await fs.pathExists(goModPath);
    this.vendorProject = await fs.pathExists(vendorPath);

    if (this.goModulesProject) {
      try {
        const goModContent = await fs.readFile(goModPath, 'utf-8');
        this.detectFrameworks(goModContent);
      } catch (error) {
        console.warn('Failed to read go.mod:', error);
      }
    }
  }

  private detectFrameworks(content: string): void {
    this.ginFrameworkDetected = this.ginFrameworkDetected ||
      content.includes('github.com/gin-gonic/gin');

    this.echoFrameworkDetected = this.echoFrameworkDetected ||
      content.includes('github.com/labstack/echo');

    this.gorillaFrameworkDetected = this.gorillaFrameworkDetected ||
      content.includes('github.com/gorilla/mux');

    this.fiberFrameworkDetected = this.fiberFrameworkDetected ||
      content.includes('github.com/gofiber/fiber');
  }

  private async extractDependencies(projectPath: string, libraries: any[]): Promise<void> {
    const goModPath = `${projectPath}/go.mod`;
    const goSumPath = `${projectPath}/go.sum`;

    if (await fs.pathExists(goModPath)) {
      await this.extractGoModDependencies(goModPath, libraries);
    }

    if (await fs.pathExists(goSumPath)) {
      await this.extractGoSumDependencies(goSumPath, libraries);
    }
  }

  private async extractGoModDependencies(goModPath: string, libraries: any[]): Promise<void> {
    try {
      const goModContent = await fs.readFile(goModPath, 'utf-8');
      const lines = goModContent.split('\n');
      let inRequireBlock = false;

      for (const line of lines) {
        const trimmed = line.trim();

        if (trimmed === 'require (') {
          inRequireBlock = true;
          continue;
        }

        if (trimmed === ')') {
          inRequireBlock = false;
          continue;
        }

        const requireMatch = trimmed.match(/^require\s+([^\s]+)\s+([^\s]+)/);
        if (requireMatch) {
          libraries.push({
            name: requireMatch[1],
            version: requireMatch[2],
            type: 'go_module',
            source: 'go.mod',
            metadata: {
              isProduction: true,
              isDirect: true
            }
          });
          continue;
        }

        if (inRequireBlock && trimmed) {
          const blockMatch = trimmed.match(/^([^\s]+)\s+([^\s]+)/);
          if (blockMatch) {
            libraries.push({
              name: blockMatch[1],
              version: blockMatch[2],
              type: 'go_module',
              source: 'go.mod',
              metadata: {
                isProduction: true,
                isDirect: true
              }
            });
          }
        }
      }
    } catch (error) {
      console.warn('Failed to parse go.mod:', error);
    }
  }

  private async extractGoSumDependencies(goSumPath: string, libraries: any[]): Promise<void> {
    try {
      const goSumContent = await fs.readFile(goSumPath, 'utf-8');
      const lines = goSumContent.split('\n');

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          const sumMatch = trimmed.match(/^([^\s]+)\s+([^\s]+)\s+([^\s]+)/);
          if (sumMatch) {
            const existingLib = libraries.find(lib => lib.name === sumMatch[1] && lib.version === sumMatch[2]);
            if (existingLib) {
              existingLib.metadata.checksum = sumMatch[3];
            }
          }
        }
      }
    } catch (error) {
      console.warn('Failed to parse go.sum:', error);
    }
  }

  private async analyzeGoFile(
    fullPath: string,
    relativePath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: any[],
    exitPoints: any[],
    packages: Map<string, string[]>,
    _context: AnalysisContext
  ): Promise<void> {
    try {
      const content = await fs.readFile(fullPath, 'utf-8');
      const lines = content.split('\n');

      const packageName = this.extractPackage(content);
      const imports = this.extractImports(content);
      const structs = this.extractStructs(content, relativePath);
      const interfaces = this.extractInterfaces(content, relativePath);
      const functions = this.extractFunctions(content, relativePath);
      const types = this.extractTypes(content, relativePath);
      const variables = this.extractVariables(content);
      const constants = this.extractConstants(content);

      if (packageName) {
        if (!packages.has(packageName)) {
          packages.set(packageName, []);
        }
        packages.get(packageName)!.push(relativePath);
      }

      const fileId = `file_${this.sanitizeId(relativePath)}`;
      nodes.push(this.createNode(
        fileId,
        relativePath.split('/').pop() || 'unknown.go',
        'file',
        1,
        fullPath,
        1,
        lines.length,
        {
          packageName: packageName || 'main',
          imports: imports.map(i => i.path),
          structCount: structs.length,
          interfaceCount: interfaces.length,
          functionCount: functions.length,
          typeCount: types.length,
          variableCount: variables.length,
          constantCount: constants.length
        }
      ));

      for (const imp of imports) {
        const importId = `import_${fileId}_${this.sanitizeId(imp.path)}`;
        nodes.push(this.createNode(
          importId,
          imp.alias || imp.path,
          'import',
          2,
          fullPath,
          imp.lineNumber,
          imp.lineNumber,
          {
            path: imp.path,
            alias: imp.alias,
            isStandard: imp.isStandard,
            isDotImport: imp.isDotImport,
            isBlankImport: imp.isBlankImport
          }
        ));

        edges.push(this.createEdge(
          `${fileId}_imports_${importId}`,
          fileId,
          importId,
          'imports'
        ));

        if (!imp.isStandard) {
          exitPoints.push({
            id: `exit_${importId}`,
            name: `External package: ${imp.path}`,
            type: 'external_package',
            source_node: importId,
            metadata: { path: imp.path }
          });
        }
      }

      for (const struct of structs) {
        await this.processGoStruct(struct, fileId, fullPath, nodes, edges, entryPoints);
      }

      for (const intf of interfaces) {
        await this.processGoInterface(intf, fileId, fullPath, nodes, edges, entryPoints);
      }

      for (const func of functions) {
        await this.processGoFunction(func, fileId, fullPath, nodes, edges, entryPoints);
      }

      for (const type of types) {
        await this.processGoType(type, fileId, fullPath, nodes, edges, entryPoints);
      }

      for (const variable of variables) {
        const variableId = `variable_${fileId}_${this.sanitizeId(variable.name)}`;
        nodes.push(this.createNode(
          variableId,
          variable.name,
          'variable',
          3,
          fullPath,
          variable.lineNumber,
          variable.lineNumber,
          {
            type: variable.type,
            value: variable.value,
            isExported: variable.isExported,
            isConst: variable.isConst,
            scope: variable.scope
          }
        ));

        edges.push(this.createEdge(
          `${fileId}_contains_${variableId}`,
          fileId,
          variableId,
          'contains'
        ));
      }

      for (const constant of constants) {
        const constantId = `constant_${fileId}_${this.sanitizeId(constant.name)}`;
        nodes.push(this.createNode(
          constantId,
          constant.name,
          'constant',
          3,
          fullPath,
          constant.lineNumber,
          constant.lineNumber,
          {
            type: constant.type,
            value: constant.value,
            isExported: constant.isExported,
            iota: constant.iota
          }
        ));

        edges.push(this.createEdge(
          `${fileId}_contains_${constantId}`,
          fileId,
          constantId,
          'contains'
        ));
      }

    } catch (error) {
      console.warn(`Failed to analyze Go file ${relativePath}:`, error);
    }
  }

  private async processGoStruct(
    struct: GoStruct,
    fileId: string,
    fullPath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: any[]
  ): Promise<void> {
    const structId = `struct_${this.sanitizeId(struct.packageName)}_${this.sanitizeId(struct.name)}`;

    nodes.push(this.createNode(
      structId,
      struct.name,
      'struct',
      2,
      fullPath,
      struct.lineStart,
      struct.lineEnd,
      {
        packageName: struct.packageName,
        fieldCount: struct.fields.length,
        methodCount: struct.methods.length,
        tags: struct.tags,
        embedded: struct.embedded,
        isExported: struct.isExported
      }
    ));

    edges.push(this.createEdge(
      `${fileId}_contains_${structId}`,
      fileId,
      structId,
      'contains'
    ));

    for (const field of struct.fields) {
      const fieldId = `field_${structId}_${this.sanitizeId(field.name)}`;
      nodes.push(this.createNode(
        fieldId,
        field.name,
        'field',
        4,
        fullPath,
        field.lineNumber,
        field.lineNumber,
        {
          type: field.type,
          tag: field.tag,
          isExported: field.isExported,
          isEmbedded: field.isEmbedded
        }
      ));

      edges.push(this.createEdge(
        `${structId}_has_field_${fieldId}`,
        structId,
        fieldId,
        'has_field'
      ));
    }

    for (const method of struct.methods) {
      const methodId = `method_${structId}_${this.sanitizeId(method.name)}_${method.lineStart}`;
      nodes.push(this.createNode(
        methodId,
        method.name,
        'method',
        4,
        fullPath,
        method.lineStart,
        method.lineEnd,
        {
          parameters: method.parameters,
          returnTypes: method.returnTypes,
          receiver: method.receiver,
          isExported: method.isExported
        }
      ));

      edges.push(this.createEdge(
        `${structId}_has_method_${methodId}`,
        structId,
        methodId,
        'has_method'
      ));
    }

    if (struct.isExported) {
      entryPoints.push({
        id: `entry_${structId}`,
        name: `Exported struct: ${struct.name}`,
        type: 'exported_struct',
        source_node: structId,
        metadata: {
          packageName: struct.packageName,
          structName: struct.name,
          tags: struct.tags
        }
      });
    }
  }

  private async processGoInterface(
    intf: GoInterface,
    fileId: string,
    fullPath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: any[]
  ): Promise<void> {
    const interfaceId = `interface_${this.sanitizeId(intf.packageName)}_${this.sanitizeId(intf.name)}`;

    nodes.push(this.createNode(
      interfaceId,
      intf.name,
      'interface',
      2,
      fullPath,
      intf.lineStart,
      intf.lineEnd,
      {
        packageName: intf.packageName,
        methodCount: intf.methods.length,
        embedded: intf.embedded,
        isExported: intf.isExported
      }
    ));

    edges.push(this.createEdge(
      `${fileId}_contains_${interfaceId}`,
      fileId,
      interfaceId,
      'contains'
    ));

    for (const method of intf.methods) {
      const methodId = `method_${interfaceId}_${this.sanitizeId(method.name)}_${method.lineStart}`;
      nodes.push(this.createNode(
        methodId,
        method.name,
        'interface_method',
        4,
        fullPath,
        method.lineStart,
        method.lineEnd,
        {
          parameters: method.parameters,
          returnTypes: method.returnTypes
        }
      ));

      edges.push(this.createEdge(
        `${interfaceId}_declares_${methodId}`,
        interfaceId,
        methodId,
        'declares'
      ));
    }

    if (intf.isExported) {
      entryPoints.push({
        id: `entry_${interfaceId}`,
        name: `Exported interface: ${intf.name}`,
        type: 'exported_interface',
        source_node: interfaceId,
        metadata: {
          packageName: intf.packageName,
          interfaceName: intf.name,
          embedded: intf.embedded
        }
      });
    }
  }

  private async processGoFunction(
    func: GoFunction,
    fileId: string,
    fullPath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: any[]
  ): Promise<void> {
    const functionId = `function_${this.sanitizeId(func.packageName)}_${this.sanitizeId(func.name)}_${func.lineStart}`;

    nodes.push(this.createNode(
      functionId,
      func.name,
      'function',
      3,
      fullPath,
      func.lineStart,
      func.lineEnd,
      {
        packageName: func.packageName,
        parameters: func.parameters,
        returnTypes: func.returnTypes,
        receiver: func.receiver,
        isExported: func.isExported,
        isMain: func.isMain,
        isInit: func.isInit
      }
    ));

    edges.push(this.createEdge(
      `${fileId}_contains_${functionId}`,
      fileId,
      functionId,
      'contains'
    ));

    if (func.isMain) {
      entryPoints.push({
        id: `entry_${functionId}`,
        name: `Main function: ${func.name}`,
        type: 'main_function',
        source_node: functionId,
        metadata: {
          packageName: func.packageName,
          functionName: func.name
        }
      });
    } else if (func.isInit) {
      entryPoints.push({
        id: `entry_${functionId}`,
        name: `Init function: ${func.name}`,
        type: 'init_function',
        source_node: functionId,
        metadata: {
          packageName: func.packageName,
          functionName: func.name
        }
      });
    } else if (func.isExported) {
      entryPoints.push({
        id: `entry_${functionId}`,
        name: `Exported function: ${func.name}`,
        type: 'exported_function',
        source_node: functionId,
        metadata: {
          packageName: func.packageName,
          functionName: func.name,
          returnTypes: func.returnTypes,
          parameters: func.parameters.map(p => p.type)
        }
      });
    }
  }

  private async processGoType(
    type: GoType,
    fileId: string,
    fullPath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: any[]
  ): Promise<void> {
    const typeId = `type_${this.sanitizeId(type.packageName)}_${this.sanitizeId(type.name)}`;

    nodes.push(this.createNode(
      typeId,
      type.name,
      'type',
      2,
      fullPath,
      type.lineNumber,
      type.lineNumber,
      {
        packageName: type.packageName,
        underlying: type.underlying,
        methodCount: type.methods.length,
        isExported: type.isExported
      }
    ));

    edges.push(this.createEdge(
      `${fileId}_contains_${typeId}`,
      fileId,
      typeId,
      'contains'
    ));

    for (const method of type.methods) {
      const methodId = `method_${typeId}_${this.sanitizeId(method.name)}_${method.lineStart}`;
      nodes.push(this.createNode(
        methodId,
        method.name,
        'method',
        4,
        fullPath,
        method.lineStart,
        method.lineEnd,
        {
          parameters: method.parameters,
          returnTypes: method.returnTypes,
          receiver: method.receiver,
          isExported: method.isExported
        }
      ));

      edges.push(this.createEdge(
        `${typeId}_has_method_${methodId}`,
        typeId,
        methodId,
        'has_method'
      ));
    }

    if (type.isExported) {
      entryPoints.push({
        id: `entry_${typeId}`,
        name: `Exported type: ${type.name}`,
        type: 'exported_type',
        source_node: typeId,
        metadata: {
          packageName: type.packageName,
          typeName: type.name,
          underlying: type.underlying
        }
      });
    }
  }

  private extractPackage(content: string): string | null {
    const packageMatch = content.match(/^package\s+(\w+)/m);
    return packageMatch ? packageMatch[1] : null;
  }

  private extractImports(content: string): GoImport[] {
    const imports: GoImport[] = [];
    const lines = content.split('\n');
    let inImportBlock = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line === 'import (') {
        inImportBlock = true;
        continue;
      }

      if (line === ')' && inImportBlock) {
        inImportBlock = false;
        continue;
      }

      const singleImportMatch = line.match(/^import\s+(?:(\w+|\.|_)\s+)?"([^"]+)"/);
      if (singleImportMatch) {
        const alias = singleImportMatch[1];
        const path = singleImportMatch[2];

        imports.push({
          path,
          alias: alias && alias !== '.' && alias !== '_' ? alias : undefined,
          lineNumber: i + 1,
          isStandard: this.isStandardPackage(path),
          isDotImport: alias === '.',
          isBlankImport: alias === '_'
        });
        continue;
      }

      if (inImportBlock && line) {
        const blockImportMatch = line.match(/^(?:(\w+|\.|_)\s+)?"([^"]+)"/);
        if (blockImportMatch) {
          const alias = blockImportMatch[1];
          const path = blockImportMatch[2];

          imports.push({
            path,
            alias: alias && alias !== '.' && alias !== '_' ? alias : undefined,
            lineNumber: i + 1,
            isStandard: this.isStandardPackage(path),
            isDotImport: alias === '.',
            isBlankImport: alias === '_'
          });
        }
      }
    }

    return imports;
  }

  private extractStructs(content: string, filePath: string): GoStruct[] {
    const structs: GoStruct[] = [];
    const lines = content.split('\n');
    const packageName = this.extractPackage(content) || 'main';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.includes('type ') && line.includes('struct')) {
        const structMatch = line.match(/type\s+(\w+)\s+struct/);
        if (structMatch) {
          const structName = structMatch[1];
          const structStartLine = i + 1;
          const structEndLine = this.findBlockEnd(lines, i);

          const fields = this.extractStructFields(lines, i, structEndLine);
          const methods = this.extractMethodsForType(lines, structName, packageName);
          const tags = this.extractStructTags(lines, i, structEndLine);
          const embedded = this.extractEmbeddedTypes(lines, i, structEndLine);

          structs.push({
            name: structName,
            packageName,
            filePath,
            fields,
            methods,
            tags,
            embedded,
            lineStart: structStartLine,
            lineEnd: structEndLine,
            isExported: this.isExported(structName)
          });
        }
      }
    }

    return structs;
  }

  private extractInterfaces(content: string, filePath: string): GoInterface[] {
    const interfaces: GoInterface[] = [];
    const lines = content.split('\n');
    const packageName = this.extractPackage(content) || 'main';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.includes('type ') && line.includes('interface')) {
        const interfaceMatch = line.match(/type\s+(\w+)\s+interface/);
        if (interfaceMatch) {
          const interfaceName = interfaceMatch[1];
          const interfaceStartLine = i + 1;
          const interfaceEndLine = this.findBlockEnd(lines, i);

          const methods = this.extractInterfaceMethods(lines, i, interfaceEndLine);
          const embedded = this.extractEmbeddedTypes(lines, i, interfaceEndLine);

          interfaces.push({
            name: interfaceName,
            packageName,
            filePath,
            methods,
            embedded,
            lineStart: interfaceStartLine,
            lineEnd: interfaceEndLine,
            isExported: this.isExported(interfaceName)
          });
        }
      }
    }

    return interfaces;
  }

  private extractFunctions(content: string, filePath: string): GoFunction[] {
    const functions: GoFunction[] = [];
    const lines = content.split('\n');
    const packageName = this.extractPackage(content) || 'main';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.startsWith('func ')) {
        const funcMatch = line.match(/func(?:\s+\(([^)]+)\))?\s+(\w+)\s*\(([^)]*)\)(?:\s*\(([^)]*)\)|\s+([^{]+))?/);
        if (funcMatch) {
          const receiverStr = funcMatch[1];
          const functionName = funcMatch[2];
          const paramsStr = funcMatch[3];
          const returnTypesStr = funcMatch[4] || funcMatch[5];

          const functionStartLine = i + 1;
          const functionEndLine = this.findBlockEnd(lines, i);

          const parameters = this.extractFunctionParameters(paramsStr);
          const returnTypes = this.extractReturnTypes(returnTypesStr);
          const receiver = receiverStr ? this.parseReceiver(receiverStr) : undefined;

          functions.push({
            name: functionName,
            packageName,
            filePath,
            parameters,
            returnTypes,
            receiver,
            lineStart: functionStartLine,
            lineEnd: functionEndLine,
            isExported: this.isExported(functionName),
            isMain: functionName === 'main' && packageName === 'main',
            isInit: functionName === 'init'
          });
        }
      }
    }

    return functions;
  }

  private extractTypes(content: string, filePath: string): GoType[] {
    const types: GoType[] = [];
    const lines = content.split('\n');
    const packageName = this.extractPackage(content) || 'main';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.startsWith('type ') && !line.includes('struct') && !line.includes('interface')) {
        const typeMatch = line.match(/type\s+(\w+)\s+(.+)/);
        if (typeMatch) {
          const typeName = typeMatch[1];
          const underlying = typeMatch[2];

          const methods = this.extractMethodsForType(lines, typeName, packageName);

          types.push({
            name: typeName,
            packageName,
            filePath,
            underlying,
            methods,
            lineNumber: i + 1,
            isExported: this.isExported(typeName)
          });
        }
      }
    }

    return types;
  }

  private extractVariables(content: string): GoVariable[] {
    const variables: GoVariable[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.startsWith('var ')) {
        const varMatch = line.match(/var\s+(\w+)(?:\s+([^=]+))?(?:\s*=\s*(.+))?/);
        if (varMatch) {
          const varName = varMatch[1];
          const type = varMatch[2]?.trim();
          const value = varMatch[3]?.trim();

          variables.push({
            name: varName,
            type,
            value,
            lineNumber: i + 1,
            isExported: this.isExported(varName),
            isConst: false,
            scope: 'package'
          });
        }
      }
    }

    return variables;
  }

  private extractConstants(content: string): GoConstant[] {
    const constants: GoConstant[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.startsWith('const ')) {
        const constMatch = line.match(/const\s+(\w+)(?:\s+([^=]+))?(?:\s*=\s*(.+))?/);
        if (constMatch) {
          const constName = constMatch[1];
          const type = constMatch[2]?.trim();
          const value = constMatch[3]?.trim();

          constants.push({
            name: constName,
            type,
            value,
            lineNumber: i + 1,
            isExported: this.isExported(constName),
            iota: value?.includes('iota')
          });
        }
      }
    }

    return constants;
  }

  private extractStructFields(lines: string[], structStart: number, structEnd: number): GoField[] {
    const fields: GoField[] = [];

    for (let i = structStart + 1; i < structEnd; i++) {
      const line = lines[i].trim();

      if (line && !line.startsWith('//') && !line.startsWith('{') && !line.startsWith('}')) {
        const fieldMatch = line.match(/^(\w+)\s+([^`]+)(?:`([^`]+)`)?/);
        if (fieldMatch) {
          const fieldName = fieldMatch[1];
          const fieldType = fieldMatch[2].trim();
          const tag = fieldMatch[3];

          fields.push({
            name: fieldName,
            type: fieldType,
            tag,
            lineNumber: i + 1,
            isExported: this.isExported(fieldName),
            isEmbedded: false
          });
        } else {
          const embeddedMatch = line.match(/^([A-Z]\w*)(?:`([^`]+)`)?/);
          if (embeddedMatch) {
            fields.push({
              name: embeddedMatch[1],
              type: embeddedMatch[1],
              tag: embeddedMatch[2],
              lineNumber: i + 1,
              isExported: true,
              isEmbedded: true
            });
          }
        }
      }
    }

    return fields;
  }

  private extractInterfaceMethods(lines: string[], interfaceStart: number, interfaceEnd: number): GoMethod[] {
    const methods: GoMethod[] = [];

    for (let i = interfaceStart + 1; i < interfaceEnd; i++) {
      const line = lines[i].trim();

      if (line && !line.startsWith('//') && !line.startsWith('{') && !line.startsWith('}')) {
        const methodMatch = line.match(/^(\w+)\s*\(([^)]*)\)(?:\s*\(([^)]*)\)|\s+([^{]+))?/);
        if (methodMatch) {
          const methodName = methodMatch[1];
          const paramsStr = methodMatch[2];
          const returnTypesStr = methodMatch[3] || methodMatch[4];

          const parameters = this.extractFunctionParameters(paramsStr);
          const returnTypes = this.extractReturnTypes(returnTypesStr);

          methods.push({
            name: methodName,
            parameters,
            returnTypes,
            lineStart: i + 1,
            lineEnd: i + 1,
            isExported: this.isExported(methodName)
          });
        }
      }
    }

    return methods;
  }

  private extractMethodsForType(lines: string[], typeName: string, packageName: string): GoMethod[] {
    const methods: GoMethod[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.startsWith('func ')) {
        const methodMatch = line.match(/func\s+\(([^)]+)\)\s+(\w+)\s*\(([^)]*)\)(?:\s*\(([^)]*)\)|\s+([^{]+))?/);
        if (methodMatch) {
          const receiverStr = methodMatch[1];
          const methodName = methodMatch[2];

          if (receiverStr.includes(typeName)) {
            const paramsStr = methodMatch[3];
            const returnTypesStr = methodMatch[4] || methodMatch[5];

            const parameters = this.extractFunctionParameters(paramsStr);
            const returnTypes = this.extractReturnTypes(returnTypesStr);
            const receiver = this.parseReceiver(receiverStr);

            const methodEndLine = this.findBlockEnd(lines, i);

            methods.push({
              name: methodName,
              parameters,
              returnTypes,
              receiver,
              lineStart: i + 1,
              lineEnd: methodEndLine,
              isExported: this.isExported(methodName)
            });
          }
        }
      }
    }

    return methods;
  }

  private extractFunctionParameters(paramsStr: string): GoParameter[] {
    const parameters: GoParameter[] = [];

    if (!paramsStr || !paramsStr.trim()) {
      return parameters;
    }

    const params = this.splitFunctionParams(paramsStr);

    for (const param of params) {
      const trimmed = param.trim();

      if (trimmed.startsWith('...')) {
        const variadicMatch = trimmed.match(/^\.\.\.(\w+)\s+(.+)/);
        if (variadicMatch) {
          parameters.push({
            name: variadicMatch[1],
            type: variadicMatch[2],
            isVariadic: true
          });
        }
      } else {
        const paramMatch = trimmed.match(/^(\w+)\s+(.+)/);
        if (paramMatch) {
          parameters.push({
            name: paramMatch[1],
            type: paramMatch[2],
            isVariadic: false
          });
        } else if (trimmed) {
          parameters.push({
            name: '',
            type: trimmed,
            isVariadic: false
          });
        }
      }
    }

    return parameters;
  }

  private extractReturnTypes(returnTypesStr?: string): string[] {
    if (!returnTypesStr || !returnTypesStr.trim()) {
      return [];
    }

    const trimmed = returnTypesStr.trim();

    if (trimmed.startsWith('(') && trimmed.endsWith(')')) {
      const inner = trimmed.slice(1, -1);
      return inner.split(',').map(t => t.trim()).filter(t => t);
    }

    return [trimmed];
  }

  private parseReceiver(receiverStr: string): GoReceiver {
    const receiverMatch = receiverStr.match(/^(\w+)\s+(\*?)(\w+)/);
    if (receiverMatch) {
      return {
        name: receiverMatch[1],
        type: receiverMatch[3],
        isPointer: receiverMatch[2] === '*'
      };
    }

    return {
      name: '',
      type: receiverStr.trim(),
      isPointer: false
    };
  }

  private extractStructTags(lines: string[], structStart: number, structEnd: number): string[] {
    const tags: string[] = [];

    for (let i = structStart + 1; i < structEnd; i++) {
      const line = lines[i].trim();
      const tagMatch = line.match(/`([^`]+)`/);
      if (tagMatch) {
        tags.push(tagMatch[1]);
      }
    }

    return tags;
  }

  private extractEmbeddedTypes(lines: string[], blockStart: number, blockEnd: number): string[] {
    const embedded: string[] = [];

    for (let i = blockStart + 1; i < blockEnd; i++) {
      const line = lines[i].trim();
      const embeddedMatch = line.match(/^([A-Z]\w*)\s*$/);
      if (embeddedMatch) {
        embedded.push(embeddedMatch[1]);
      }
    }

    return embedded;
  }

  private splitFunctionParams(paramsStr: string): string[] {
    const params: string[] = [];
    let current = '';
    let depth = 0;

    for (const char of paramsStr) {
      if (char === '(') depth++;
      else if (char === ')') depth--;
      else if (char === ',' && depth === 0) {
        params.push(current.trim());
        current = '';
        continue;
      }

      current += char;
    }

    if (current.trim()) {
      params.push(current.trim());
    }

    return params;
  }

  private findBlockEnd(lines: string[], startIndex: number): number {
    let braceCount = 0;
    let foundOpenBrace = false;

    for (let i = startIndex; i < lines.length; i++) {
      const line = lines[i];

      for (const char of line) {
        if (char === '{') {
          braceCount++;
          foundOpenBrace = true;
        } else if (char === '}') {
          braceCount--;
          if (foundOpenBrace && braceCount === 0) {
            return i + 1;
          }
        }
      }
    }

    return lines.length;
  }

  private buildPackageHierarchy(packages: Map<string, string[]>, nodes: CASNode[], edges: CASEdge[]): void {
    for (const [packageName, files] of packages.entries()) {
      const packageId = `package_${this.sanitizeId(packageName)}`;

      nodes.push(this.createNode(
        packageId,
        packageName,
        'package',
        1,
        undefined,
        undefined,
        undefined,
        {
          fileCount: files.length,
          files: files
        }
      ));

      for (const file of files) {
        const fileId = `file_${this.sanitizeId(file)}`;
        edges.push(this.createEdge(
          `${packageId}_contains_${fileId}`,
          packageId,
          fileId,
          'contains'
        ));
      }
    }
  }

  private detectFrameworkPatterns(nodes: CASNode[], _edges: CASEdge[], entryPoints: any[]): void {
    const frameworkPatterns = {
      gin: ['gin.Engine', 'gin.Context', 'gin.HandlerFunc'],
      echo: ['echo.Echo', 'echo.Context', 'echo.HandlerFunc'],
      gorilla: ['mux.Router', 'mux.Vars'],
      fiber: ['fiber.App', 'fiber.Ctx']
    };

    for (const node of nodes) {
      if (node.type === 'function' && node.metadata?.attributes?.parameters) {
        const parameters = node.metadata.attributes.parameters as GoParameter[];

        for (const [framework, patterns] of Object.entries(frameworkPatterns)) {
          if (patterns.some(pattern => parameters.some(p => p.type.includes(pattern)))) {
            entryPoints.push({
              id: `entry_${framework}_${node.id}`,
              name: `${framework.charAt(0).toUpperCase() + framework.slice(1)} handler: ${node.name}`,
              type: `${framework}_handler`,
              source_node: node.id,
              metadata: {
                framework,
                functionName: node.name
              }
            });
          }
        }
      }
    }
  }

  private buildTypeRelationships(nodes: CASNode[], edges: CASEdge[]): void {
    const structNodes = nodes.filter(n => n.type === 'struct');
    const interfaceNodes = nodes.filter(n => n.type === 'interface');

    for (const structNode of structNodes) {
      const structMethods = nodes.filter(n =>
        n.type === 'method' &&
        n.metadata?.attributes?.receiver &&
        (n.metadata.attributes.receiver as GoReceiver).type === structNode.name
      );

      for (const interfaceNode of interfaceNodes) {
        const interfaceMethods = nodes.filter(n =>
          n.type === 'interface_method' &&
          edges.some(e => e.source === interfaceNode.id && e.target === n.id)
        );

        const implementsInterface = interfaceMethods.every(intfMethod =>
          structMethods.some(structMethod => structMethod.name === intfMethod.name)
        );

        if (implementsInterface && interfaceMethods.length > 0) {
          edges.push(this.createEdge(
            `${structNode.id}_implements_${interfaceNode.id}`,
            structNode.id,
            interfaceNode.id,
            'implements'
          ));
        }
      }
    }
  }

  private isStandardPackage(path: string): boolean {
    const standardPackages = [
      'fmt', 'os', 'io', 'net', 'http', 'time', 'strings', 'strconv',
      'encoding', 'json', 'xml', 'crypto', 'reflect', 'sort', 'sync',
      'context', 'log', 'flag', 'path', 'regexp', 'bytes', 'bufio',
      'archive', 'compress', 'database', 'debug', 'go', 'hash',
      'html', 'image', 'index', 'math', 'mime', 'plugin', 'runtime',
      'testing', 'text', 'unicode', 'unsafe'
    ];

    const firstPart = path.split('/')[0];
    return standardPackages.includes(firstPart) || !path.includes('.');
  }

  private isExported(name: string): boolean {
    return name.length > 0 && name[0] >= 'A' && name[0] <= 'Z';
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
      'struct-analysis',
      'interface-detection',
      'function-mapping',
      'package-organization',
      'method-receiver-analysis',
      'framework-detection',
      'go-modules-support'
    ];
  }
}