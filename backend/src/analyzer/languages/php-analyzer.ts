import { BaseAnalyzer, AnalysisContext } from '../core/base-analyzer';
import { CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint } from '../../types/cas.types';
import { AnalyzerError } from '../core/errors';
import * as fs from 'fs-extra';
import { glob } from 'glob';

interface PHPClass {
  name: string;
  namespace: string;
  filePath: string;
  modifiers: string[];
  extendsClass?: string;
  implementsInterfaces: string[];
  properties: PHPProperty[];
  methods: PHPMethod[];
  constants: PHPConstant[];
  traits: string[];
  docComment?: string;
  lineStart: number;
  lineEnd: number;
  isAbstract: boolean;
  isFinal: boolean;
}

interface PHPInterface {
  name: string;
  namespace: string;
  filePath: string;
  extendsInterfaces: string[];
  methods: PHPMethod[];
  constants: PHPConstant[];
  docComment?: string;
  lineStart: number;
  lineEnd: number;
}

interface PHPTrait {
  name: string;
  namespace: string;
  filePath: string;
  properties: PHPProperty[];
  methods: PHPMethod[];
  usedTraits: string[];
  docComment?: string;
  lineStart: number;
  lineEnd: number;
}

interface PHPMethod {
  name: string;
  visibility: string;
  modifiers: string[];
  parameters: PHPParameter[];
  returnType?: string;
  docComment?: string;
  lineStart: number;
  lineEnd: number;
  isAbstract: boolean;
  isFinal: boolean;
  isStatic: boolean;
  isConstructor: boolean;
  isDestructor: boolean;
}

interface PHPProperty {
  name: string;
  visibility: string;
  modifiers: string[];
  type?: string;
  defaultValue?: string;
  docComment?: string;
  lineNumber: number;
  isStatic: boolean;
  isReadonly: boolean;
}

interface PHPParameter {
  name: string;
  type?: string;
  defaultValue?: string;
  isVariadic: boolean;
  isReference: boolean;
  isNullable: boolean;
}

interface PHPFunction {
  name: string;
  namespace: string;
  filePath: string;
  parameters: PHPParameter[];
  returnType?: string;
  docComment?: string;
  lineStart: number;
  lineEnd: number;
}

interface PHPConstant {
  name: string;
  value: string;
  visibility?: string;
  docComment?: string;
  lineNumber: number;
  isClassConstant: boolean;
}

interface PHPVariable {
  name: string;
  scope: 'global' | 'local' | 'static';
  type?: string;
  defaultValue?: string;
  lineNumber: number;
}


interface PHPUse {
  namespace: string;
  alias?: string;
  type: 'class' | 'function' | 'const';
  lineNumber: number;
}

interface PHPEnum {
  name: string;
  namespace: string;
  filePath: string;
  backingType?: string;
  cases: PHPEnumCase[];
  methods: PHPMethod[];
  constants: PHPConstant[];
  implementsInterfaces: string[];
  traits: string[];
  docComment?: string;
  lineStart: number;
  lineEnd: number;
}

interface PHPEnumCase {
  name: string;
  value?: string;
  docComment?: string;
  lineNumber: number;
}

export class PHPAnalyzer extends BaseAnalyzer {
  private laravelFrameworkDetected = false;
  private symfonyFrameworkDetected = false;
  private codeIgniterFrameworkDetected = false;
  private cakePHPFrameworkDetected = false;
  private drupalFrameworkDetected = false;
  private wordPressFrameworkDetected = false;
  private composerProject = false;

  constructor() {
    super(
      'php-analyzer',
      'PHP Language Analyzer',
      '1.0.0',
      'language'
    );
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const phpFiles = await glob(['**/*.php'], {
        cwd: projectPath,
        ignore: ['**/vendor/**', '**/.git/**', '**/node_modules/**']
      });

      const composerFiles = await glob(['composer.json', 'composer.lock'], {
        cwd: projectPath
      });

      return phpFiles.length > 0 || composerFiles.length > 0;
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

      const phpFiles = await glob(['**/*.php'], {
        cwd: context.projectPath,
        ignore: ['**/vendor/**', '**/.git/**', '**/node_modules/**']
      });

      const namespaces = new Map<string, string[]>();

      for (const file of phpFiles) {
        const fullPath = `${context.projectPath}/${file}`;
        await this.analyzePHPFile(fullPath, file, nodes, edges, entryPoints, exitPoints, namespaces, context);
      }

      this.buildNamespaceHierarchy(namespaces, nodes, edges);
      this.detectFrameworkPatterns(nodes, edges, entryPoints);
      this.buildInheritanceRelationships(nodes, edges);

      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        framework_specific: {
          language: 'php',
          laravelFramework: this.laravelFrameworkDetected,
          symfonyFramework: this.symfonyFrameworkDetected,
          codeIgniterFramework: this.codeIgniterFrameworkDetected,
          cakePHPFramework: this.cakePHPFrameworkDetected,
          drupalFramework: this.drupalFrameworkDetected,
          wordPressFramework: this.wordPressFrameworkDetected,
          packageManager: this.composerProject ? 'composer' : 'unknown',
          libraries,
          filesAnalyzed: phpFiles.length,
          namespacesFound: namespaces.size
        }
      });

    } catch (error) {
      throw new AnalyzerError(
        `PHP analysis failed: ${(error as Error).message}`,
        'PHP_ANALYSIS_ERROR'
      );
    }
  }

  private async detectProjectType(projectPath: string): Promise<void> {
    const composerJsonPath = `${projectPath}/composer.json`;

    this.composerProject = await fs.pathExists(composerJsonPath);

    if (this.composerProject) {
      try {
        const composerContent = await fs.readFile(composerJsonPath, 'utf-8');
        this.detectFrameworks(composerContent);
      } catch (error) {
        console.warn('Failed to read composer.json:', error);
      }
    }

    await this.detectFrameworksByFiles(projectPath);
  }

  private detectFrameworks(content: string): void {
    this.laravelFrameworkDetected = this.laravelFrameworkDetected ||
      content.includes('laravel/framework') || content.includes('illuminate/');

    this.symfonyFrameworkDetected = this.symfonyFrameworkDetected ||
      content.includes('symfony/symfony') || content.includes('symfony/framework');

    this.codeIgniterFrameworkDetected = this.codeIgniterFrameworkDetected ||
      content.includes('codeigniter/framework') || content.includes('codeigniter4/framework');

    this.cakePHPFrameworkDetected = this.cakePHPFrameworkDetected ||
      content.includes('cakephp/cakephp');

    this.drupalFrameworkDetected = this.drupalFrameworkDetected ||
      content.includes('drupal/core') || content.includes('drupal/drupal');

    this.wordPressFrameworkDetected = this.wordPressFrameworkDetected ||
      content.includes('wordpress/wordpress') || content.includes('johnpbloch/wordpress');
  }

  private async detectFrameworksByFiles(projectPath: string): Promise<void> {
    const artisanPath = `${projectPath}/artisan`;
    const appKernelPath = `${projectPath}/app/Console/Kernel.php`;
    const indexPhpPath = `${projectPath}/system/core/CodeIgniter.php`;
    const cakePhpPath = `${projectPath}/config/bootstrap.php`;

    if (await fs.pathExists(artisanPath) || await fs.pathExists(appKernelPath)) {
      this.laravelFrameworkDetected = true;
    }

    if (await fs.pathExists(indexPhpPath)) {
      this.codeIgniterFrameworkDetected = true;
    }

    if (await fs.pathExists(cakePhpPath)) {
      const content = await fs.readFile(cakePhpPath, 'utf-8').catch(() => '');
      if (content.includes('CakePHP')) {
        this.cakePHPFrameworkDetected = true;
      }
    }

    const wordPressConfigPath = `${projectPath}/wp-config.php`;
    if (await fs.pathExists(wordPressConfigPath)) {
      this.wordPressFrameworkDetected = true;
    }
  }

  private async extractDependencies(projectPath: string, libraries: any[]): Promise<void> {
    const composerJsonPath = `${projectPath}/composer.json`;
    const composerLockPath = `${projectPath}/composer.lock`;

    if (await fs.pathExists(composerJsonPath)) {
      await this.extractComposerJsonDependencies(composerJsonPath, libraries);
    }

    if (await fs.pathExists(composerLockPath)) {
      await this.extractComposerLockDependencies(composerLockPath, libraries);
    }
  }

  private async extractComposerJsonDependencies(composerJsonPath: string, libraries: any[]): Promise<void> {
    try {
      const composerContent = await fs.readFile(composerJsonPath, 'utf-8');
      const composer = JSON.parse(composerContent);

      if (composer.require) {
        for (const [name, version] of Object.entries(composer.require)) {
          libraries.push({
            name,
            version: version as string,
            type: 'composer_package',
            source: 'composer.json',
            metadata: {
              isProduction: true,
              isDevelopment: false
            }
          });
        }
      }

      if (composer['require-dev']) {
        for (const [name, version] of Object.entries(composer['require-dev'])) {
          libraries.push({
            name,
            version: version as string,
            type: 'composer_package',
            source: 'composer.json',
            metadata: {
              isProduction: false,
              isDevelopment: true
            }
          });
        }
      }
    } catch (error) {
      console.warn('Failed to parse composer.json:', error);
    }
  }

  private async extractComposerLockDependencies(composerLockPath: string, libraries: any[]): Promise<void> {
    try {
      const composerLockContent = await fs.readFile(composerLockPath, 'utf-8');
      const composerLock = JSON.parse(composerLockContent);

      if (composerLock.packages) {
        for (const pkg of composerLock.packages) {
          const existingLib = libraries.find(lib => lib.name === pkg.name);
          if (existingLib) {
            existingLib.metadata.exactVersion = pkg.version;
            existingLib.metadata.source = pkg.source;
            existingLib.metadata.dist = pkg.dist;
          }
        }
      }

      if (composerLock['packages-dev']) {
        for (const pkg of composerLock['packages-dev']) {
          const existingLib = libraries.find(lib => lib.name === pkg.name);
          if (existingLib) {
            existingLib.metadata.exactVersion = pkg.version;
            existingLib.metadata.source = pkg.source;
            existingLib.metadata.dist = pkg.dist;
          }
        }
      }
    } catch (error) {
      console.warn('Failed to parse composer.lock:', error);
    }
  }

  private async analyzePHPFile(
    fullPath: string,
    relativePath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: any[],
    exitPoints: any[],
    namespaces: Map<string, string[]>,
    _context: AnalysisContext
  ): Promise<void> {
    try {
      const content = await fs.readFile(fullPath, 'utf-8');
      const lines = content.split('\n');

      const namespace = this.extractNamespace(content);
      const uses = this.extractUses(content);
      const classes = this.extractClasses(content, relativePath);
      const interfaces = this.extractInterfaces(content, relativePath);
      const traits = this.extractTraits(content, relativePath);
      const enums = this.extractEnums(content, relativePath);
      const functions = this.extractFunctions(content, relativePath);
      const globalVars = this.extractGlobalVariables(content);
      const constants = this.extractGlobalConstants(content);

      if (namespace) {
        if (!namespaces.has(namespace)) {
          namespaces.set(namespace, []);
        }
        namespaces.get(namespace)!.push(relativePath);
      }

      const fileId = `file_${this.sanitizeId(relativePath)}`;
      nodes.push(this.createNode(
        fileId,
        relativePath.split('/').pop() || 'unknown.php',
        'file',
        1,
        fullPath,
        1,
        lines.length,
        {
          namespace: namespace || 'global',
          uses: uses.map(u => u.namespace),
          classCount: classes.length,
          interfaceCount: interfaces.length,
          traitCount: traits.length,
          enumCount: enums.length,
          functionCount: functions.length,
          globalVarCount: globalVars.length,
          constantCount: constants.length
        }
      ));

      for (const use of uses) {
        const useId = `use_${fileId}_${this.sanitizeId(use.namespace)}`;
        nodes.push(this.createNode(
          useId,
          use.alias || use.namespace,
          'use',
          2,
          fullPath,
          use.lineNumber,
          use.lineNumber,
          {
            namespace: use.namespace,
            alias: use.alias,
            type: use.type
          }
        ));

        edges.push(this.createEdge(
          `${fileId}_uses_${useId}`,
          fileId,
          useId,
          'uses'
        ));

        if (!this.isBuiltinNamespace(use.namespace)) {
          exitPoints.push({
            id: `exit_${useId}`,
            name: `External namespace: ${use.namespace}`,
            type: 'external_namespace',
            source_node: useId,
            metadata: { namespace: use.namespace }
          });
        }
      }

      for (const cls of classes) {
        await this.processPHPClass(cls, fileId, fullPath, nodes, edges, entryPoints);
      }

      for (const intf of interfaces) {
        await this.processPHPInterface(intf, fileId, fullPath, nodes, edges, entryPoints);
      }

      for (const trait of traits) {
        await this.processPHPTrait(trait, fileId, fullPath, nodes, edges, entryPoints);
      }

      for (const enm of enums) {
        await this.processPHPEnum(enm, fileId, fullPath, nodes, edges, entryPoints);
      }

      for (const func of functions) {
        await this.processPHPFunction(func, fileId, fullPath, nodes, edges, entryPoints);
      }

      for (const variable of globalVars) {
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
            defaultValue: variable.defaultValue,
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
            value: constant.value,
            docComment: constant.docComment,
            isClassConstant: constant.isClassConstant
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
      console.warn(`Failed to analyze PHP file ${relativePath}:`, error);
    }
  }

  private async processPHPClass(
    cls: PHPClass,
    fileId: string,
    fullPath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: any[]
  ): Promise<void> {
    const classId = `class_${this.sanitizeId(cls.namespace)}_${this.sanitizeId(cls.name)}`;

    nodes.push(this.createNode(
      classId,
      cls.name,
      'class',
      2,
      fullPath,
      cls.lineStart,
      cls.lineEnd,
      {
        namespace: cls.namespace,
        modifiers: cls.modifiers,
        extendsClass: cls.extendsClass,
        implementsInterfaces: cls.implementsInterfaces,
        traits: cls.traits,
        docComment: cls.docComment,
        propertyCount: cls.properties.length,
        methodCount: cls.methods.length,
        constantCount: cls.constants.length,
        isAbstract: cls.isAbstract,
        isFinal: cls.isFinal
      }
    ));

    edges.push(this.createEdge(
      `${fileId}_contains_${classId}`,
      fileId,
      classId,
      'contains'
    ));

    for (const property of cls.properties) {
      const propertyId = `property_${classId}_${this.sanitizeId(property.name)}`;
      nodes.push(this.createNode(
        propertyId,
        property.name,
        'property',
        4,
        fullPath,
        property.lineNumber,
        property.lineNumber,
        {
          visibility: property.visibility,
          modifiers: property.modifiers,
          type: property.type,
          defaultValue: property.defaultValue,
          docComment: property.docComment,
          isStatic: property.isStatic,
          isReadonly: property.isReadonly
        }
      ));

      edges.push(this.createEdge(
        `${classId}_has_property_${propertyId}`,
        classId,
        propertyId,
        'has_property'
      ));
    }

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
          visibility: method.visibility,
          modifiers: method.modifiers,
          parameters: method.parameters,
          returnType: method.returnType,
          docComment: method.docComment,
          isAbstract: method.isAbstract,
          isFinal: method.isFinal,
          isStatic: method.isStatic,
          isConstructor: method.isConstructor,
          isDestructor: method.isDestructor
        }
      ));

      edges.push(this.createEdge(
        `${classId}_has_method_${methodId}`,
        classId,
        methodId,
        'has_method'
      ));

      if (method.visibility === 'public' && !method.isConstructor && !method.isDestructor) {
        entryPoints.push({
          id: `entry_${methodId}`,
          name: `Public method: ${cls.name}.${method.name}`,
          type: 'public_method',
          source_node: methodId,
          metadata: {
            className: cls.name,
            methodName: method.name,
            returnType: method.returnType,
            parameters: method.parameters.map(p => p.type)
          }
        });
      }
    }

    for (const constant of cls.constants) {
      const constantId = `constant_${classId}_${this.sanitizeId(constant.name)}`;
      nodes.push(this.createNode(
        constantId,
        constant.name,
        'class_constant',
        4,
        fullPath,
        constant.lineNumber,
        constant.lineNumber,
        {
          value: constant.value,
          visibility: constant.visibility,
          docComment: constant.docComment
        }
      ));

      edges.push(this.createEdge(
        `${classId}_has_constant_${constantId}`,
        classId,
        constantId,
        'has_constant'
      ));
    }

    entryPoints.push({
      id: `entry_${classId}`,
      name: `Class: ${cls.name}`,
      type: 'class',
      source_node: classId,
      metadata: {
        namespace: cls.namespace,
        className: cls.name,
        modifiers: cls.modifiers
      }
    });
  }

  private async processPHPInterface(
    intf: PHPInterface,
    fileId: string,
    fullPath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: any[]
  ): Promise<void> {
    const interfaceId = `interface_${this.sanitizeId(intf.namespace)}_${this.sanitizeId(intf.name)}`;

    nodes.push(this.createNode(
      interfaceId,
      intf.name,
      'interface',
      2,
      fullPath,
      intf.lineStart,
      intf.lineEnd,
      {
        namespace: intf.namespace,
        extendsInterfaces: intf.extendsInterfaces,
        docComment: intf.docComment,
        methodCount: intf.methods.length,
        constantCount: intf.constants.length
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
          visibility: method.visibility,
          parameters: method.parameters,
          returnType: method.returnType,
          docComment: method.docComment
        }
      ));

      edges.push(this.createEdge(
        `${interfaceId}_declares_${methodId}`,
        interfaceId,
        methodId,
        'declares'
      ));
    }

    for (const constant of intf.constants) {
      const constantId = `constant_${interfaceId}_${this.sanitizeId(constant.name)}`;
      nodes.push(this.createNode(
        constantId,
        constant.name,
        'interface_constant',
        4,
        fullPath,
        constant.lineNumber,
        constant.lineNumber,
        {
          value: constant.value,
          docComment: constant.docComment
        }
      ));

      edges.push(this.createEdge(
        `${interfaceId}_has_constant_${constantId}`,
        interfaceId,
        constantId,
        'has_constant'
      ));
    }

    entryPoints.push({
      id: `entry_${interfaceId}`,
      name: `Interface: ${intf.name}`,
      type: 'interface',
      source_node: interfaceId,
      metadata: {
        namespace: intf.namespace,
        interfaceName: intf.name
      }
    });
  }

  private async processPHPTrait(
    trait: PHPTrait,
    fileId: string,
    fullPath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: any[]
  ): Promise<void> {
    const traitId = `trait_${this.sanitizeId(trait.namespace)}_${this.sanitizeId(trait.name)}`;

    nodes.push(this.createNode(
      traitId,
      trait.name,
      'trait',
      2,
      fullPath,
      trait.lineStart,
      trait.lineEnd,
      {
        namespace: trait.namespace,
        usedTraits: trait.usedTraits,
        docComment: trait.docComment,
        propertyCount: trait.properties.length,
        methodCount: trait.methods.length
      }
    ));

    edges.push(this.createEdge(
      `${fileId}_contains_${traitId}`,
      fileId,
      traitId,
      'contains'
    ));

    for (const property of trait.properties) {
      const propertyId = `property_${traitId}_${this.sanitizeId(property.name)}`;
      nodes.push(this.createNode(
        propertyId,
        property.name,
        'property',
        4,
        fullPath,
        property.lineNumber,
        property.lineNumber,
        {
          visibility: property.visibility,
          modifiers: property.modifiers,
          type: property.type,
          defaultValue: property.defaultValue,
          docComment: property.docComment,
          isStatic: property.isStatic,
          isReadonly: property.isReadonly
        }
      ));

      edges.push(this.createEdge(
        `${traitId}_has_property_${propertyId}`,
        traitId,
        propertyId,
        'has_property'
      ));
    }

    for (const method of trait.methods) {
      const methodId = `method_${traitId}_${this.sanitizeId(method.name)}_${method.lineStart}`;
      nodes.push(this.createNode(
        methodId,
        method.name,
        'trait_method',
        4,
        fullPath,
        method.lineStart,
        method.lineEnd,
        {
          visibility: method.visibility,
          modifiers: method.modifiers,
          parameters: method.parameters,
          returnType: method.returnType,
          docComment: method.docComment,
          isAbstract: method.isAbstract,
          isFinal: method.isFinal,
          isStatic: method.isStatic
        }
      ));

      edges.push(this.createEdge(
        `${traitId}_has_method_${methodId}`,
        traitId,
        methodId,
        'has_method'
      ));
    }

    entryPoints.push({
      id: `entry_${traitId}`,
      name: `Trait: ${trait.name}`,
      type: 'trait',
      source_node: traitId,
      metadata: {
        namespace: trait.namespace,
        traitName: trait.name
      }
    });
  }

  private async processPHPEnum(
    enm: PHPEnum,
    fileId: string,
    fullPath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: any[]
  ): Promise<void> {
    const enumId = `enum_${this.sanitizeId(enm.namespace)}_${this.sanitizeId(enm.name)}`;

    nodes.push(this.createNode(
      enumId,
      enm.name,
      'enum',
      2,
      fullPath,
      enm.lineStart,
      enm.lineEnd,
      {
        namespace: enm.namespace,
        backingType: enm.backingType,
        implementsInterfaces: enm.implementsInterfaces,
        traits: enm.traits,
        docComment: enm.docComment,
        caseCount: enm.cases.length,
        methodCount: enm.methods.length,
        constantCount: enm.constants.length
      }
    ));

    edges.push(this.createEdge(
      `${fileId}_contains_${enumId}`,
      fileId,
      enumId,
      'contains'
    ));

    for (const enumCase of enm.cases) {
      const caseId = `case_${enumId}_${this.sanitizeId(enumCase.name)}`;
      nodes.push(this.createNode(
        caseId,
        enumCase.name,
        'enum_case',
        4,
        fullPath,
        enumCase.lineNumber,
        enumCase.lineNumber,
        {
          value: enumCase.value,
          docComment: enumCase.docComment
        }
      ));

      edges.push(this.createEdge(
        `${enumId}_has_case_${caseId}`,
        enumId,
        caseId,
        'has_case'
      ));
    }

    for (const method of enm.methods) {
      const methodId = `method_${enumId}_${this.sanitizeId(method.name)}_${method.lineStart}`;
      nodes.push(this.createNode(
        methodId,
        method.name,
        'method',
        4,
        fullPath,
        method.lineStart,
        method.lineEnd,
        {
          visibility: method.visibility,
          modifiers: method.modifiers,
          parameters: method.parameters,
          returnType: method.returnType,
          docComment: method.docComment,
          isStatic: method.isStatic
        }
      ));

      edges.push(this.createEdge(
        `${enumId}_has_method_${methodId}`,
        enumId,
        methodId,
        'has_method'
      ));
    }

    entryPoints.push({
      id: `entry_${enumId}`,
      name: `Enum: ${enm.name}`,
      type: 'enum',
      source_node: enumId,
      metadata: {
        namespace: enm.namespace,
        enumName: enm.name,
        backingType: enm.backingType
      }
    });
  }

  private async processPHPFunction(
    func: PHPFunction,
    fileId: string,
    fullPath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: any[]
  ): Promise<void> {
    const functionId = `function_${this.sanitizeId(func.namespace)}_${this.sanitizeId(func.name)}_${func.lineStart}`;

    nodes.push(this.createNode(
      functionId,
      func.name,
      'function',
      3,
      fullPath,
      func.lineStart,
      func.lineEnd,
      {
        namespace: func.namespace,
        parameters: func.parameters,
        returnType: func.returnType,
        docComment: func.docComment
      }
    ));

    edges.push(this.createEdge(
      `${fileId}_contains_${functionId}`,
      fileId,
      functionId,
      'contains'
    ));

    entryPoints.push({
      id: `entry_${functionId}`,
      name: `Function: ${func.name}`,
      type: 'function',
      source_node: functionId,
      metadata: {
        namespace: func.namespace,
        functionName: func.name,
        returnType: func.returnType,
        parameters: func.parameters.map(p => p.type)
      }
    });
  }

  private extractNamespace(content: string): string | null {
    const namespaceMatch = content.match(/namespace\s+([a-zA-Z0-9_\\]+)\s*[;{]/);
    return namespaceMatch ? namespaceMatch[1] : null;
  }

  private extractUses(content: string): PHPUse[] {
    const uses: PHPUse[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      const useMatch = line.match(/use\s+(function\s+|const\s+)?([a-zA-Z0-9_\\]+)(?:\s+as\s+([a-zA-Z0-9_]+))?\s*;/);
      if (useMatch) {
        const typePrefix = useMatch[1]?.trim();
        const namespace = useMatch[2];
        const alias = useMatch[3];

        let type: 'class' | 'function' | 'const' = 'class';
        if (typePrefix === 'function') type = 'function';
        else if (typePrefix === 'const') type = 'const';

        uses.push({
          namespace,
          alias,
          type,
          lineNumber: i + 1
        });
      }
    }

    return uses;
  }

  private extractClasses(content: string, filePath: string): PHPClass[] {
    const classes: PHPClass[] = [];
    const lines = content.split('\n');
    const namespace = this.extractNamespace(content) || '';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.includes('class ') && !line.startsWith('//') && !line.startsWith('*')) {
        const classMatch = line.match(/(abstract\s+|final\s+)?class\s+([a-zA-Z0-9_]+)(?:\s+extends\s+([a-zA-Z0-9_\\]+))?(?:\s+implements\s+([a-zA-Z0-9_\\,\s]+))?/);
        if (classMatch) {
          const modifierStr = classMatch[1] || '';
          const className = classMatch[2];
          const extendsClass = classMatch[3];
          const implementsStr = classMatch[4];

          const modifiers = modifierStr.trim().split(/\s+/).filter(m => m);
          const implementsInterfaces = implementsStr ? implementsStr.split(',').map(i => i.trim()) : [];

          const docComment = this.extractDocComment(lines, i);
          const classStartLine = i + 1;
          const classEndLine = this.findBlockEnd(lines, i);

          const properties = this.extractProperties(lines, i, classEndLine);
          const methods = this.extractMethods(lines, i, classEndLine);
          const constants = this.extractClassConstants(lines, i, classEndLine);
          const traits = this.extractUsedTraits(lines, i, classEndLine);

          classes.push({
            name: className,
            namespace,
            filePath,
            modifiers,
            extendsClass,
            implementsInterfaces,
            properties,
            methods,
            constants,
            traits,
            docComment,
            lineStart: classStartLine,
            lineEnd: classEndLine,
            isAbstract: modifiers.includes('abstract'),
            isFinal: modifiers.includes('final')
          });
        }
      }
    }

    return classes;
  }

  private extractInterfaces(content: string, filePath: string): PHPInterface[] {
    const interfaces: PHPInterface[] = [];
    const lines = content.split('\n');
    const namespace = this.extractNamespace(content) || '';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.includes('interface ') && !line.startsWith('//') && !line.startsWith('*')) {
        const interfaceMatch = line.match(/interface\s+([a-zA-Z0-9_]+)(?:\s+extends\s+([a-zA-Z0-9_\\,\s]+))?/);
        if (interfaceMatch) {
          const interfaceName = interfaceMatch[1];
          const extendsStr = interfaceMatch[2];

          const extendsInterfaces = extendsStr ? extendsStr.split(',').map(i => i.trim()) : [];

          const docComment = this.extractDocComment(lines, i);
          const interfaceStartLine = i + 1;
          const interfaceEndLine = this.findBlockEnd(lines, i);

          const methods = this.extractMethods(lines, i, interfaceEndLine);
          const constants = this.extractClassConstants(lines, i, interfaceEndLine);

          interfaces.push({
            name: interfaceName,
            namespace,
            filePath,
            extendsInterfaces,
            methods,
            constants,
            docComment,
            lineStart: interfaceStartLine,
            lineEnd: interfaceEndLine
          });
        }
      }
    }

    return interfaces;
  }

  private extractTraits(content: string, filePath: string): PHPTrait[] {
    const traits: PHPTrait[] = [];
    const lines = content.split('\n');
    const namespace = this.extractNamespace(content) || '';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.includes('trait ') && !line.startsWith('//') && !line.startsWith('*')) {
        const traitMatch = line.match(/trait\s+([a-zA-Z0-9_]+)/);
        if (traitMatch) {
          const traitName = traitMatch[1];

          const docComment = this.extractDocComment(lines, i);
          const traitStartLine = i + 1;
          const traitEndLine = this.findBlockEnd(lines, i);

          const properties = this.extractProperties(lines, i, traitEndLine);
          const methods = this.extractMethods(lines, i, traitEndLine);
          const usedTraits = this.extractUsedTraits(lines, i, traitEndLine);

          traits.push({
            name: traitName,
            namespace,
            filePath,
            properties,
            methods,
            usedTraits,
            docComment,
            lineStart: traitStartLine,
            lineEnd: traitEndLine
          });
        }
      }
    }

    return traits;
  }

  private extractEnums(content: string, filePath: string): PHPEnum[] {
    const enums: PHPEnum[] = [];
    const lines = content.split('\n');
    const namespace = this.extractNamespace(content) || '';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.includes('enum ') && !line.startsWith('//') && !line.startsWith('*')) {
        const enumMatch = line.match(/enum\s+([a-zA-Z0-9_]+)(?:\s*:\s*([a-zA-Z0-9_]+))?(?:\s+implements\s+([a-zA-Z0-9_\\,\s]+))?/);
        if (enumMatch) {
          const enumName = enumMatch[1];
          const backingType = enumMatch[2];
          const implementsStr = enumMatch[3];

          const implementsInterfaces = implementsStr ? implementsStr.split(',').map(i => i.trim()) : [];

          const docComment = this.extractDocComment(lines, i);
          const enumStartLine = i + 1;
          const enumEndLine = this.findBlockEnd(lines, i);

          const cases = this.extractEnumCases(lines, i, enumEndLine);
          const methods = this.extractMethods(lines, i, enumEndLine);
          const constants = this.extractClassConstants(lines, i, enumEndLine);
          const traits = this.extractUsedTraits(lines, i, enumEndLine);

          enums.push({
            name: enumName,
            namespace,
            filePath,
            backingType,
            cases,
            methods,
            constants,
            implementsInterfaces,
            traits,
            docComment,
            lineStart: enumStartLine,
            lineEnd: enumEndLine
          });
        }
      }
    }

    return enums;
  }

  private extractFunctions(content: string, filePath: string): PHPFunction[] {
    const functions: PHPFunction[] = [];
    const lines = content.split('\n');
    const namespace = this.extractNamespace(content) || '';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.includes('function ') && !line.startsWith('//') && !line.startsWith('*') && !this.isInsideClass(lines, i)) {
        const functionMatch = line.match(/function\s+([a-zA-Z0-9_]+)\s*\(([^)]*)\)(?:\s*:\s*([^{]+))?/);
        if (functionMatch) {
          const functionName = functionMatch[1];
          const paramsStr = functionMatch[2];
          const returnType = functionMatch[3]?.trim();

          const docComment = this.extractDocComment(lines, i);
          const functionStartLine = i + 1;
          const functionEndLine = this.findBlockEnd(lines, i);

          const parameters = this.extractFunctionParameters(paramsStr);

          functions.push({
            name: functionName,
            namespace,
            filePath,
            parameters,
            returnType,
            docComment,
            lineStart: functionStartLine,
            lineEnd: functionEndLine
          });
        }
      }
    }

    return functions;
  }

  private extractProperties(lines: string[], classStart: number, classEnd: number): PHPProperty[] {
    const properties: PHPProperty[] = [];

    for (let i = classStart + 1; i < classEnd; i++) {
      const line = lines[i].trim();

      if (this.isPropertyDeclaration(line)) {
        const propertyMatch = line.match(/(public|private|protected)(?:\s+(static|readonly))?\s+(?:([a-zA-Z0-9_\\|?]+)\s+)?\$([a-zA-Z0-9_]+)(?:\s*=\s*([^;]+))?/);
        if (propertyMatch) {
          const visibility = propertyMatch[1];
          const modifier = propertyMatch[2];
          const type = propertyMatch[3];
          const propertyName = propertyMatch[4];
          const defaultValue = propertyMatch[5]?.trim();

          const modifiers = [visibility];
          if (modifier) modifiers.push(modifier);

          const docComment = this.extractDocComment(lines, i);

          properties.push({
            name: propertyName,
            visibility,
            modifiers,
            type,
            defaultValue,
            docComment,
            lineNumber: i + 1,
            isStatic: modifier === 'static',
            isReadonly: modifier === 'readonly'
          });
        }
      }
    }

    return properties;
  }

  private extractMethods(lines: string[], classStart: number, classEnd: number): PHPMethod[] {
    const methods: PHPMethod[] = [];

    for (let i = classStart + 1; i < classEnd; i++) {
      const line = lines[i].trim();

      if (this.isMethodDeclaration(line)) {
        const methodMatch = line.match(/(public|private|protected)(?:\s+(static|abstract|final))?\s+function\s+([a-zA-Z0-9_]+)\s*\(([^)]*)\)(?:\s*:\s*([^{]+))?/);
        if (methodMatch) {
          const visibility = methodMatch[1];
          const modifier = methodMatch[2];
          const methodName = methodMatch[3];
          const paramsStr = methodMatch[4];
          const returnType = methodMatch[5]?.trim();

          const modifiers = [visibility];
          if (modifier) modifiers.push(modifier);

          const docComment = this.extractDocComment(lines, i);
          const methodEndLine = this.findMethodEnd(lines, i);

          const parameters = this.extractFunctionParameters(paramsStr);

          methods.push({
            name: methodName,
            visibility,
            modifiers,
            parameters,
            returnType,
            docComment,
            lineStart: i + 1,
            lineEnd: methodEndLine,
            isAbstract: modifier === 'abstract',
            isFinal: modifier === 'final',
            isStatic: modifier === 'static',
            isConstructor: methodName === '__construct',
            isDestructor: methodName === '__destruct'
          });
        }
      }
    }

    return methods;
  }

  private extractClassConstants(lines: string[], classStart: number, classEnd: number): PHPConstant[] {
    const constants: PHPConstant[] = [];

    for (let i = classStart + 1; i < classEnd; i++) {
      const line = lines[i].trim();

      if (this.isConstantDeclaration(line)) {
        const constantMatch = line.match(/(public|private|protected)?\s*const\s+([a-zA-Z0-9_]+)\s*=\s*([^;]+);/);
        if (constantMatch) {
          const visibility = constantMatch[1] || 'public';
          const constantName = constantMatch[2];
          const value = constantMatch[3].trim();

          const docComment = this.extractDocComment(lines, i);

          constants.push({
            name: constantName,
            value,
            visibility,
            docComment,
            lineNumber: i + 1,
            isClassConstant: true
          });
        }
      }
    }

    return constants;
  }

  private extractEnumCases(lines: string[], enumStart: number, enumEnd: number): PHPEnumCase[] {
    const cases: PHPEnumCase[] = [];

    for (let i = enumStart + 1; i < enumEnd; i++) {
      const line = lines[i].trim();

      if (line.startsWith('case ')) {
        const caseMatch = line.match(/case\s+([a-zA-Z0-9_]+)(?:\s*=\s*([^;]+))?;/);
        if (caseMatch) {
          const caseName = caseMatch[1];
          const value = caseMatch[2]?.trim();

          const docComment = this.extractDocComment(lines, i);

          cases.push({
            name: caseName,
            value,
            docComment,
            lineNumber: i + 1
          });
        }
      }
    }

    return cases;
  }

  private extractUsedTraits(lines: string[], classStart: number, classEnd: number): string[] {
    const traits: string[] = [];

    for (let i = classStart + 1; i < classEnd; i++) {
      const line = lines[i].trim();

      if (line.startsWith('use ') && !line.includes('function') && !line.includes('const')) {
        const traitMatch = line.match(/use\s+([a-zA-Z0-9_\\,\s]+);/);
        if (traitMatch) {
          const traitNames = traitMatch[1].split(',').map(t => t.trim());
          traits.push(...traitNames);
        }
      }
    }

    return traits;
  }

  private extractGlobalVariables(content: string): PHPVariable[] {
    const variables: PHPVariable[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (this.isGlobalVariableDeclaration(line)) {
        const varMatch = line.match(/\$([a-zA-Z0-9_]+)(?:\s*=\s*([^;]+))?;/);
        if (varMatch) {
          const varName = varMatch[1];
          const defaultValue = varMatch[2]?.trim();

          variables.push({
            name: varName,
            scope: 'global',
            defaultValue,
            lineNumber: i + 1
          });
        }
      }
    }

    return variables;
  }

  private extractGlobalConstants(content: string): PHPConstant[] {
    const constants: PHPConstant[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.startsWith('define(') || line.startsWith('const ')) {
        let constantMatch: RegExpMatchArray | null = null;

        if (line.startsWith('define(')) {
          constantMatch = line.match(/define\s*\(\s*['"']([^'"']+)['"']\s*,\s*([^)]+)\)/);
          if (constantMatch) {
            constants.push({
              name: constantMatch[1],
              value: constantMatch[2].trim(),
              lineNumber: i + 1,
              isClassConstant: false
            });
          }
        } else {
          constantMatch = line.match(/const\s+([a-zA-Z0-9_]+)\s*=\s*([^;]+);/);
          if (constantMatch) {
            constants.push({
              name: constantMatch[1],
              value: constantMatch[2].trim(),
              lineNumber: i + 1,
              isClassConstant: false
            });
          }
        }
      }
    }

    return constants;
  }

  private extractFunctionParameters(paramsStr: string): PHPParameter[] {
    const parameters: PHPParameter[] = [];

    if (!paramsStr.trim()) {
      return parameters;
    }

    const params = this.splitParameters(paramsStr);

    for (const param of params) {
      const trimmed = param.trim();

      const paramMatch = trimmed.match(/^(?:([a-zA-Z0-9_\\|?]+)\s+)?(&)?(\.\.\.)?\$([a-zA-Z0-9_]+)(?:\s*=\s*(.+))?$/);
      if (paramMatch) {
        const type = paramMatch[1];
        const isReference = !!paramMatch[2];
        const isVariadic = !!paramMatch[3];
        const paramName = paramMatch[4];
        const defaultValue = paramMatch[5]?.trim();

        parameters.push({
          name: paramName,
          type,
          defaultValue,
          isVariadic,
          isReference,
          isNullable: type?.includes('?') || false
        });
      }
    }

    return parameters;
  }

  private extractDocComment(lines: string[], lineIndex: number): string | undefined {
    let docComment = '';
    let foundDocComment = false;

    for (let i = lineIndex - 1; i >= 0; i--) {
      const line = lines[i].trim();

      if (line === '*/') {
        foundDocComment = true;
        continue;
      }

      if (foundDocComment) {
        if (line.startsWith('/**')) {
          docComment = lines.slice(i, lineIndex).join('\n').trim();
          break;
        }
        if (!line.startsWith('*')) {
          break;
        }
      } else if (line && !line.startsWith('//')) {
        break;
      }
    }

    return foundDocComment ? docComment : undefined;
  }

  private splitParameters(paramsStr: string): string[] {
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

  private isPropertyDeclaration(line: string): boolean {
    return line.includes('$') &&
           (line.includes('public') || line.includes('private') || line.includes('protected')) &&
           !line.includes('function') &&
           !line.includes('return') &&
           !line.includes('=');
  }

  private isMethodDeclaration(line: string): boolean {
    return line.includes('function ') &&
           (line.includes('public') || line.includes('private') || line.includes('protected')) &&
           line.includes('(') &&
           !line.startsWith('//');
  }

  private isConstantDeclaration(line: string): boolean {
    return line.includes('const ') &&
           !line.startsWith('//') &&
           line.includes('=');
  }

  private isGlobalVariableDeclaration(line: string): boolean {
    return line.startsWith('$') &&
           !line.includes('function') &&
           !line.includes('class') &&
           !line.includes('interface') &&
           !line.includes('trait');
  }

  private isInsideClass(lines: string[], lineIndex: number): boolean {
    let braceCount = 0;

    for (let i = lineIndex - 1; i >= 0; i--) {
      const line = lines[i];

      for (const char of line) {
        if (char === '}') {
          braceCount++;
        } else if (char === '{') {
          braceCount--;
          if (braceCount < 0) {
            const lineStr = lines[i].trim();
            return lineStr.includes('class ') || lineStr.includes('interface ') || lineStr.includes('trait ');
          }
        }
      }
    }

    return false;
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

  private findMethodEnd(lines: string[], startIndex: number): number {
    const line = lines[startIndex];

    if (line.includes(';')) {
      return startIndex + 1;
    }

    return this.findBlockEnd(lines, startIndex);
  }

  private buildNamespaceHierarchy(namespaces: Map<string, string[]>, nodes: CASNode[], edges: CASEdge[]): void {
    for (const [namespaceName, files] of namespaces.entries()) {
      const namespaceId = `namespace_${this.sanitizeId(namespaceName)}`;

      nodes.push(this.createNode(
        namespaceId,
        namespaceName,
        'namespace',
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
          `${namespaceId}_contains_${fileId}`,
          namespaceId,
          fileId,
          'contains'
        ));
      }
    }
  }

  private detectFrameworkPatterns(nodes: CASNode[], _edges: CASEdge[], entryPoints: any[]): void {
    const frameworkPatterns = {
      laravel: ['Controller', 'Model', 'Illuminate\\', 'Route::', 'Artisan'],
      symfony: ['Symfony\\', 'Controller', 'Bundle', 'DependencyInjection'],
      codeigniter: ['CI_Controller', 'CI_Model', 'CodeIgniter\\'],
      cakephp: ['CakeObject', 'AppController', 'CakePHP\\'],
      drupal: ['Drupal\\', 'DrupalKernel', 'ModuleHandlerInterface'],
      wordpress: ['wp_', 'WP_', 'add_action', 'add_filter', 'get_option']
    };

    for (const node of nodes) {
      if (node.type === 'class' || node.type === 'function') {
        const nodeName = node.name;
        const namespace = node.metadata?.attributes?.namespace as string;

        for (const [framework, patterns] of Object.entries(frameworkPatterns)) {
          if (patterns.some(pattern =>
            nodeName.includes(pattern) ||
            namespace?.includes(pattern) ||
            (node.metadata?.attributes?.extendsClass as string)?.includes(pattern) ||
            (node.metadata?.attributes?.implementsInterfaces as string[])?.some(i => i.includes(pattern))
          )) {
            entryPoints.push({
              id: `entry_${framework}_${node.id}`,
              name: `${framework.charAt(0).toUpperCase() + framework.slice(1)} component: ${node.name}`,
              type: `${framework}_component`,
              source_node: node.id,
              metadata: {
                framework,
                componentName: node.name
              }
            });
          }
        }
      }
    }
  }

  private buildInheritanceRelationships(nodes: CASNode[], edges: CASEdge[]): void {
    const classNodes = nodes.filter(n => n.type === 'class');
    const interfaceNodes = nodes.filter(n => n.type === 'interface');

    for (const classNode of classNodes) {
      if (classNode.metadata?.attributes?.extendsClass) {
        const parentClassName = classNode.metadata.attributes?.extendsClass as string;
        const parentClassNode = classNodes.find(n => n.name === parentClassName);

        if (parentClassNode) {
          edges.push(this.createEdge(
            `${classNode.id}_extends_${parentClassNode.id}`,
            classNode.id,
            parentClassNode.id,
            'extends'
          ));
        }
      }

      if (classNode.metadata?.attributes?.implementsInterfaces) {
        const implementedInterfaces = classNode.metadata.attributes?.implementsInterfaces as string[];
        for (const interfaceName of implementedInterfaces) {
          const interfaceNode = interfaceNodes.find(n => n.name === interfaceName);

          if (interfaceNode) {
            edges.push(this.createEdge(
              `${classNode.id}_implements_${interfaceNode.id}`,
              classNode.id,
              interfaceNode.id,
              'implements'
            ));
          }
        }
      }

      if (classNode.metadata?.attributes?.traits) {
        const usedTraits = classNode.metadata.attributes?.traits as string[];
        for (const traitName of usedTraits) {
          const traitNode = nodes.find(n => n.type === 'trait' && n.name === traitName);

          if (traitNode) {
            edges.push(this.createEdge(
              `${classNode.id}_uses_${traitNode.id}`,
              classNode.id,
              traitNode.id,
              'uses_trait'
            ));
          }
        }
      }
    }

    for (const interfaceNode of interfaceNodes) {
      if (interfaceNode.metadata?.attributes?.extendsInterfaces) {
        const extendedInterfaces = interfaceNode.metadata.attributes?.extendsInterfaces as string[];
        for (const parentInterfaceName of extendedInterfaces) {
          const parentInterfaceNode = interfaceNodes.find(n => n.name === parentInterfaceName);

          if (parentInterfaceNode) {
            edges.push(this.createEdge(
              `${interfaceNode.id}_extends_${parentInterfaceNode.id}`,
              interfaceNode.id,
              parentInterfaceNode.id,
              'extends'
            ));
          }
        }
      }
    }
  }

  private isBuiltinNamespace(namespace: string): boolean {
    const builtinNamespaces = [
      'stdClass', 'Exception', 'ErrorException', 'Error', 'ParseError', 'TypeError',
      'ArgumentCountError', 'ArithmeticError', 'AssertionError', 'DivisionByZeroError',
      'CompileError', 'FatalError', 'Closure', 'Generator', 'WeakReference',
      'DateTime', 'DateTimeImmutable', 'DateTimeZone', 'DateInterval', 'DatePeriod',
      'ReflectionClass', 'ReflectionMethod', 'ReflectionProperty', 'ReflectionFunction',
      'PDO', 'PDOStatement', 'PDOException', 'mysqli', 'SplFileObject'
    ];

    return builtinNamespaces.some(builtin => namespace === builtin || namespace.startsWith(builtin));
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
      'interface-detection',
      'trait-analysis',
      'method-mapping',
      'namespace-organization',
      'inheritance-tracking',
      'composer-dependency-analysis',
      'framework-detection'
    ];
  }
}