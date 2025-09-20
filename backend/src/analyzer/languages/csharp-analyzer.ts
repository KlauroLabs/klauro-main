import { BaseAnalyzer, AnalysisContext } from '../core/base-analyzer';
import { CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint } from '../../types/cas.types';
import { AnalyzerError } from '../core/errors';
import * as fs from 'fs-extra';
import { glob } from 'glob';

interface CSharpClass {
  name: string;
  namespace: string;
  filePath: string;
  modifiers: string[];
  baseClass?: string;
  implementedInterfaces: string[];
  fields: CSharpField[];
  properties: CSharpProperty[];
  methods: CSharpMethod[];
  nestedTypes: string[];
  attributes: string[];
  lineStart: number;
  lineEnd: number;
  isAbstract: boolean;
  isSealed: boolean;
  isStatic: boolean;
}

interface CSharpMethod {
  name: string;
  returnType: string;
  parameters: CSharpParameter[];
  modifiers: string[];
  attributes: string[];
  lineStart: number;
  lineEnd: number;
  isConstructor: boolean;
  isDestructor: boolean;
  isStatic: boolean;
  isVirtual: boolean;
  isOverride: boolean;
  isAbstract: boolean;
  isAsync: boolean;
}

interface CSharpProperty {
  name: string;
  type: string;
  modifiers: string[];
  attributes: string[];
  hasGetter: boolean;
  hasSetter: boolean;
  isStatic: boolean;
  isVirtual: boolean;
  isOverride: boolean;
  lineNumber: number;
}

interface CSharpField {
  name: string;
  type: string;
  modifiers: string[];
  attributes: string[];
  initialValue?: string;
  isStatic: boolean;
  isReadonly: boolean;
  isConst: boolean;
  lineNumber: number;
}

interface CSharpParameter {
  name: string;
  type: string;
  modifiers: string[];
  defaultValue?: string;
  isRef: boolean;
  isOut: boolean;
  isParams: boolean;
}

interface CSharpInterface {
  name: string;
  namespace: string;
  filePath: string;
  baseInterfaces: string[];
  methods: CSharpMethod[];
  properties: CSharpProperty[];
  attributes: string[];
  lineStart: number;
  lineEnd: number;
}

interface CSharpUsing {
  namespace: string;
  alias?: string;
  lineNumber: number;
  isStatic: boolean;
  isGlobal: boolean;
}

interface CSharpEnum {
  name: string;
  namespace: string;
  filePath: string;
  modifiers: string[];
  baseType?: string;
  values: CSharpEnumValue[];
  attributes: string[];
  lineStart: number;
  lineEnd: number;
}

interface CSharpEnumValue {
  name: string;
  value?: string;
  attributes: string[];
  lineNumber: number;
}

interface CSharpStruct {
  name: string;
  namespace: string;
  filePath: string;
  modifiers: string[];
  implementedInterfaces: string[];
  fields: CSharpField[];
  properties: CSharpProperty[];
  methods: CSharpMethod[];
  attributes: string[];
  lineStart: number;
  lineEnd: number;
  isReadonly: boolean;
}

export class CSharpAnalyzer extends BaseAnalyzer {
  private aspNetCoreDetected = false;
  private entityFrameworkDetected = false;
  private dotNetCoreProject = false;
  private dotNetFrameworkProject = false;

  constructor() {
    super(
      'csharp-analyzer',
      'C# Language Analyzer',
      '1.0.0',
      'language'
    );
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const csharpFiles = await glob(['**/*.cs'], {
        cwd: projectPath,
        ignore: ['**/bin/**', '**/obj/**', '**/.git/**']
      });

      const projectFiles = await glob(['*.csproj', '*.sln', '*.vbproj'], {
        cwd: projectPath
      });

      return csharpFiles.length > 0 || projectFiles.length > 0;
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

      const csharpFiles = await glob(['**/*.cs'], {
        cwd: context.projectPath,
        ignore: ['**/bin/**', '**/obj/**', '**/.git/**', '**/Tests/**', '**/*Test.cs', '**/*Tests.cs']
      });

      const namespaces = new Map<string, string[]>();

      for (const file of csharpFiles) {
        const fullPath = `${context.projectPath}/${file}`;
        await this.analyzeCSharpFile(fullPath, file, nodes, edges, entryPoints, exitPoints, namespaces, context);
      }

      this.buildNamespaceHierarchy(namespaces, nodes, edges);
      this.detectAspNetPatterns(nodes, edges, entryPoints);
      this.buildInheritanceRelationships(nodes, edges);

      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        framework_specific: {
          language: 'csharp',
          aspNetCore: this.aspNetCoreDetected,
          entityFramework: this.entityFrameworkDetected,
          dotNetVersion: this.dotNetCoreProject ? 'core' : this.dotNetFrameworkProject ? 'framework' : 'unknown',
          libraries,
          filesAnalyzed: csharpFiles.length,
          namespacesFound: namespaces.size
        }
      });

    } catch (error) {
      throw new AnalyzerError(
        `C# analysis failed: ${(error as Error).message}`,
        'CSHARP_ANALYSIS_ERROR'
      );
    }
  }

  private async detectProjectType(projectPath: string): Promise<void> {
    const csprojFiles = await glob(['*.csproj'], { cwd: projectPath });

    for (const csprojFile of csprojFiles) {
      const csprojPath = `${projectPath}/${csprojFile}`;
      try {
        const csprojContent = await fs.readFile(csprojPath, 'utf-8');

        this.dotNetCoreProject = csprojContent.includes('<TargetFramework>net') ||
                                csprojContent.includes('<TargetFrameworks>net');

        this.dotNetFrameworkProject = csprojContent.includes('<TargetFrameworkVersion>') ||
                                     csprojContent.includes('Microsoft.NETFramework');

        this.aspNetCoreDetected = csprojContent.includes('Microsoft.AspNetCore') ||
                                 csprojContent.includes('AspNetCore.Mvc');

        this.entityFrameworkDetected = csprojContent.includes('Microsoft.EntityFrameworkCore') ||
                                      csprojContent.includes('EntityFramework');
      } catch (error) {
        console.warn(`Failed to read project file ${csprojFile}:`, error);
      }
    }
  }

  private async extractDependencies(projectPath: string, libraries: any[]): Promise<void> {
    const csprojFiles = await glob(['*.csproj'], { cwd: projectPath });

    for (const csprojFile of csprojFiles) {
      await this.extractCsprojDependencies(`${projectPath}/${csprojFile}`, libraries);
    }

    const packagesConfigPath = `${projectPath}/packages.config`;
    if (await fs.pathExists(packagesConfigPath)) {
      await this.extractPackagesConfigDependencies(packagesConfigPath, libraries);
    }
  }

  private async extractCsprojDependencies(csprojPath: string, libraries: any[]): Promise<void> {
    try {
      const csprojContent = await fs.readFile(csprojPath, 'utf-8');
      const packageRefMatches = csprojContent.matchAll(/<PackageReference\s+Include="([^"]+)"\s+Version="([^"]+)"/g);

      for (const match of packageRefMatches) {
        const packageName = match[1];
        const version = match[2];

        libraries.push({
          name: packageName,
          version: version,
          type: 'nuget_package',
          source: 'csproj',
          metadata: {
            packageManager: 'nuget',
            isProduction: true
          }
        });
      }

      const projectRefMatches = csprojContent.matchAll(/<ProjectReference\s+Include="([^"]+)"/g);
      for (const match of projectRefMatches) {
        libraries.push({
          name: match[1],
          version: 'local',
          type: 'project_reference',
          source: 'csproj',
          metadata: {
            isLocalProject: true
          }
        });
      }
    } catch (error) {
      console.warn('Failed to parse csproj file:', error);
    }
  }

  private async extractPackagesConfigDependencies(packagesConfigPath: string, libraries: any[]): Promise<void> {
    try {
      const packagesContent = await fs.readFile(packagesConfigPath, 'utf-8');
      const packageMatches = packagesContent.matchAll(/<package\s+id="([^"]+)"\s+version="([^"]+)"/g);

      for (const match of packageMatches) {
        libraries.push({
          name: match[1],
          version: match[2],
          type: 'nuget_package',
          source: 'packages.config',
          metadata: {
            packageManager: 'nuget',
            isProduction: true
          }
        });
      }
    } catch (error) {
      console.warn('Failed to parse packages.config:', error);
    }
  }

  private async analyzeCSharpFile(
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
      const usings = this.extractUsings(content);
      const classes = this.extractClasses(content, relativePath);
      const interfaces = this.extractInterfaces(content, relativePath);
      const enums = this.extractEnums(content, relativePath);
      const structs = this.extractStructs(content, relativePath);

      if (namespace) {
        if (!namespaces.has(namespace)) {
          namespaces.set(namespace, []);
        }
        namespaces.get(namespace)!.push(relativePath);
      }

      const fileId = `file_${this.sanitizeId(relativePath)}`;
      nodes.push(this.createNode(
        fileId,
        relativePath.split('/').pop() || 'unknown.cs',
        'file',
        1,
        fullPath,
        1,
        lines.length,
        {
          namespace: namespace || 'global',
          usings: usings.map(u => u.namespace),
          classCount: classes.length,
          interfaceCount: interfaces.length,
          enumCount: enums.length,
          structCount: structs.length
        }
      ));

      for (const using of usings) {
        const usingId = `using_${fileId}_${this.sanitizeId(using.namespace)}`;
        nodes.push(this.createNode(
          usingId,
          using.alias || using.namespace,
          'using',
          2,
          fullPath,
          using.lineNumber,
          using.lineNumber,
          {
            namespace: using.namespace,
            alias: using.alias,
            isStatic: using.isStatic,
            isGlobal: using.isGlobal
          }
        ));

        edges.push(this.createEdge(
          `${fileId}_uses_${usingId}`,
          fileId,
          usingId,
          'uses'
        ));

        if (!this.isSystemNamespace(using.namespace) && !using.namespace.startsWith(namespace || '')) {
          exitPoints.push({
            id: `exit_${usingId}`,
            name: `External namespace: ${using.namespace}`,
            type: 'external_namespace',
            source_node: usingId,
            metadata: { namespace: using.namespace }
          });
        }
      }

      for (const cls of classes) {
        await this.processCSharpClass(cls, fileId, fullPath, nodes, edges, entryPoints);
      }

      for (const intf of interfaces) {
        await this.processCSharpInterface(intf, fileId, fullPath, nodes, edges, entryPoints);
      }

      for (const enm of enums) {
        await this.processCSharpEnum(enm, fileId, fullPath, nodes, edges, entryPoints);
      }

      for (const struct of structs) {
        await this.processCSharpStruct(struct, fileId, fullPath, nodes, edges, entryPoints);
      }

    } catch (error) {
      console.warn(`Failed to analyze C# file ${relativePath}:`, error);
    }
  }

  private async processCSharpClass(
    cls: CSharpClass,
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
        baseClass: cls.baseClass,
        implementedInterfaces: cls.implementedInterfaces,
        attributes: cls.attributes,
        fieldCount: cls.fields.length,
        propertyCount: cls.properties.length,
        methodCount: cls.methods.length,
        isPublic: cls.modifiers.includes('public'),
        isAbstract: cls.isAbstract,
        isSealed: cls.isSealed,
        isStatic: cls.isStatic
      }
    ));

    edges.push(this.createEdge(
      `${fileId}_contains_${classId}`,
      fileId,
      classId,
      'contains'
    ));

    for (const field of cls.fields) {
      const fieldId = `field_${classId}_${this.sanitizeId(field.name)}`;
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
          modifiers: field.modifiers,
          attributes: field.attributes,
          isStatic: field.isStatic,
          isReadonly: field.isReadonly,
          isConst: field.isConst,
          initialValue: field.initialValue
        }
      ));

      edges.push(this.createEdge(
        `${classId}_has_field_${fieldId}`,
        classId,
        fieldId,
        'has_field'
      ));
    }

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
          type: property.type,
          modifiers: property.modifiers,
          attributes: property.attributes,
          hasGetter: property.hasGetter,
          hasSetter: property.hasSetter,
          isStatic: property.isStatic,
          isVirtual: property.isVirtual,
          isOverride: property.isOverride
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
          returnType: method.returnType,
          parameters: method.parameters,
          modifiers: method.modifiers,
          attributes: method.attributes,
          isConstructor: method.isConstructor,
          isDestructor: method.isDestructor,
          isStatic: method.isStatic,
          isVirtual: method.isVirtual,
          isOverride: method.isOverride,
          isAbstract: method.isAbstract,
          isAsync: method.isAsync,
          isPublic: method.modifiers.includes('public')
        }
      ));

      edges.push(this.createEdge(
        `${classId}_has_method_${methodId}`,
        classId,
        methodId,
        'has_method'
      ));

      if (method.modifiers.includes('public') && !method.isConstructor && !method.isDestructor) {
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

    if (cls.modifiers.includes('public')) {
      entryPoints.push({
        id: `entry_${classId}`,
        name: `Public class: ${cls.name}`,
        type: 'public_class',
        source_node: classId,
        metadata: {
          namespace: cls.namespace,
          className: cls.name,
          attributes: cls.attributes
        }
      });
    }
  }

  private async processCSharpInterface(
    intf: CSharpInterface,
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
        baseInterfaces: intf.baseInterfaces,
        attributes: intf.attributes,
        methodCount: intf.methods.length,
        propertyCount: intf.properties.length
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
          returnType: method.returnType,
          parameters: method.parameters,
          attributes: method.attributes
        }
      ));

      edges.push(this.createEdge(
        `${interfaceId}_declares_${methodId}`,
        interfaceId,
        methodId,
        'declares'
      ));
    }

    for (const property of intf.properties) {
      const propertyId = `property_${interfaceId}_${this.sanitizeId(property.name)}`;
      nodes.push(this.createNode(
        propertyId,
        property.name,
        'interface_property',
        4,
        fullPath,
        property.lineNumber,
        property.lineNumber,
        {
          type: property.type,
          hasGetter: property.hasGetter,
          hasSetter: property.hasSetter
        }
      ));

      edges.push(this.createEdge(
        `${interfaceId}_declares_${propertyId}`,
        interfaceId,
        propertyId,
        'declares'
      ));
    }

    entryPoints.push({
      id: `entry_${interfaceId}`,
      name: `Interface: ${intf.name}`,
      type: 'interface',
      source_node: interfaceId,
      metadata: {
        namespace: intf.namespace,
        interfaceName: intf.name,
        attributes: intf.attributes
      }
    });
  }

  private async processCSharpEnum(
    enm: CSharpEnum,
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
        modifiers: enm.modifiers,
        baseType: enm.baseType,
        attributes: enm.attributes,
        valueCount: enm.values.length
      }
    ));

    edges.push(this.createEdge(
      `${fileId}_contains_${enumId}`,
      fileId,
      enumId,
      'contains'
    ));

    for (const value of enm.values) {
      const valueId = `enumvalue_${enumId}_${this.sanitizeId(value.name)}`;
      nodes.push(this.createNode(
        valueId,
        value.name,
        'enum_value',
        4,
        fullPath,
        value.lineNumber,
        value.lineNumber,
        {
          value: value.value,
          attributes: value.attributes
        }
      ));

      edges.push(this.createEdge(
        `${enumId}_has_value_${valueId}`,
        enumId,
        valueId,
        'has_value'
      ));
    }

    if (enm.modifiers.includes('public')) {
      entryPoints.push({
        id: `entry_${enumId}`,
        name: `Public enum: ${enm.name}`,
        type: 'public_enum',
        source_node: enumId,
        metadata: {
          namespace: enm.namespace,
          enumName: enm.name,
          attributes: enm.attributes
        }
      });
    }
  }

  private async processCSharpStruct(
    struct: CSharpStruct,
    fileId: string,
    fullPath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: any[]
  ): Promise<void> {
    const structId = `struct_${this.sanitizeId(struct.namespace)}_${this.sanitizeId(struct.name)}`;

    nodes.push(this.createNode(
      structId,
      struct.name,
      'struct',
      2,
      fullPath,
      struct.lineStart,
      struct.lineEnd,
      {
        namespace: struct.namespace,
        modifiers: struct.modifiers,
        implementedInterfaces: struct.implementedInterfaces,
        attributes: struct.attributes,
        fieldCount: struct.fields.length,
        propertyCount: struct.properties.length,
        methodCount: struct.methods.length,
        isReadonly: struct.isReadonly
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
          modifiers: field.modifiers,
          attributes: field.attributes,
          isStatic: field.isStatic,
          isReadonly: field.isReadonly,
          isConst: field.isConst
        }
      ));

      edges.push(this.createEdge(
        `${structId}_has_field_${fieldId}`,
        structId,
        fieldId,
        'has_field'
      ));
    }

    if (struct.modifiers.includes('public')) {
      entryPoints.push({
        id: `entry_${structId}`,
        name: `Public struct: ${struct.name}`,
        type: 'public_struct',
        source_node: structId,
        metadata: {
          namespace: struct.namespace,
          structName: struct.name,
          attributes: struct.attributes
        }
      });
    }
  }

  private extractNamespace(content: string): string | null {
    const namespaceMatch = content.match(/namespace\s+([a-zA-Z0-9_.]+)/);
    return namespaceMatch ? namespaceMatch[1] : null;
  }

  private extractUsings(content: string): CSharpUsing[] {
    const usings: CSharpUsing[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      const globalUsingMatch = line.match(/^global\s+using\s+(static\s+)?([a-zA-Z0-9_.]+)(?:\s*=\s*([a-zA-Z0-9_.]+))?\s*;/);
      if (globalUsingMatch) {
        usings.push({
          namespace: globalUsingMatch[3] || globalUsingMatch[2],
          alias: globalUsingMatch[3] ? globalUsingMatch[2] : undefined,
          lineNumber: i + 1,
          isStatic: !!globalUsingMatch[1],
          isGlobal: true
        });
        continue;
      }

      const usingMatch = line.match(/^using\s+(static\s+)?([a-zA-Z0-9_.]+)(?:\s*=\s*([a-zA-Z0-9_.]+))?\s*;/);
      if (usingMatch) {
        usings.push({
          namespace: usingMatch[3] || usingMatch[2],
          alias: usingMatch[3] ? usingMatch[2] : undefined,
          lineNumber: i + 1,
          isStatic: !!usingMatch[1],
          isGlobal: false
        });
      }
    }

    return usings;
  }

  private extractClasses(content: string, filePath: string): CSharpClass[] {
    const classes: CSharpClass[] = [];
    const lines = content.split('\n');
    const namespace = this.extractNamespace(content) || 'global';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.includes('class ') && !line.startsWith('//') && !line.includes('interface')) {
        const classMatch = line.match(/\b(public|private|protected|internal|abstract|sealed|static|\s)*\s*class\s+(\w+)/);

        if (classMatch) {
          const modifiers = this.extractModifiers(line);
          const className = classMatch[2];
          const baseClassMatch = line.match(/:\s*([^,{]+)/);
          const implementsMatch = line.match(/:\s*[^,{]*,\s*(.+)/);

          const baseClass = baseClassMatch ? baseClassMatch[1].trim() : undefined;
          const implementedInterfaces: string[] = implementsMatch
            ? implementsMatch[1].split(',').map(s => s.trim())
            : [];

          const classStartLine = i + 1;
          const classEndLine = this.findBlockEnd(lines, i);

          const fields = this.extractFields(lines, i, classEndLine);
          const properties = this.extractProperties(lines, i, classEndLine);
          const methods = this.extractMethods(lines, i, classEndLine);
          const attributes = this.extractAttributes(lines, i);

          classes.push({
            name: className,
            namespace,
            filePath,
            modifiers,
            baseClass,
            implementedInterfaces,
            fields,
            properties,
            methods,
            nestedTypes: [],
            attributes,
            lineStart: classStartLine,
            lineEnd: classEndLine,
            isAbstract: modifiers.includes('abstract'),
            isSealed: modifiers.includes('sealed'),
            isStatic: modifiers.includes('static')
          });
        }
      }
    }

    return classes;
  }

  private extractInterfaces(content: string, filePath: string): CSharpInterface[] {
    const interfaces: CSharpInterface[] = [];
    const lines = content.split('\n');
    const namespace = this.extractNamespace(content) || 'global';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.includes('interface ') && !line.startsWith('//')) {
        const interfaceMatch = line.match(/\b(public|private|protected|internal|\s)*\s*interface\s+(\w+)/);

        if (interfaceMatch) {
          const interfaceName = interfaceMatch[2];
          const baseInterfacesMatch = line.match(/:\s*(.+)/);

          const baseInterfaces: string[] = baseInterfacesMatch
            ? baseInterfacesMatch[1].split(',').map(s => s.trim())
            : [];

          const interfaceStartLine = i + 1;
          const interfaceEndLine = this.findBlockEnd(lines, i);

          const methods = this.extractMethods(lines, i, interfaceEndLine);
          const properties = this.extractProperties(lines, i, interfaceEndLine);
          const attributes = this.extractAttributes(lines, i);

          interfaces.push({
            name: interfaceName,
            namespace,
            filePath,
            baseInterfaces,
            methods,
            properties,
            attributes,
            lineStart: interfaceStartLine,
            lineEnd: interfaceEndLine
          });
        }
      }
    }

    return interfaces;
  }

  private extractEnums(content: string, filePath: string): CSharpEnum[] {
    const enums: CSharpEnum[] = [];
    const lines = content.split('\n');
    const namespace = this.extractNamespace(content) || 'global';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.includes('enum ') && !line.startsWith('//')) {
        const enumMatch = line.match(/\b(public|private|protected|internal|\s)*\s*enum\s+(\w+)(?:\s*:\s*(\w+))?/);

        if (enumMatch) {
          const modifiers = this.extractModifiers(line);
          const enumName = enumMatch[2];
          const baseType = enumMatch[3];

          const enumStartLine = i + 1;
          const enumEndLine = this.findBlockEnd(lines, i);

          const values = this.extractEnumValues(lines, i, enumEndLine);
          const attributes = this.extractAttributes(lines, i);

          enums.push({
            name: enumName,
            namespace,
            filePath,
            modifiers,
            baseType,
            values,
            attributes,
            lineStart: enumStartLine,
            lineEnd: enumEndLine
          });
        }
      }
    }

    return enums;
  }

  private extractStructs(content: string, filePath: string): CSharpStruct[] {
    const structs: CSharpStruct[] = [];
    const lines = content.split('\n');
    const namespace = this.extractNamespace(content) || 'global';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.includes('struct ') && !line.startsWith('//')) {
        const structMatch = line.match(/\b(public|private|protected|internal|readonly|\s)*\s*struct\s+(\w+)/);

        if (structMatch) {
          const modifiers = this.extractModifiers(line);
          const structName = structMatch[2];
          const implementsMatch = line.match(/:\s*(.+)/);

          const implementedInterfaces: string[] = implementsMatch
            ? implementsMatch[1].split(',').map(s => s.trim())
            : [];

          const structStartLine = i + 1;
          const structEndLine = this.findBlockEnd(lines, i);

          const fields = this.extractFields(lines, i, structEndLine);
          const properties = this.extractProperties(lines, i, structEndLine);
          const methods = this.extractMethods(lines, i, structEndLine);
          const attributes = this.extractAttributes(lines, i);

          structs.push({
            name: structName,
            namespace,
            filePath,
            modifiers,
            implementedInterfaces,
            fields,
            properties,
            methods,
            attributes,
            lineStart: structStartLine,
            lineEnd: structEndLine,
            isReadonly: modifiers.includes('readonly')
          });
        }
      }
    }

    return structs;
  }

  private extractMethods(lines: string[], classStart: number, classEnd: number): CSharpMethod[] {
    const methods: CSharpMethod[] = [];

    for (let i = classStart; i < classEnd; i++) {
      const line = lines[i].trim();

      if (this.isMethodDeclaration(line)) {
        const methodMatch = line.match(/\b(\w+)\s*\(/);
        if (methodMatch) {
          const methodName = methodMatch[1];
          const modifiers = this.extractModifiers(line);
          const returnType = this.extractReturnType(line);
          const parameters = this.extractParameters(line);
          const attributes = this.extractAttributes(lines, i);

          const methodEndLine = this.findMethodEnd(lines, i);

          const isConstructor = methodName === lines[classStart]?.match(/class\s+(\w+)/)?.[1];
          const isDestructor = methodName.startsWith('~');
          const isAsync = line.includes('async ');

          methods.push({
            name: methodName,
            returnType,
            parameters,
            modifiers,
            attributes,
            lineStart: i + 1,
            lineEnd: methodEndLine,
            isConstructor,
            isDestructor,
            isStatic: modifiers.includes('static'),
            isVirtual: modifiers.includes('virtual'),
            isOverride: modifiers.includes('override'),
            isAbstract: modifiers.includes('abstract'),
            isAsync
          });
        }
      }
    }

    return methods;
  }

  private extractProperties(lines: string[], classStart: number, classEnd: number): CSharpProperty[] {
    const properties: CSharpProperty[] = [];

    for (let i = classStart; i < classEnd; i++) {
      const line = lines[i].trim();

      if (this.isPropertyDeclaration(line)) {
        const propertyMatch = line.match(/(\w+)\s+(\w+)\s*\{/);
        if (propertyMatch) {
          const type = propertyMatch[1];
          const propertyName = propertyMatch[2];
          const modifiers = this.extractModifiers(line);
          const attributes = this.extractAttributes(lines, i);

          const hasGetter = line.includes('get') || line.includes('{ get');
          const hasSetter = line.includes('set') || line.includes('{ set');

          properties.push({
            name: propertyName,
            type,
            modifiers,
            attributes,
            hasGetter,
            hasSetter,
            isStatic: modifiers.includes('static'),
            isVirtual: modifiers.includes('virtual'),
            isOverride: modifiers.includes('override'),
            lineNumber: i + 1
          });
        }
      }
    }

    return properties;
  }

  private extractFields(lines: string[], classStart: number, classEnd: number): CSharpField[] {
    const fields: CSharpField[] = [];

    for (let i = classStart; i < classEnd; i++) {
      const line = lines[i].trim();

      if (this.isFieldDeclaration(line)) {
        const fieldMatch = line.match(/(\w+)\s+(\w+)(?:\s*=\s*([^;]+))?/);
        if (fieldMatch) {
          const type = fieldMatch[1];
          const fieldName = fieldMatch[2];
          const initialValue = fieldMatch[3]?.trim();
          const modifiers = this.extractModifiers(line);
          const attributes = this.extractAttributes(lines, i);

          fields.push({
            name: fieldName,
            type,
            modifiers,
            attributes,
            initialValue,
            isStatic: modifiers.includes('static'),
            isReadonly: modifiers.includes('readonly'),
            isConst: modifiers.includes('const'),
            lineNumber: i + 1
          });
        }
      }
    }

    return fields;
  }

  private extractEnumValues(lines: string[], enumStart: number, enumEnd: number): CSharpEnumValue[] {
    const values: CSharpEnumValue[] = [];

    for (let i = enumStart + 1; i < enumEnd; i++) {
      const line = lines[i].trim();

      if (line && !line.startsWith('//') && !line.startsWith('{') && !line.startsWith('}')) {
        const valueMatch = line.match(/(\w+)(?:\s*=\s*([^,]+))?/);
        if (valueMatch) {
          const valueName = valueMatch[1];
          const value = valueMatch[2]?.trim();
          const attributes = this.extractAttributes(lines, i);

          values.push({
            name: valueName,
            value,
            attributes,
            lineNumber: i + 1
          });
        }
      }
    }

    return values;
  }

  private isMethodDeclaration(line: string): boolean {
    return line.includes('(') && line.includes(')') &&
           !line.startsWith('//') && !line.includes('if') &&
           !line.includes('while') && !line.includes('for') &&
           !line.includes('=') && !line.includes('{') &&
           (line.includes('public') || line.includes('private') ||
            line.includes('protected') || line.includes('internal') ||
            !!line.match(/\w+\s+\w+\s*\(/));
  }

  private isPropertyDeclaration(line: string): boolean {
    return line.includes('{') && !line.includes('(') &&
           !line.includes('=') && !line.startsWith('//') &&
           (line.includes('public') || line.includes('private') ||
            line.includes('protected') || line.includes('internal') ||
            !!line.match(/\w+\s+\w+\s*\{/));
  }

  private isFieldDeclaration(line: string): boolean {
    return (line.includes('=') || line.endsWith(';')) &&
           !line.includes('(') && !line.includes('return') &&
           !line.includes('{') && !line.startsWith('//') &&
           !line.includes('if') && !line.includes('for') &&
           (line.includes('private') || line.includes('public') ||
            line.includes('protected') || line.includes('internal') ||
            !!line.match(/\w+\s+\w+\s*[=;]/));
  }

  private extractModifiers(line: string): string[] {
    const modifiers: string[] = [];
    const modifierKeywords = [
      'public', 'private', 'protected', 'internal',
      'static', 'readonly', 'const', 'virtual', 'override',
      'abstract', 'sealed', 'async', 'extern', 'unsafe'
    ];

    for (const keyword of modifierKeywords) {
      if (line.includes(keyword)) {
        modifiers.push(keyword);
      }
    }

    return modifiers;
  }

  private extractReturnType(line: string): string {
    const parts = line.trim().split(/\s+/);
    let returnTypeIndex = -1;

    for (let i = 0; i < parts.length; i++) {
      if (parts[i].includes('(')) {
        returnTypeIndex = i - 1;
        break;
      }
    }

    return returnTypeIndex > 0 ? parts[returnTypeIndex] : 'void';
  }

  private extractParameters(line: string): CSharpParameter[] {
    const parameters: CSharpParameter[] = [];
    const paramMatch = line.match(/\((.*?)\)/);

    if (paramMatch && paramMatch[1].trim()) {
      const paramString = paramMatch[1];
      const params = this.splitParameters(paramString);

      for (const param of params) {
        const trimmed = param.trim();
        const paramMatch = trimmed.match(/^(ref\s+|out\s+|params\s+)?(\w+(?:\[\])?)\s+(\w+)(?:\s*=\s*(.+))?$/);

        if (paramMatch) {
          const modifier = paramMatch[1]?.trim();
          const type = paramMatch[2];
          const name = paramMatch[3];
          const defaultValue = paramMatch[4]?.trim();

          parameters.push({
            name,
            type,
            modifiers: modifier ? [modifier] : [],
            defaultValue,
            isRef: modifier === 'ref',
            isOut: modifier === 'out',
            isParams: modifier === 'params'
          });
        }
      }
    }

    return parameters;
  }

  private splitParameters(paramString: string): string[] {
    const params: string[] = [];
    let current = '';
    let depth = 0;

    for (const char of paramString) {
      if (char === '<') depth++;
      else if (char === '>') depth--;
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

  private extractAttributes(lines: string[], lineIndex: number): string[] {
    const attributes: string[] = [];

    for (let i = lineIndex - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line.startsWith('[') && line.endsWith(']')) {
        const attributeMatch = line.match(/\[([^\]]+)\]/);
        if (attributeMatch) {
          attributes.unshift(attributeMatch[1]);
        }
      } else if (line && !line.startsWith('//')) {
        break;
      }
    }

    return attributes;
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

  private detectAspNetPatterns(nodes: CASNode[], _edges: CASEdge[], entryPoints: any[]): void {
    if (!this.aspNetCoreDetected) return;

    const aspNetAttributes = ['Controller', 'ApiController', 'Route', 'HttpGet', 'HttpPost', 'HttpPut', 'HttpDelete'];

    for (const node of nodes) {
      if ((node.type === 'class' || node.type === 'method') && node.metadata?.attributes) {
        const attributes = node.metadata.attributes as string[];
        const aspNetAttribute = attributes.find(a => aspNetAttributes.some(attr => a.includes(attr)));

        if (aspNetAttribute) {
          if (!node.metadata.attributes) {
            node.metadata.attributes = {};
          }
          node.metadata.attributes.aspNetComponent = aspNetAttribute;

          if (node.type === 'class' && attributes.some(a => a.includes('Controller'))) {
            entryPoints.push({
              id: `entry_aspnet_${node.id}`,
              name: `ASP.NET Controller: ${node.name}`,
              type: 'aspnet_controller',
              source_node: node.id,
              metadata: {
                attribute: aspNetAttribute,
                className: node.name
              }
            });
          }

          if (node.type === 'method' && attributes.some(a => a.includes('Http'))) {
            entryPoints.push({
              id: `entry_aspnet_${node.id}`,
              name: `ASP.NET Endpoint: ${node.name}`,
              type: 'aspnet_endpoint',
              source_node: node.id,
              metadata: {
                attribute: aspNetAttribute,
                methodName: node.name
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
      if (classNode.metadata?.attributes?.baseClass) {
        const baseClassName = classNode.metadata.attributes.baseClass as string;
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

      if (classNode.metadata?.attributes?.implementedInterfaces) {
        const implementedInterfaces = classNode.metadata.attributes.implementedInterfaces as string[];
        for (const interfaceName of implementedInterfaces) {
          const interfaceNode = nodes.find(n => n.type === 'interface' && n.name === interfaceName);

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
    }
  }

  private isSystemNamespace(namespace: string): boolean {
    const systemNamespaces = [
      'System', 'Microsoft', 'Windows', 'Collections', 'Linq',
      'Text', 'IO', 'Threading', 'Net', 'Security', 'Reflection',
      'Runtime', 'Diagnostics', 'ComponentModel', 'Configuration'
    ];

    return systemNamespaces.some(sys => namespace === sys || namespace.startsWith(`${sys}.`));
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
      'method-detection',
      'interface-mapping',
      'inheritance-tracking',
      'attribute-parsing',
      'namespace-organization',
      'aspnet-core-detection',
      'entity-framework-detection'
    ];
  }
}