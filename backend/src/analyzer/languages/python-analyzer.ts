import { BaseAnalyzer, AnalysisContext } from '../core/base-analyzer';
import { CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint } from '../../types/cas.types';
import { AnalyzerError } from '../core/errors';
import * as fs from 'fs-extra';
import { glob } from 'glob';

interface PythonClass {
  name: string;
  moduleName: string;
  filePath: string;
  baseClasses: string[];
  methods: PythonMethod[];
  attributes: PythonAttribute[];
  decorators: string[];
  docstring?: string;
  lineStart: number;
  lineEnd: number;
  isAbstract: boolean;
}

interface PythonMethod {
  name: string;
  parameters: PythonParameter[];
  decorators: string[];
  docstring?: string;
  returnAnnotation?: string;
  lineStart: number;
  lineEnd: number;
  isClassMethod: boolean;
  isStaticMethod: boolean;
  isProperty: boolean;
  isPrivate: boolean;
  isAbstract: boolean;
  isAsync: boolean;
}

interface PythonFunction {
  name: string;
  parameters: PythonParameter[];
  decorators: string[];
  docstring?: string;
  returnAnnotation?: string;
  lineStart: number;
  lineEnd: number;
  isAsync: boolean;
  isPrivate: boolean;
}

interface PythonParameter {
  name: string;
  annotation?: string;
  defaultValue?: string;
  isVarArgs: boolean;
  isKwArgs: boolean;
}

interface PythonAttribute {
  name: string;
  annotation?: string;
  value?: string;
  lineNumber: number;
  isPrivate: boolean;
  isClassAttribute: boolean;
}

interface PythonImport {
  module: string;
  alias?: string;
  fromImport?: string;
  lineNumber: number;
  isRelative: boolean;
}

interface PythonVariable {
  name: string;
  annotation?: string;
  value?: string;
  lineNumber: number;
  scope: 'global' | 'local' | 'class';
}

export class PythonAnalyzer extends BaseAnalyzer {
  private djangoFrameworkDetected = false;
  private flaskFrameworkDetected = false;
  private fastApiFrameworkDetected = false;
  private poetryProject = false;
  private pipenvProject = false;

  constructor() {
    super(
      'python-analyzer',
      'Python Language Analyzer',
      '1.0.0',
      'language'
    );
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const pythonFiles = await glob(['**/*.py'], {
        cwd: projectPath,
        ignore: ['**/venv/**', '**/.venv/**', '**/env/**', '**/__pycache__/**', '**/.git/**']
      });

      const configFiles = await glob(['requirements.txt', 'setup.py', 'pyproject.toml', 'Pipfile'], {
        cwd: projectPath
      });

      return pythonFiles.length > 0 || configFiles.length > 0;
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

      const pythonFiles = await glob(['**/*.py'], {
        cwd: context.projectPath,
        ignore: ['**/venv/**', '**/.venv/**', '**/env/**', '**/__pycache__/**', '**/.git/**', '**/test_*.py', '**/*_test.py']
      });

      const modules = new Map<string, string[]>();

      for (const file of pythonFiles) {
        const fullPath = `${context.projectPath}/${file}`;
        await this.analyzePythonFile(fullPath, file, nodes, edges, entryPoints, exitPoints, modules);
      }

      this.buildModuleHierarchy(modules, nodes, edges);
      this.detectFrameworkPatterns(nodes, edges, entryPoints);
      this.buildInheritanceRelationships(nodes, edges);

      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        framework_specific: {
          language: 'python',
          djangoFramework: this.djangoFrameworkDetected,
          flaskFramework: this.flaskFrameworkDetected,
          fastApiFramework: this.fastApiFrameworkDetected,
          packageManager: this.poetryProject ? 'poetry' : this.pipenvProject ? 'pipenv' : 'pip',
          libraries,
          filesAnalyzed: pythonFiles.length,
          modulesFound: modules.size
        }
      });

    } catch (error) {
      throw new AnalyzerError(
        `Python analysis failed: ${(error as Error).message}`,
        'PYTHON_ANALYSIS_ERROR'
      );
    }
  }

  private async detectProjectType(projectPath: string): Promise<void> {
    const pyprojectPath = `${projectPath}/pyproject.toml`;
    const pipfilePath = `${projectPath}/Pipfile`;
    const requirementsPath = `${projectPath}/requirements.txt`;

    this.poetryProject = await fs.pathExists(pyprojectPath);
    this.pipenvProject = await fs.pathExists(pipfilePath);

    if (this.poetryProject) {
      const pyprojectContent = await fs.readFile(pyprojectPath, 'utf-8');
      this.detectFrameworks(pyprojectContent);
    }

    if (this.pipenvProject) {
      const pipfileContent = await fs.readFile(pipfilePath, 'utf-8');
      this.detectFrameworks(pipfileContent);
    }

    if (await fs.pathExists(requirementsPath)) {
      const requirementsContent = await fs.readFile(requirementsPath, 'utf-8');
      this.detectFrameworks(requirementsContent);
    }
  }

  private detectFrameworks(content: string): void {
    this.djangoFrameworkDetected = this.djangoFrameworkDetected ||
      content.includes('django') || content.includes('Django');

    this.flaskFrameworkDetected = this.flaskFrameworkDetected ||
      content.includes('flask') || content.includes('Flask');

    this.fastApiFrameworkDetected = this.fastApiFrameworkDetected ||
      content.includes('fastapi') || content.includes('FastAPI');
  }

  private async extractDependencies(projectPath: string, libraries: any[]): Promise<void> {
    const requirementsPath = `${projectPath}/requirements.txt`;
    const pyprojectPath = `${projectPath}/pyproject.toml`;
    const pipfilePath = `${projectPath}/Pipfile`;

    if (await fs.pathExists(requirementsPath)) {
      await this.extractRequirementsDependencies(requirementsPath, libraries);
    }

    if (await fs.pathExists(pyprojectPath)) {
      await this.extractPyprojectDependencies(pyprojectPath, libraries);
    }

    if (await fs.pathExists(pipfilePath)) {
      await this.extractPipfileDependencies(pipfilePath, libraries);
    }
  }

  private async extractRequirementsDependencies(requirementsPath: string, libraries: any[]): Promise<void> {
    try {
      const content = await fs.readFile(requirementsPath, 'utf-8');
      const lines = content.split('\n');

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          const match = trimmed.match(/^([a-zA-Z0-9\-_]+)([>=<~!]+)?([0-9.]*)?/);
          if (match) {
            libraries.push({
              name: match[1],
              version: match[3] || 'unknown',
              type: 'pip_package',
              source: 'requirements.txt',
              metadata: {
                constraint: match[2] || '==',
                isProduction: true
              }
            });
          }
        }
      }
    } catch (error) {
      console.warn('Failed to parse requirements.txt:', error);
    }
  }

  private async extractPyprojectDependencies(pyprojectPath: string, libraries: any[]): Promise<void> {
    try {
      const content = await fs.readFile(pyprojectPath, 'utf-8');
      const dependencySection = content.match(/\[tool\.poetry\.dependencies\]([\s\S]*?)(?=\[|$)/);

      if (dependencySection) {
        const lines = dependencySection[1].split('\n');
        for (const line of lines) {
          const match = line.match(/^([a-zA-Z0-9\-_]+)\s*=\s*["']([^"']+)["']/);
          if (match && match[1] !== 'python') {
            libraries.push({
              name: match[1],
              version: match[2],
              type: 'poetry_package',
              source: 'pyproject.toml',
              metadata: {
                isProduction: true
              }
            });
          }
        }
      }
    } catch (error) {
      console.warn('Failed to parse pyproject.toml:', error);
    }
  }

  private async extractPipfileDependencies(pipfilePath: string, libraries: any[]): Promise<void> {
    try {
      const content = await fs.readFile(pipfilePath, 'utf-8');
      const packagesSection = content.match(/\[packages\]([\s\S]*?)(?=\[|$)/);

      if (packagesSection) {
        const lines = packagesSection[1].split('\n');
        for (const line of lines) {
          const match = line.match(/^([a-zA-Z0-9\-_]+)\s*=\s*["']([^"']+)["']/);
          if (match) {
            libraries.push({
              name: match[1],
              version: match[2],
              type: 'pipenv_package',
              source: 'Pipfile',
              metadata: {
                isProduction: true
              }
            });
          }
        }
      }
    } catch (error) {
      console.warn('Failed to parse Pipfile:', error);
    }
  }

  private async analyzePythonFile(
    fullPath: string,
    relativePath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: any[],
    exitPoints: any[],
    modules: Map<string, string[]>
  ): Promise<void> {
    try {
      const content = await fs.readFile(fullPath, 'utf-8');
      const lines = content.split('\n');

      const moduleName = this.getModuleName(relativePath);
      const imports = this.extractImports(content);
      const classes = this.extractClasses(content, relativePath);
      const functions = this.extractFunctions(content, relativePath);
      const variables = this.extractGlobalVariables(content);

      if (!modules.has(moduleName)) {
        modules.set(moduleName, []);
      }
      modules.get(moduleName)!.push(relativePath);

      const fileId = `file_${this.sanitizeId(relativePath)}`;
      nodes.push(this.createNode(
        fileId,
        relativePath.split('/').pop() || 'unknown.py',
        'file',
        1,
        fullPath,
        1,
        lines.length,
        {
          moduleName,
          imports: imports.map(i => i.module),
          classCount: classes.length,
          functionCount: functions.length,
          variableCount: variables.length
        }
      ));

      for (const imp of imports) {
        const importId = `import_${fileId}_${this.sanitizeId(imp.module)}`;
        nodes.push(this.createNode(
          importId,
          imp.alias || imp.fromImport || imp.module,
          'import',
          2,
          fullPath,
          imp.lineNumber,
          imp.lineNumber,
          {
            module: imp.module,
            alias: imp.alias,
            fromImport: imp.fromImport,
            isRelative: imp.isRelative
          }
        ));

        edges.push(this.createEdge(
          `${fileId}_imports_${importId}`,
          fileId,
          importId,
          'imports'
        ));

        if (!imp.isRelative && !this.isStandardLibrary(imp.module)) {
          exitPoints.push({
            id: `exit_${importId}`,
            name: `External module: ${imp.module}`,
            type: 'external_import',
            source_node: importId,
            metadata: { module: imp.module }
          });
        }
      }

      for (const cls of classes) {
        await this.processPythonClass(cls, fileId, fullPath, nodes, edges, entryPoints);
      }

      for (const func of functions) {
        await this.processPythonFunction(func, fileId, fullPath, nodes, edges, entryPoints);
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
            annotation: variable.annotation,
            value: variable.value,
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

    } catch (error) {
      console.warn(`Failed to analyze Python file ${relativePath}:`, error);
    }
  }

  private async processPythonClass(
    cls: PythonClass,
    fileId: string,
    fullPath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: any[]
  ): Promise<void> {
    const classId = `class_${this.sanitizeId(cls.moduleName)}_${this.sanitizeId(cls.name)}`;

    nodes.push(this.createNode(
      classId,
      cls.name,
      'class',
      2,
      fullPath,
      cls.lineStart,
      cls.lineEnd,
      {
        moduleName: cls.moduleName,
        baseClasses: cls.baseClasses,
        decorators: cls.decorators,
        docstring: cls.docstring,
        methodCount: cls.methods.length,
        attributeCount: cls.attributes.length,
        isAbstract: cls.isAbstract
      }
    ));

    edges.push(this.createEdge(
      `${fileId}_contains_${classId}`,
      fileId,
      classId,
      'contains'
    ));

    for (const method of cls.methods) {
      const methodId = `method_${classId}_${this.sanitizeId(method.name)}_${method.lineStart}`;
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
          decorators: method.decorators,
          docstring: method.docstring,
          returnAnnotation: method.returnAnnotation,
          isClassMethod: method.isClassMethod,
          isStaticMethod: method.isStaticMethod,
          isProperty: method.isProperty,
          isPrivate: method.isPrivate,
          isAbstract: method.isAbstract,
          isAsync: method.isAsync
        }
      ));

      edges.push(this.createEdge(
        `${classId}_has_method_${methodId}`,
        classId,
        methodId,
        'has_method'
      ));

      if (!method.isPrivate && method.name !== '__init__') {
        entryPoints.push({
          id: `entry_${methodId}`,
          name: `Public method: ${cls.name}.${method.name}`,
          type: 'public_method',
          source_node: methodId,
          metadata: {
            className: cls.name,
            methodName: method.name,
            returnAnnotation: method.returnAnnotation,
            parameters: method.parameters.map(p => p.annotation || 'Any')
          }
        });
      }
    }

    for (const attr of cls.attributes) {
      const attrId = `attribute_${classId}_${this.sanitizeId(attr.name)}`;
      nodes.push(this.createNode(
        attrId,
        attr.name,
        'attribute',
        4,
        fullPath,
        attr.lineNumber,
        attr.lineNumber,
        {
          annotation: attr.annotation,
          value: attr.value,
          isPrivate: attr.isPrivate,
          isClassAttribute: attr.isClassAttribute
        }
      ));

      edges.push(this.createEdge(
        `${classId}_has_attribute_${attrId}`,
        classId,
        attrId,
        'has_attribute'
      ));
    }

    if (!cls.name.startsWith('_')) {
      entryPoints.push({
        id: `entry_${classId}`,
        name: `Public class: ${cls.name}`,
        type: 'public_class',
        source_node: classId,
        metadata: {
          moduleName: cls.moduleName,
          className: cls.name,
          decorators: cls.decorators,
          baseClasses: cls.baseClasses
        }
      });
    }
  }

  private async processPythonFunction(
    func: PythonFunction,
    fileId: string,
    fullPath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: any[]
  ): Promise<void> {
    const functionId = `function_${fileId}_${this.sanitizeId(func.name)}_${func.lineStart}`;

    nodes.push(this.createNode(
      functionId,
      func.name,
      'function',
      3,
      fullPath,
      func.lineStart,
      func.lineEnd,
      {
        parameters: func.parameters,
        decorators: func.decorators,
        docstring: func.docstring,
        returnAnnotation: func.returnAnnotation,
        isAsync: func.isAsync,
        isPrivate: func.isPrivate
      }
    ));

    edges.push(this.createEdge(
      `${fileId}_contains_${functionId}`,
      fileId,
      functionId,
      'contains'
    ));

    if (!func.isPrivate) {
      entryPoints.push({
        id: `entry_${functionId}`,
        name: `Public function: ${func.name}`,
        type: 'public_function',
        source_node: functionId,
        metadata: {
          functionName: func.name,
          returnAnnotation: func.returnAnnotation,
          parameters: func.parameters.map(p => p.annotation || 'Any'),
          isAsync: func.isAsync
        }
      });
    }
  }

  private extractImports(content: string): PythonImport[] {
    const imports: PythonImport[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      const fromImportMatch = line.match(/^from\s+([.\w]+)\s+import\s+(.+)/);
      if (fromImportMatch) {
        const module = fromImportMatch[1];
        const importItems = fromImportMatch[2].split(',').map(s => s.trim());

        for (const item of importItems) {
          const aliasMatch = item.match(/^(\w+)(?:\s+as\s+(\w+))?/);
          if (aliasMatch) {
            imports.push({
              module,
              fromImport: aliasMatch[1],
              alias: aliasMatch[2],
              lineNumber: i + 1,
              isRelative: module.startsWith('.')
            });
          }
        }
        continue;
      }

      const importMatch = line.match(/^import\s+(.+)/);
      if (importMatch) {
        const importItems = importMatch[1].split(',').map(s => s.trim());

        for (const item of importItems) {
          const aliasMatch = item.match(/^([.\w]+)(?:\s+as\s+(\w+))?/);
          if (aliasMatch) {
            imports.push({
              module: aliasMatch[1],
              alias: aliasMatch[2],
              lineNumber: i + 1,
              isRelative: aliasMatch[1].startsWith('.')
            });
          }
        }
      }
    }

    return imports;
  }

  private extractClasses(content: string, filePath: string): PythonClass[] {
    const classes: PythonClass[] = [];
    const lines = content.split('\n');
    const moduleName = this.getModuleName(filePath);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.trim().startsWith('class ')) {
        const classMatch = line.match(/class\s+(\w+)(?:\(([^)]*)\))?:/);
        if (classMatch) {
          const className = classMatch[1];
          const baseClasses = classMatch[2]
            ? classMatch[2].split(',').map(s => s.trim())
            : [];

          const decorators = this.extractDecorators(lines, i);
          const classStartLine = i + 1;
          const classEndLine = this.findBlockEnd(lines, i);

          const methods = this.extractMethods(lines, i, classEndLine);
          const attributes = this.extractClassAttributes(lines, i, classEndLine);
          const docstring = this.extractDocstring(lines, i + 1);

          const isAbstract = decorators.some(d => d.includes('abc.abstractmethod')) ||
                           baseClasses.some(b => b.includes('ABC'));

          classes.push({
            name: className,
            moduleName,
            filePath,
            baseClasses,
            methods,
            attributes,
            decorators,
            docstring,
            lineStart: classStartLine,
            lineEnd: classEndLine,
            isAbstract
          });
        }
      }
    }

    return classes;
  }

  private extractFunctions(content: string, filePath: string): PythonFunction[] {
    const functions: PythonFunction[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.trim().startsWith('def ') || line.trim().startsWith('async def ')) {
        const funcMatch = line.match(/(async\s+)?def\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*([^:]+))?:/);
        if (funcMatch) {
          const isAsync = !!funcMatch[1];
          const functionName = funcMatch[2];
          const paramString = funcMatch[3];
          const returnAnnotation = funcMatch[4]?.trim();

          if (!this.isInsideClass(lines, i)) {
            const decorators = this.extractDecorators(lines, i);
            const functionStartLine = i + 1;
            const functionEndLine = this.findBlockEnd(lines, i);

            const parameters = this.extractParameters(paramString);
            const docstring = this.extractDocstring(lines, i + 1);

            functions.push({
              name: functionName,
              parameters,
              decorators,
              docstring,
              returnAnnotation,
              lineStart: functionStartLine,
              lineEnd: functionEndLine,
              isAsync,
              isPrivate: functionName.startsWith('_')
            });
          }
        }
      }
    }

    return functions;
  }

  private extractMethods(lines: string[], classStart: number, classEnd: number): PythonMethod[] {
    const methods: PythonMethod[] = [];

    for (let i = classStart + 1; i < classEnd; i++) {
      const line = lines[i];
      const indent = line.length - line.trimStart().length;

      if (indent > 0 && (line.trim().startsWith('def ') || line.trim().startsWith('async def '))) {
        const methodMatch = line.match(/(async\s+)?def\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*([^:]+))?:/);
        if (methodMatch) {
          const isAsync = !!methodMatch[1];
          const methodName = methodMatch[2];
          const paramString = methodMatch[3];
          const returnAnnotation = methodMatch[4]?.trim();

          const decorators = this.extractDecorators(lines, i);
          const methodStartLine = i + 1;
          const methodEndLine = this.findBlockEnd(lines, i);

          const parameters = this.extractParameters(paramString);
          const docstring = this.extractDocstring(lines, i + 1);

          const isClassMethod = decorators.includes('classmethod');
          const isStaticMethod = decorators.includes('staticmethod');
          const isProperty = decorators.includes('property');
          const isPrivate = methodName.startsWith('_');
          const isAbstract = decorators.some(d => d.includes('abstractmethod'));

          methods.push({
            name: methodName,
            parameters,
            decorators,
            docstring,
            returnAnnotation,
            lineStart: methodStartLine,
            lineEnd: methodEndLine,
            isClassMethod,
            isStaticMethod,
            isProperty,
            isPrivate,
            isAbstract,
            isAsync
          });
        }
      }
    }

    return methods;
  }

  private extractClassAttributes(lines: string[], classStart: number, classEnd: number): PythonAttribute[] {
    const attributes: PythonAttribute[] = [];

    for (let i = classStart + 1; i < classEnd; i++) {
      const line = lines[i].trim();

      if (line && !line.startsWith('def ') && !line.startsWith('class ') && !line.startsWith('#')) {
        const attrMatch = line.match(/^(\w+)(?:\s*:\s*([^=]+))?\s*(?:=\s*(.+))?/);
        if (attrMatch) {
          const attrName = attrMatch[1];
          const annotation = attrMatch[2]?.trim();
          const value = attrMatch[3]?.trim();

          if (!['if', 'for', 'while', 'try', 'with', 'return', 'yield'].includes(attrName)) {
            attributes.push({
              name: attrName,
              annotation,
              value,
              lineNumber: i + 1,
              isPrivate: attrName.startsWith('_'),
              isClassAttribute: true
            });
          }
        }
      }
    }

    return attributes;
  }

  private extractGlobalVariables(content: string): PythonVariable[] {
    const variables: PythonVariable[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.trim() && !line.trim().startsWith('#') && line.length === line.trimStart().length) {
        const varMatch = line.match(/^(\w+)(?:\s*:\s*([^=]+))?\s*=\s*(.+)/);
        if (varMatch && !this.isInsideClassOrFunction(lines, i)) {
          const varName = varMatch[1];
          const annotation = varMatch[2]?.trim();
          const value = varMatch[3]?.trim();

          if (!['if', 'for', 'while', 'try', 'with', 'class', 'def'].includes(varName)) {
            variables.push({
              name: varName,
              annotation,
              value,
              lineNumber: i + 1,
              scope: 'global'
            });
          }
        }
      }
    }

    return variables;
  }

  private extractParameters(paramString: string): PythonParameter[] {
    const parameters: PythonParameter[] = [];

    if (!paramString.trim()) {
      return parameters;
    }

    const params = this.splitParameters(paramString);

    for (const param of params) {
      const trimmed = param.trim();

      if (trimmed.startsWith('**')) {
        const name = trimmed.substring(2);
        parameters.push({
          name,
          isVarArgs: false,
          isKwArgs: true
        });
      } else if (trimmed.startsWith('*')) {
        const name = trimmed.substring(1);
        parameters.push({
          name,
          isVarArgs: true,
          isKwArgs: false
        });
      } else {
        const paramMatch = trimmed.match(/^(\w+)(?:\s*:\s*([^=]+))?(?:\s*=\s*(.+))?$/);
        if (paramMatch) {
          parameters.push({
            name: paramMatch[1],
            annotation: paramMatch[2]?.trim(),
            defaultValue: paramMatch[3]?.trim(),
            isVarArgs: false,
            isKwArgs: false
          });
        }
      }
    }

    return parameters;
  }

  private splitParameters(paramString: string): string[] {
    const params: string[] = [];
    let current = '';
    let parenCount = 0;
    let bracketCount = 0;
    let braceCount = 0;

    for (const char of paramString) {
      if (char === '(') parenCount++;
      else if (char === ')') parenCount--;
      else if (char === '[') bracketCount++;
      else if (char === ']') bracketCount--;
      else if (char === '{') braceCount++;
      else if (char === '}') braceCount--;
      else if (char === ',' && parenCount === 0 && bracketCount === 0 && braceCount === 0) {
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

  private extractDecorators(lines: string[], lineIndex: number): string[] {
    const decorators: string[] = [];

    for (let i = lineIndex - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line.startsWith('@')) {
        const decoratorMatch = line.match(/@([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*)/);
        if (decoratorMatch) {
          decorators.unshift(decoratorMatch[1]);
        }
      } else if (line && !line.startsWith('#')) {
        break;
      }
    }

    return decorators;
  }

  private extractDocstring(lines: string[], startLine: number): string | undefined {
    if (startLine >= lines.length) return undefined;

    const line = lines[startLine].trim();

    if (line.startsWith('"""') || line.startsWith("'''")) {
      const quote = line.startsWith('"""') ? '"""' : "'''";

      if (line.endsWith(quote) && line.length > 6) {
        return line.substring(3, line.length - 3);
      }

      let docstring = line.substring(3);
      for (let i = startLine + 1; i < lines.length; i++) {
        const currentLine = lines[i];
        if (currentLine.trim().endsWith(quote)) {
          docstring += '\n' + currentLine.substring(0, currentLine.lastIndexOf(quote));
          break;
        }
        docstring += '\n' + currentLine;
      }

      return docstring.trim();
    }

    return undefined;
  }

  private findBlockEnd(lines: string[], startIndex: number): number {
    const startIndent = lines[startIndex].length - lines[startIndex].trimStart().length;

    for (let i = startIndex + 1; i < lines.length; i++) {
      const line = lines[i];

      if (line.trim()) {
        const indent = line.length - line.trimStart().length;
        if (indent <= startIndent) {
          return i;
        }
      }
    }

    return lines.length;
  }

  private isInsideClass(lines: string[], lineIndex: number): boolean {
    for (let i = lineIndex - 1; i >= 0; i--) {
      const line = lines[i];
      const indent = line.length - line.trimStart().length;

      if (line.trim().startsWith('class ') && indent === 0) {
        return true;
      }
    }
    return false;
  }

  private isInsideClassOrFunction(lines: string[], lineIndex: number): boolean {
    for (let i = lineIndex - 1; i >= 0; i--) {
      const line = lines[i];
      const indent = line.length - line.trimStart().length;

      if ((line.trim().startsWith('class ') || line.trim().startsWith('def ') || line.trim().startsWith('async def ')) && indent === 0) {
        return true;
      }
    }
    return false;
  }

  private getModuleName(filePath: string): string {
    return filePath.replace(/\.py$/, '').replace(/\//g, '.');
  }

  private isStandardLibrary(module: string): boolean {
    const standardLibModules = [
      'os', 'sys', 'json', 'urllib', 'http', 'datetime', 'time', 'math', 'random',
      'collections', 'itertools', 'functools', 'operator', 're', 'string', 'io',
      'pathlib', 'typing', 'dataclasses', 'abc', 'contextlib', 'pickle', 'csv',
      'xml', 'sqlite3', 'logging', 'unittest', 'asyncio', 'concurrent', 'threading',
      'multiprocessing', 'subprocess', 'socket', 'email', 'base64', 'hashlib',
      'hmac', 'secrets', 'uuid', 'decimal', 'fractions', 'statistics', 'tempfile'
    ];

    return standardLibModules.some(lib => module === lib || module.startsWith(`${lib}.`));
  }

  private buildModuleHierarchy(modules: Map<string, string[]>, nodes: CASNode[], edges: CASEdge[]): void {
    for (const [moduleName, files] of modules.entries()) {
      const moduleId = `module_${this.sanitizeId(moduleName)}`;

      nodes.push(this.createNode(
        moduleId,
        moduleName,
        'module',
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
          `${moduleId}_contains_${fileId}`,
          moduleId,
          fileId,
          'contains'
        ));
      }
    }
  }

  private detectFrameworkPatterns(nodes: CASNode[], _edges: CASEdge[], entryPoints: any[]): void {
    const frameworkDecorators = {
      django: ['django.http', 'django.views', 'django.urls'],
      flask: ['flask.Flask', 'app.route'],
      fastapi: ['fastapi.FastAPI', 'fastapi.APIRouter']
    };

    for (const node of nodes) {
      if (node.type === 'function' && node.metadata?.attributes?.decorators) {
        const decorators = node.metadata.attributes?.decorators as string[];

        for (const [framework, patterns] of Object.entries(frameworkDecorators)) {
          if (patterns.some(pattern => decorators.some(d => d.includes(pattern)))) {
            entryPoints.push({
              id: `entry_${framework}_${node.id}`,
              name: `${framework.charAt(0).toUpperCase() + framework.slice(1)} endpoint: ${node.name}`,
              type: `${framework}_endpoint`,
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

  private buildInheritanceRelationships(nodes: CASNode[], edges: CASEdge[]): void {
    const classNodes = nodes.filter(n => n.type === 'class');

    for (const classNode of classNodes) {
      if (classNode.metadata?.attributes?.baseClasses) {
        const baseClasses = classNode.metadata.attributes.baseClasses as string[];
        for (const baseClassName of baseClasses) {
          const baseClassNode = classNodes.find(n => n.name === baseClassName);

          if (baseClassNode) {
            edges.push(this.createEdge(
              `${classNode.id}_inherits_${baseClassNode.id}`,
              classNode.id,
              baseClassNode.id,
              'inherits'
            ));
          }
        }
      }
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
      'class-analysis',
      'function-detection',
      'module-organization',
      'inheritance-tracking',
      'decorator-parsing',
      'async-pattern-detection',
      'framework-detection'
    ];
  }
}