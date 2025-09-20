import { BaseAnalyzer, AnalysisContext } from '../core/base-analyzer';
import { CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint } from '../../types/cas.types';
import { AnalyzerError } from '../core/errors';
import * as fs from 'fs-extra';
import { glob } from 'glob';

interface RustStruct {
  name: string;
  moduleName: string;
  filePath: string;
  fields: RustField[];
  generics: string[];
  attributes: string[];
  visibility: string;
  lineStart: number;
  lineEnd: number;
  isPublic: boolean;
  isUnion: boolean;
}

interface RustEnum {
  name: string;
  moduleName: string;
  filePath: string;
  variants: RustEnumVariant[];
  generics: string[];
  attributes: string[];
  visibility: string;
  lineStart: number;
  lineEnd: number;
  isPublic: boolean;
}

interface RustTrait {
  name: string;
  moduleName: string;
  filePath: string;
  methods: RustMethod[];
  associatedTypes: RustAssociatedType[];
  supertraits: string[];
  generics: string[];
  attributes: string[];
  visibility: string;
  lineStart: number;
  lineEnd: number;
  isPublic: boolean;
}

interface RustImpl {
  traitName?: string;
  typeName: string;
  moduleName: string;
  filePath: string;
  methods: RustMethod[];
  generics: string[];
  whereClause?: string;
  lineStart: number;
  lineEnd: number;
}

interface RustFunction {
  name: string;
  moduleName: string;
  filePath: string;
  parameters: RustParameter[];
  returnType?: string;
  generics: string[];
  attributes: string[];
  visibility: string;
  lineStart: number;
  lineEnd: number;
  isPublic: boolean;
  isMain: boolean;
  isTest: boolean;
  isAsync: boolean;
  isUnsafe: boolean;
  isConst: boolean;
}

interface RustMethod {
  name: string;
  parameters: RustParameter[];
  returnType?: string;
  generics: string[];
  attributes: string[];
  visibility: string;
  lineStart: number;
  lineEnd: number;
  isPublic: boolean;
  isSelf: boolean;
  isMutSelf: boolean;
  isStatic: boolean;
  isAsync: boolean;
  isUnsafe: boolean;
  isConst: boolean;
}

interface RustParameter {
  name: string;
  type: string;
  isMutable: boolean;
  isReference: boolean;
  isLifetime: boolean;
}

interface RustField {
  name: string;
  type: string;
  attributes: string[];
  visibility: string;
  lineNumber: number;
  isPublic: boolean;
}

interface RustEnumVariant {
  name: string;
  fields?: RustField[];
  discriminant?: string;
  attributes: string[];
  lineNumber: number;
}

interface RustAssociatedType {
  name: string;
  bounds: string[];
  defaultType?: string;
  lineNumber: number;
}

interface RustUse {
  path: string;
  alias?: string;
  isGlob: boolean;
  isExternal: boolean;
  lineNumber: number;
}

interface RustMod {
  name: string;
  filePath: string;
  visibility: string;
  lineNumber: number;
  isPublic: boolean;
  isInline: boolean;
}

interface RustConstant {
  name: string;
  type: string;
  value?: string;
  moduleName: string;
  filePath: string;
  attributes: string[];
  visibility: string;
  lineNumber: number;
  isPublic: boolean;
}

interface RustStatic {
  name: string;
  type: string;
  value?: string;
  moduleName: string;
  filePath: string;
  attributes: string[];
  visibility: string;
  lineNumber: number;
  isPublic: boolean;
  isMutable: boolean;
}

interface RustType {
  name: string;
  underlying: string;
  moduleName: string;
  filePath: string;
  generics: string[];
  attributes: string[];
  visibility: string;
  lineNumber: number;
  isPublic: boolean;
}

export class RustAnalyzer extends BaseAnalyzer {
  private actixFrameworkDetected = false;
  private rocketFrameworkDetected = false;
  private warpFrameworkDetected = false;
  private axumFrameworkDetected = false;
  private cargoProject = false;

  constructor() {
    super(
      'rust-analyzer',
      'Rust Language Analyzer',
      '1.0.0',
      'language'
    );
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const rustFiles = await glob(['**/*.rs'], {
        cwd: projectPath,
        ignore: ['**/target/**', '**/.git/**']
      });

      const cargoFiles = await glob(['Cargo.toml', 'Cargo.lock'], {
        cwd: projectPath
      });

      return rustFiles.length > 0 || cargoFiles.length > 0;
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

      const rustFiles = await glob(['**/*.rs'], {
        cwd: context.projectPath,
        ignore: ['**/target/**', '**/.git/**']
      });

      const modules = new Map<string, string[]>();

      for (const file of rustFiles) {
        const fullPath = `${context.projectPath}/${file}`;
        await this.analyzeRustFile(fullPath, file, nodes, edges, entryPoints, exitPoints, modules, context);
      }

      this.buildModuleHierarchy(modules, nodes, edges);
      this.detectFrameworkPatterns(nodes, edges, entryPoints);
      this.buildTraitRelationships(nodes, edges);

      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        framework_specific: {
          language: 'rust',
          actixFramework: this.actixFrameworkDetected,
          rocketFramework: this.rocketFrameworkDetected,
          warpFramework: this.warpFrameworkDetected,
          axumFramework: this.axumFrameworkDetected,
          packageManager: this.cargoProject ? 'cargo' : 'unknown',
          libraries,
          filesAnalyzed: rustFiles.length,
          modulesFound: modules.size
        }
      });

    } catch (error) {
      throw new AnalyzerError(
        `Rust analysis failed: ${(error as Error).message}`,
        'RUST_ANALYSIS_ERROR'
      );
    }
  }

  private async detectProjectType(projectPath: string): Promise<void> {
    const cargoTomlPath = `${projectPath}/Cargo.toml`;

    this.cargoProject = await fs.pathExists(cargoTomlPath);

    if (this.cargoProject) {
      try {
        const cargoContent = await fs.readFile(cargoTomlPath, 'utf-8');
        this.detectFrameworks(cargoContent);
      } catch (error) {
        console.warn('Failed to read Cargo.toml:', error);
      }
    }
  }

  private detectFrameworks(content: string): void {
    this.actixFrameworkDetected = this.actixFrameworkDetected ||
      content.includes('actix-web') || content.includes('actix-rt');

    this.rocketFrameworkDetected = this.rocketFrameworkDetected ||
      content.includes('rocket');

    this.warpFrameworkDetected = this.warpFrameworkDetected ||
      content.includes('warp');

    this.axumFrameworkDetected = this.axumFrameworkDetected ||
      content.includes('axum');
  }

  private async extractDependencies(projectPath: string, libraries: any[]): Promise<void> {
    const cargoTomlPath = `${projectPath}/Cargo.toml`;
    const cargoLockPath = `${projectPath}/Cargo.lock`;

    if (await fs.pathExists(cargoTomlPath)) {
      await this.extractCargoTomlDependencies(cargoTomlPath, libraries);
    }

    if (await fs.pathExists(cargoLockPath)) {
      await this.extractCargoLockDependencies(cargoLockPath, libraries);
    }
  }

  private async extractCargoTomlDependencies(cargoTomlPath: string, libraries: any[]): Promise<void> {
    try {
      const cargoContent = await fs.readFile(cargoTomlPath, 'utf-8');
      const lines = cargoContent.split('\n');
      let inDependencies = false;
      let inDevDependencies = false;

      for (const line of lines) {
        const trimmed = line.trim();

        if (trimmed === '[dependencies]') {
          inDependencies = true;
          inDevDependencies = false;
          continue;
        }

        if (trimmed === '[dev-dependencies]') {
          inDependencies = false;
          inDevDependencies = true;
          continue;
        }

        if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
          inDependencies = false;
          inDevDependencies = false;
          continue;
        }

        if ((inDependencies || inDevDependencies) && trimmed.includes('=')) {
          const depMatch = trimmed.match(/^([a-zA-Z0-9_-]+)\s*=\s*(.+)/);
          if (depMatch) {
            const name = depMatch[1];
            const versionSpec = depMatch[2];

            let version = 'unknown';
            if (versionSpec.startsWith('"') && versionSpec.endsWith('"')) {
              version = versionSpec.slice(1, -1);
            }

            libraries.push({
              name,
              version,
              type: 'cargo_crate',
              source: 'Cargo.toml',
              metadata: {
                isProduction: inDependencies,
                isDevelopment: inDevDependencies
              }
            });
          }
        }
      }
    } catch (error) {
      console.warn('Failed to parse Cargo.toml:', error);
    }
  }

  private async extractCargoLockDependencies(cargoLockPath: string, libraries: any[]): Promise<void> {
    try {
      const cargoLockContent = await fs.readFile(cargoLockPath, 'utf-8');
      const lines = cargoLockContent.split('\n');
      let inPackage = false;
      let currentPackage: any = {};

      for (const line of lines) {
        const trimmed = line.trim();

        if (trimmed === '[[package]]') {
          if (currentPackage.name) {
            const existingLib = libraries.find(lib => lib.name === currentPackage.name);
            if (existingLib) {
              existingLib.metadata.exactVersion = currentPackage.version;
              existingLib.metadata.checksum = currentPackage.checksum;
            }
          }
          inPackage = true;
          currentPackage = {};
          continue;
        }

        if (inPackage && trimmed.includes('=')) {
          const keyValueMatch = trimmed.match(/^(\w+)\s*=\s*"([^"]+)"/);
          if (keyValueMatch) {
            const key = keyValueMatch[1];
            const value = keyValueMatch[2];
            currentPackage[key] = value;
          }
        }

        if (trimmed === '' && inPackage) {
          inPackage = false;
        }
      }

      if (currentPackage.name) {
        const existingLib = libraries.find(lib => lib.name === currentPackage.name);
        if (existingLib) {
          existingLib.metadata.exactVersion = currentPackage.version;
          existingLib.metadata.checksum = currentPackage.checksum;
        }
      }
    } catch (error) {
      console.warn('Failed to parse Cargo.lock:', error);
    }
  }

  private async analyzeRustFile(
    fullPath: string,
    relativePath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: any[],
    exitPoints: any[],
    modules: Map<string, string[]>,
    _context: AnalysisContext
  ): Promise<void> {
    try {
      const content = await fs.readFile(fullPath, 'utf-8');
      const lines = content.split('\n');

      const moduleName = this.getModuleName(relativePath);
      const uses = this.extractUses(content);
      const structs = this.extractStructs(content, relativePath);
      const enums = this.extractEnums(content, relativePath);
      const traits = this.extractTraits(content, relativePath);
      const impls = this.extractImpls(content, relativePath);
      const functions = this.extractFunctions(content, relativePath);
      const constants = this.extractConstants(content, relativePath);
      const statics = this.extractStatics(content, relativePath);
      const types = this.extractTypes(content, relativePath);
      const mods = this.extractMods(content);

      if (moduleName) {
        if (!modules.has(moduleName)) {
          modules.set(moduleName, []);
        }
        modules.get(moduleName)!.push(relativePath);
      }

      const fileId = `file_${this.sanitizeId(relativePath)}`;
      nodes.push(this.createNode(
        fileId,
        relativePath.split('/').pop() || 'unknown.rs',
        'file',
        1,
        fullPath,
        1,
        lines.length,
        {
          moduleName: moduleName || 'main',
          uses: uses.map(u => u.path),
          structCount: structs.length,
          enumCount: enums.length,
          traitCount: traits.length,
          implCount: impls.length,
          functionCount: functions.length,
          constantCount: constants.length,
          staticCount: statics.length,
          typeCount: types.length,
          modCount: mods.length
        }
      ));

      for (const use of uses) {
        const useId = `use_${fileId}_${this.sanitizeId(use.path)}`;
        nodes.push(this.createNode(
          useId,
          use.alias || use.path,
          'use',
          2,
          fullPath,
          use.lineNumber,
          use.lineNumber,
          {
            path: use.path,
            alias: use.alias,
            isGlob: use.isGlob,
            isExternal: use.isExternal
          }
        ));

        edges.push(this.createEdge(
          `${fileId}_uses_${useId}`,
          fileId,
          useId,
          'uses'
        ));

        if (use.isExternal) {
          exitPoints.push({
            id: `exit_${useId}`,
            name: `External crate: ${use.path}`,
            type: 'external_crate',
            source_node: useId,
            metadata: { path: use.path }
          });
        }
      }

      for (const struct of structs) {
        await this.processRustStruct(struct, fileId, fullPath, nodes, edges, entryPoints);
      }

      for (const enm of enums) {
        await this.processRustEnum(enm, fileId, fullPath, nodes, edges, entryPoints);
      }

      for (const trait of traits) {
        await this.processRustTrait(trait, fileId, fullPath, nodes, edges, entryPoints);
      }

      for (const impl of impls) {
        await this.processRustImpl(impl, fileId, fullPath, nodes, edges, entryPoints);
      }

      for (const func of functions) {
        await this.processRustFunction(func, fileId, fullPath, nodes, edges, entryPoints);
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
            moduleName: constant.moduleName,
            attributes: constant.attributes,
            visibility: constant.visibility,
            isPublic: constant.isPublic
          }
        ));

        edges.push(this.createEdge(
          `${fileId}_contains_${constantId}`,
          fileId,
          constantId,
          'contains'
        ));
      }

      for (const staticVar of statics) {
        const staticId = `static_${fileId}_${this.sanitizeId(staticVar.name)}`;
        nodes.push(this.createNode(
          staticId,
          staticVar.name,
          'static',
          3,
          fullPath,
          staticVar.lineNumber,
          staticVar.lineNumber,
          {
            type: staticVar.type,
            value: staticVar.value,
            moduleName: staticVar.moduleName,
            attributes: staticVar.attributes,
            visibility: staticVar.visibility,
            isPublic: staticVar.isPublic,
            isMutable: staticVar.isMutable
          }
        ));

        edges.push(this.createEdge(
          `${fileId}_contains_${staticId}`,
          fileId,
          staticId,
          'contains'
        ));
      }

      for (const type of types) {
        const typeId = `type_${fileId}_${this.sanitizeId(type.name)}`;
        nodes.push(this.createNode(
          typeId,
          type.name,
          'type',
          3,
          fullPath,
          type.lineNumber,
          type.lineNumber,
          {
            underlying: type.underlying,
            moduleName: type.moduleName,
            generics: type.generics,
            attributes: type.attributes,
            visibility: type.visibility,
            isPublic: type.isPublic
          }
        ));

        edges.push(this.createEdge(
          `${fileId}_contains_${typeId}`,
          fileId,
          typeId,
          'contains'
        ));
      }

    } catch (error) {
      console.warn(`Failed to analyze Rust file ${relativePath}:`, error);
    }
  }

  private async processRustStruct(
    struct: RustStruct,
    fileId: string,
    fullPath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: any[]
  ): Promise<void> {
    const structId = `struct_${this.sanitizeId(struct.moduleName)}_${this.sanitizeId(struct.name)}`;

    nodes.push(this.createNode(
      structId,
      struct.name,
      'struct',
      2,
      fullPath,
      struct.lineStart,
      struct.lineEnd,
      {
        moduleName: struct.moduleName,
        fieldCount: struct.fields.length,
        generics: struct.generics,
        attributes: struct.attributes,
        visibility: struct.visibility,
        isPublic: struct.isPublic,
        isUnion: struct.isUnion
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
          attributes: field.attributes,
          visibility: field.visibility,
          isPublic: field.isPublic
        }
      ));

      edges.push(this.createEdge(
        `${structId}_has_field_${fieldId}`,
        structId,
        fieldId,
        'has_field'
      ));
    }

    if (struct.isPublic) {
      entryPoints.push({
        id: `entry_${structId}`,
        name: `Public struct: ${struct.name}`,
        type: 'public_struct',
        source_node: structId,
        metadata: {
          moduleName: struct.moduleName,
          structName: struct.name,
          attributes: struct.attributes,
          generics: struct.generics
        }
      });
    }
  }

  private async processRustEnum(
    enm: RustEnum,
    fileId: string,
    fullPath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: any[]
  ): Promise<void> {
    const enumId = `enum_${this.sanitizeId(enm.moduleName)}_${this.sanitizeId(enm.name)}`;

    nodes.push(this.createNode(
      enumId,
      enm.name,
      'enum',
      2,
      fullPath,
      enm.lineStart,
      enm.lineEnd,
      {
        moduleName: enm.moduleName,
        variantCount: enm.variants.length,
        generics: enm.generics,
        attributes: enm.attributes,
        visibility: enm.visibility,
        isPublic: enm.isPublic
      }
    ));

    edges.push(this.createEdge(
      `${fileId}_contains_${enumId}`,
      fileId,
      enumId,
      'contains'
    ));

    for (const variant of enm.variants) {
      const variantId = `variant_${enumId}_${this.sanitizeId(variant.name)}`;
      nodes.push(this.createNode(
        variantId,
        variant.name,
        'enum_variant',
        4,
        fullPath,
        variant.lineNumber,
        variant.lineNumber,
        {
          discriminant: variant.discriminant,
          attributes: variant.attributes,
          fieldCount: variant.fields?.length || 0
        }
      ));

      edges.push(this.createEdge(
        `${enumId}_has_variant_${variantId}`,
        enumId,
        variantId,
        'has_variant'
      ));

      if (variant.fields) {
        for (const field of variant.fields) {
          const fieldId = `field_${variantId}_${this.sanitizeId(field.name)}`;
          nodes.push(this.createNode(
            fieldId,
            field.name,
            'field',
            5,
            fullPath,
            field.lineNumber,
            field.lineNumber,
            {
              type: field.type,
              attributes: field.attributes,
              visibility: field.visibility,
              isPublic: field.isPublic
            }
          ));

          edges.push(this.createEdge(
            `${variantId}_has_field_${fieldId}`,
            variantId,
            fieldId,
            'has_field'
          ));
        }
      }
    }

    if (enm.isPublic) {
      entryPoints.push({
        id: `entry_${enumId}`,
        name: `Public enum: ${enm.name}`,
        type: 'public_enum',
        source_node: enumId,
        metadata: {
          moduleName: enm.moduleName,
          enumName: enm.name,
          attributes: enm.attributes,
          generics: enm.generics
        }
      });
    }
  }

  private async processRustTrait(
    trait: RustTrait,
    fileId: string,
    fullPath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: any[]
  ): Promise<void> {
    const traitId = `trait_${this.sanitizeId(trait.moduleName)}_${this.sanitizeId(trait.name)}`;

    nodes.push(this.createNode(
      traitId,
      trait.name,
      'trait',
      2,
      fullPath,
      trait.lineStart,
      trait.lineEnd,
      {
        moduleName: trait.moduleName,
        methodCount: trait.methods.length,
        associatedTypeCount: trait.associatedTypes.length,
        supertraits: trait.supertraits,
        generics: trait.generics,
        attributes: trait.attributes,
        visibility: trait.visibility,
        isPublic: trait.isPublic
      }
    ));

    edges.push(this.createEdge(
      `${fileId}_contains_${traitId}`,
      fileId,
      traitId,
      'contains'
    ));

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
          parameters: method.parameters,
          returnType: method.returnType,
          generics: method.generics,
          attributes: method.attributes,
          visibility: method.visibility,
          isPublic: method.isPublic,
          isSelf: method.isSelf,
          isMutSelf: method.isMutSelf,
          isStatic: method.isStatic,
          isAsync: method.isAsync,
          isUnsafe: method.isUnsafe,
          isConst: method.isConst
        }
      ));

      edges.push(this.createEdge(
        `${traitId}_declares_${methodId}`,
        traitId,
        methodId,
        'declares'
      ));
    }

    for (const assocType of trait.associatedTypes) {
      const assocTypeId = `assoc_type_${traitId}_${this.sanitizeId(assocType.name)}`;
      nodes.push(this.createNode(
        assocTypeId,
        assocType.name,
        'associated_type',
        4,
        fullPath,
        assocType.lineNumber,
        assocType.lineNumber,
        {
          bounds: assocType.bounds,
          defaultType: assocType.defaultType
        }
      ));

      edges.push(this.createEdge(
        `${traitId}_declares_${assocTypeId}`,
        traitId,
        assocTypeId,
        'declares'
      ));
    }

    if (trait.isPublic) {
      entryPoints.push({
        id: `entry_${traitId}`,
        name: `Public trait: ${trait.name}`,
        type: 'public_trait',
        source_node: traitId,
        metadata: {
          moduleName: trait.moduleName,
          traitName: trait.name,
          attributes: trait.attributes,
          generics: trait.generics,
          supertraits: trait.supertraits
        }
      });
    }
  }

  private async processRustImpl(
    impl: RustImpl,
    fileId: string,
    fullPath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: any[]
  ): Promise<void> {
    const implId = `impl_${this.sanitizeId(impl.moduleName)}_${this.sanitizeId(impl.typeName)}_${impl.lineStart}`;

    nodes.push(this.createNode(
      implId,
      `impl ${impl.traitName || ''} for ${impl.typeName}`.trim(),
      'impl',
      2,
      fullPath,
      impl.lineStart,
      impl.lineEnd,
      {
        traitName: impl.traitName,
        typeName: impl.typeName,
        moduleName: impl.moduleName,
        methodCount: impl.methods.length,
        generics: impl.generics,
        whereClause: impl.whereClause
      }
    ));

    edges.push(this.createEdge(
      `${fileId}_contains_${implId}`,
      fileId,
      implId,
      'contains'
    ));

    for (const method of impl.methods) {
      const methodId = `method_${implId}_${this.sanitizeId(method.name)}_${method.lineStart}`;
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
          returnType: method.returnType,
          generics: method.generics,
          attributes: method.attributes,
          visibility: method.visibility,
          isPublic: method.isPublic,
          isSelf: method.isSelf,
          isMutSelf: method.isMutSelf,
          isStatic: method.isStatic,
          isAsync: method.isAsync,
          isUnsafe: method.isUnsafe,
          isConst: method.isConst
        }
      ));

      edges.push(this.createEdge(
        `${implId}_has_method_${methodId}`,
        implId,
        methodId,
        'has_method'
      ));

      if (method.isPublic) {
        entryPoints.push({
          id: `entry_${methodId}`,
          name: `Public method: ${impl.typeName}.${method.name}`,
          type: 'public_method',
          source_node: methodId,
          metadata: {
            typeName: impl.typeName,
            traitName: impl.traitName,
            methodName: method.name,
            returnType: method.returnType,
            parameters: method.parameters.map(p => p.type)
          }
        });
      }
    }
  }

  private async processRustFunction(
    func: RustFunction,
    fileId: string,
    fullPath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: any[]
  ): Promise<void> {
    const functionId = `function_${this.sanitizeId(func.moduleName)}_${this.sanitizeId(func.name)}_${func.lineStart}`;

    nodes.push(this.createNode(
      functionId,
      func.name,
      'function',
      3,
      fullPath,
      func.lineStart,
      func.lineEnd,
      {
        moduleName: func.moduleName,
        parameters: func.parameters,
        returnType: func.returnType,
        generics: func.generics,
        attributes: func.attributes,
        visibility: func.visibility,
        isPublic: func.isPublic,
        isMain: func.isMain,
        isTest: func.isTest,
        isAsync: func.isAsync,
        isUnsafe: func.isUnsafe,
        isConst: func.isConst
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
          moduleName: func.moduleName,
          functionName: func.name
        }
      });
    } else if (func.isTest) {
      entryPoints.push({
        id: `entry_${functionId}`,
        name: `Test function: ${func.name}`,
        type: 'test_function',
        source_node: functionId,
        metadata: {
          moduleName: func.moduleName,
          functionName: func.name,
          attributes: func.attributes
        }
      });
    } else if (func.isPublic) {
      entryPoints.push({
        id: `entry_${functionId}`,
        name: `Public function: ${func.name}`,
        type: 'public_function',
        source_node: functionId,
        metadata: {
          moduleName: func.moduleName,
          functionName: func.name,
          returnType: func.returnType,
          parameters: func.parameters.map(p => p.type)
        }
      });
    }
  }

  private extractUses(content: string): RustUse[] {
    const uses: RustUse[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.startsWith('use ')) {
        const useMatch = line.match(/use\s+([^;]+);/);
        if (useMatch) {
          const useStr = useMatch[1].trim();
          const aliasMatch = useStr.match(/(.+)\s+as\s+(\w+)$/);

          let path: string;
          let alias: string | undefined;

          if (aliasMatch) {
            path = aliasMatch[1].trim();
            alias = aliasMatch[2];
          } else {
            path = useStr;
          }

          const isGlob = path.includes('*');
          const isExternal = !path.startsWith('crate::') &&
                           !path.startsWith('super::') &&
                           !path.startsWith('self::') &&
                           !path.startsWith('::');

          uses.push({
            path,
            alias,
            isGlob,
            isExternal,
            lineNumber: i + 1
          });
        }
      }
    }

    return uses;
  }

  private extractStructs(content: string, filePath: string): RustStruct[] {
    const structs: RustStruct[] = [];
    const lines = content.split('\n');
    const moduleName = this.getModuleName(filePath);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.includes('struct ') && !line.startsWith('//')) {
        const structMatch = line.match(/(pub\s+)?(struct|union)\s+([A-Za-z_]\w*)(?:<([^>]+)>)?/);
        if (structMatch) {
          const isPublic = !!structMatch[1];
          const isUnion = structMatch[2] === 'union';
          const structName = structMatch[3];
          const generics = structMatch[4] ? structMatch[4].split(',').map(g => g.trim()) : [];

          const attributes = this.extractAttributes(lines, i);
          const structStartLine = i + 1;
          const structEndLine = this.findBlockEnd(lines, i);

          const fields = this.extractStructFields(lines, i, structEndLine);

          structs.push({
            name: structName,
            moduleName,
            filePath,
            fields,
            generics,
            attributes,
            visibility: isPublic ? 'pub' : 'private',
            lineStart: structStartLine,
            lineEnd: structEndLine,
            isPublic,
            isUnion
          });
        }
      }
    }

    return structs;
  }

  private extractEnums(content: string, filePath: string): RustEnum[] {
    const enums: RustEnum[] = [];
    const lines = content.split('\n');
    const moduleName = this.getModuleName(filePath);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.includes('enum ') && !line.startsWith('//')) {
        const enumMatch = line.match(/(pub\s+)?enum\s+([A-Za-z_]\w*)(?:<([^>]+)>)?/);
        if (enumMatch) {
          const isPublic = !!enumMatch[1];
          const enumName = enumMatch[2];
          const generics = enumMatch[3] ? enumMatch[3].split(',').map(g => g.trim()) : [];

          const attributes = this.extractAttributes(lines, i);
          const enumStartLine = i + 1;
          const enumEndLine = this.findBlockEnd(lines, i);

          const variants = this.extractEnumVariants(lines, i, enumEndLine);

          enums.push({
            name: enumName,
            moduleName,
            filePath,
            variants,
            generics,
            attributes,
            visibility: isPublic ? 'pub' : 'private',
            lineStart: enumStartLine,
            lineEnd: enumEndLine,
            isPublic
          });
        }
      }
    }

    return enums;
  }

  private extractTraits(content: string, filePath: string): RustTrait[] {
    const traits: RustTrait[] = [];
    const lines = content.split('\n');
    const moduleName = this.getModuleName(filePath);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.includes('trait ') && !line.startsWith('//')) {
        const traitMatch = line.match(/(pub\s+)?trait\s+([A-Za-z_]\w*)(?:<([^>]+)>)?(?::\s*([^{]+))?/);
        if (traitMatch) {
          const isPublic = !!traitMatch[1];
          const traitName = traitMatch[2];
          const generics = traitMatch[3] ? traitMatch[3].split(',').map(g => g.trim()) : [];
          const supertraits = traitMatch[4] ? traitMatch[4].split('+').map(s => s.trim()) : [];

          const attributes = this.extractAttributes(lines, i);
          const traitStartLine = i + 1;
          const traitEndLine = this.findBlockEnd(lines, i);

          const methods = this.extractTraitMethods(lines, i, traitEndLine);
          const associatedTypes = this.extractAssociatedTypes(lines, i, traitEndLine);

          traits.push({
            name: traitName,
            moduleName,
            filePath,
            methods,
            associatedTypes,
            supertraits,
            generics,
            attributes,
            visibility: isPublic ? 'pub' : 'private',
            lineStart: traitStartLine,
            lineEnd: traitEndLine,
            isPublic
          });
        }
      }
    }

    return traits;
  }

  private extractImpls(content: string, filePath: string): RustImpl[] {
    const impls: RustImpl[] = [];
    const lines = content.split('\n');
    const moduleName = this.getModuleName(filePath);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.startsWith('impl ')) {
        const implMatch = line.match(/impl(?:<([^>]+)>)?\s+(?:([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)\s+for\s+)?([A-Za-z_]\w*)(?:<([^>]+)>)?(?:\s+where\s+([^{]+))?/);
        if (implMatch) {
          const implGenerics = implMatch[1] ? implMatch[1].split(',').map(g => g.trim()) : [];
          const traitName = implMatch[2];
          const typeName = implMatch[3];
          const typeGenerics = implMatch[4] ? implMatch[4].split(',').map(g => g.trim()) : [];
          const whereClause = implMatch[5]?.trim();

          const generics = [...implGenerics, ...typeGenerics];
          const implStartLine = i + 1;
          const implEndLine = this.findBlockEnd(lines, i);

          const methods = this.extractImplMethods(lines, i, implEndLine);

          impls.push({
            traitName,
            typeName,
            moduleName,
            filePath,
            methods,
            generics,
            whereClause,
            lineStart: implStartLine,
            lineEnd: implEndLine
          });
        }
      }
    }

    return impls;
  }

  private extractFunctions(content: string, filePath: string): RustFunction[] {
    const functions: RustFunction[] = [];
    const lines = content.split('\n');
    const moduleName = this.getModuleName(filePath);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.includes('fn ') && !line.startsWith('//') && !this.isInsideImpl(lines, i)) {
        const fnMatch = line.match(/(pub\s+)?(async\s+)?(unsafe\s+)?(const\s+)?fn\s+([A-Za-z_]\w*)(?:<([^>]+)>)?\s*\(([^)]*)\)(?:\s*->\s*([^{]+))?/);
        if (fnMatch) {
          const isPublic = !!fnMatch[1];
          const isAsync = !!fnMatch[2];
          const isUnsafe = !!fnMatch[3];
          const isConst = !!fnMatch[4];
          const functionName = fnMatch[5];
          const generics = fnMatch[6] ? fnMatch[6].split(',').map(g => g.trim()) : [];
          const paramsStr = fnMatch[7];
          const returnType = fnMatch[8]?.trim();

          const attributes = this.extractAttributes(lines, i);
          const functionStartLine = i + 1;
          const functionEndLine = this.findBlockEnd(lines, i);

          const parameters = this.extractFunctionParameters(paramsStr);
          const isMain = functionName === 'main' && parameters.length === 0;
          const isTest = attributes.includes('test');

          functions.push({
            name: functionName,
            moduleName,
            filePath,
            parameters,
            returnType,
            generics,
            attributes,
            visibility: isPublic ? 'pub' : 'private',
            lineStart: functionStartLine,
            lineEnd: functionEndLine,
            isPublic,
            isMain,
            isTest,
            isAsync,
            isUnsafe,
            isConst
          });
        }
      }
    }

    return functions;
  }

  private extractConstants(content: string, filePath: string): RustConstant[] {
    const constants: RustConstant[] = [];
    const lines = content.split('\n');
    const moduleName = this.getModuleName(filePath);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.startsWith('const ') || line.startsWith('pub const ')) {
        const constMatch = line.match(/(pub\s+)?const\s+([A-Za-z_]\w*):\s*([^=]+)(?:\s*=\s*([^;]+))?;/);
        if (constMatch) {
          const isPublic = !!constMatch[1];
          const constName = constMatch[2];
          const type = constMatch[3].trim();
          const value = constMatch[4]?.trim();

          const attributes = this.extractAttributes(lines, i);

          constants.push({
            name: constName,
            type,
            value,
            moduleName,
            filePath,
            attributes,
            visibility: isPublic ? 'pub' : 'private',
            lineNumber: i + 1,
            isPublic
          });
        }
      }
    }

    return constants;
  }

  private extractStatics(content: string, filePath: string): RustStatic[] {
    const statics: RustStatic[] = [];
    const lines = content.split('\n');
    const moduleName = this.getModuleName(filePath);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.startsWith('static ') || line.startsWith('pub static ')) {
        const staticMatch = line.match(/(pub\s+)?static\s+(mut\s+)?([A-Za-z_]\w*):\s*([^=]+)(?:\s*=\s*([^;]+))?;/);
        if (staticMatch) {
          const isPublic = !!staticMatch[1];
          const isMutable = !!staticMatch[2];
          const staticName = staticMatch[3];
          const type = staticMatch[4].trim();
          const value = staticMatch[5]?.trim();

          const attributes = this.extractAttributes(lines, i);

          statics.push({
            name: staticName,
            type,
            value,
            moduleName,
            filePath,
            attributes,
            visibility: isPublic ? 'pub' : 'private',
            lineNumber: i + 1,
            isPublic,
            isMutable
          });
        }
      }
    }

    return statics;
  }

  private extractTypes(content: string, filePath: string): RustType[] {
    const types: RustType[] = [];
    const lines = content.split('\n');
    const moduleName = this.getModuleName(filePath);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.startsWith('type ') || line.startsWith('pub type ')) {
        const typeMatch = line.match(/(pub\s+)?type\s+([A-Za-z_]\w*)(?:<([^>]+)>)?\s*=\s*([^;]+);/);
        if (typeMatch) {
          const isPublic = !!typeMatch[1];
          const typeName = typeMatch[2];
          const generics = typeMatch[3] ? typeMatch[3].split(',').map(g => g.trim()) : [];
          const underlying = typeMatch[4].trim();

          const attributes = this.extractAttributes(lines, i);

          types.push({
            name: typeName,
            underlying,
            moduleName,
            filePath,
            generics,
            attributes,
            visibility: isPublic ? 'pub' : 'private',
            lineNumber: i + 1,
            isPublic
          });
        }
      }
    }

    return types;
  }

  private extractMods(content: string): RustMod[] {
    const mods: RustMod[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.startsWith('mod ') || line.startsWith('pub mod ')) {
        const modMatch = line.match(/(pub\s+)?mod\s+([A-Za-z_]\w*)(?:\s*\{|\s*;)/);
        if (modMatch) {
          const isPublic = !!modMatch[1];
          const modName = modMatch[2];
          const isInline = line.includes('{');

          mods.push({
            name: modName,
            filePath: '',
            visibility: isPublic ? 'pub' : 'private',
            lineNumber: i + 1,
            isPublic,
            isInline
          });
        }
      }
    }

    return mods;
  }

  private extractStructFields(lines: string[], structStart: number, structEnd: number): RustField[] {
    const fields: RustField[] = [];

    for (let i = structStart + 1; i < structEnd; i++) {
      const line = lines[i].trim();

      if (line && !line.startsWith('//') && !line.startsWith('{') && !line.startsWith('}')) {
        const fieldMatch = line.match(/(pub\s+)?([A-Za-z_]\w*):\s*([^,}]+)/);
        if (fieldMatch) {
          const isPublic = !!fieldMatch[1];
          const fieldName = fieldMatch[2];
          const fieldType = fieldMatch[3].replace(/,$/, '').trim();

          const attributes = this.extractAttributes(lines, i);

          fields.push({
            name: fieldName,
            type: fieldType,
            attributes,
            visibility: isPublic ? 'pub' : 'private',
            lineNumber: i + 1,
            isPublic
          });
        }
      }
    }

    return fields;
  }

  private extractEnumVariants(lines: string[], enumStart: number, enumEnd: number): RustEnumVariant[] {
    const variants: RustEnumVariant[] = [];

    for (let i = enumStart + 1; i < enumEnd; i++) {
      const line = lines[i].trim();

      if (line && !line.startsWith('//') && !line.startsWith('{') && !line.startsWith('}')) {
        const variantMatch = line.match(/([A-Za-z_]\w*)(?:\s*\{([^}]*)\}|\s*\(([^)]*)\))?(?:\s*=\s*([^,}]+))?/);
        if (variantMatch) {
          const variantName = variantMatch[1];
          const structFields = variantMatch[2];
          const tupleFields = variantMatch[3];
          const discriminant = variantMatch[4]?.replace(/,$/, '').trim();

          const attributes = this.extractAttributes(lines, i);
          let fields: RustField[] | undefined;

          if (structFields) {
            fields = this.parseEnumStructFields(structFields);
          } else if (tupleFields) {
            fields = this.parseEnumTupleFields(tupleFields);
          }

          variants.push({
            name: variantName,
            fields,
            discriminant,
            attributes,
            lineNumber: i + 1
          });
        }
      }
    }

    return variants;
  }

  private extractTraitMethods(lines: string[], traitStart: number, traitEnd: number): RustMethod[] {
    const methods: RustMethod[] = [];

    for (let i = traitStart + 1; i < traitEnd; i++) {
      const line = lines[i].trim();

      if (line.includes('fn ') && !line.startsWith('//')) {
        const methodMatch = line.match(/(async\s+)?(unsafe\s+)?(const\s+)?fn\s+([A-Za-z_]\w*)(?:<([^>]+)>)?\s*\(([^)]*)\)(?:\s*->\s*([^{;]+))?/);
        if (methodMatch) {
          const isAsync = !!methodMatch[1];
          const isUnsafe = !!methodMatch[2];
          const isConst = !!methodMatch[3];
          const methodName = methodMatch[4];
          const generics = methodMatch[5] ? methodMatch[5].split(',').map(g => g.trim()) : [];
          const paramsStr = methodMatch[6];
          const returnType = methodMatch[7]?.trim();

          const attributes = this.extractAttributes(lines, i);
          const parameters = this.extractFunctionParameters(paramsStr);
          const methodEndLine = line.includes('{') ? this.findBlockEnd(lines, i) : i + 1;

          const isSelf = parameters.some(p => p.name === 'self');
          const isMutSelf = parameters.some(p => p.name === 'self' && p.isMutable);

          methods.push({
            name: methodName,
            parameters,
            returnType,
            generics,
            attributes,
            visibility: 'pub',
            lineStart: i + 1,
            lineEnd: methodEndLine,
            isPublic: true,
            isSelf,
            isMutSelf,
            isStatic: !isSelf,
            isAsync,
            isUnsafe,
            isConst
          });
        }
      }
    }

    return methods;
  }

  private extractImplMethods(lines: string[], implStart: number, implEnd: number): RustMethod[] {
    const methods: RustMethod[] = [];

    for (let i = implStart + 1; i < implEnd; i++) {
      const line = lines[i].trim();

      if (line.includes('fn ') && !line.startsWith('//')) {
        const methodMatch = line.match(/(pub\s+)?(async\s+)?(unsafe\s+)?(const\s+)?fn\s+([A-Za-z_]\w*)(?:<([^>]+)>)?\s*\(([^)]*)\)(?:\s*->\s*([^{]+))?/);
        if (methodMatch) {
          const isPublic = !!methodMatch[1];
          const isAsync = !!methodMatch[2];
          const isUnsafe = !!methodMatch[3];
          const isConst = !!methodMatch[4];
          const methodName = methodMatch[5];
          const generics = methodMatch[6] ? methodMatch[6].split(',').map(g => g.trim()) : [];
          const paramsStr = methodMatch[7];
          const returnType = methodMatch[8]?.trim();

          const attributes = this.extractAttributes(lines, i);
          const parameters = this.extractFunctionParameters(paramsStr);
          const methodEndLine = this.findBlockEnd(lines, i);

          const isSelf = parameters.some(p => p.name === 'self');
          const isMutSelf = parameters.some(p => p.name === 'self' && p.isMutable);

          methods.push({
            name: methodName,
            parameters,
            returnType,
            generics,
            attributes,
            visibility: isPublic ? 'pub' : 'private',
            lineStart: i + 1,
            lineEnd: methodEndLine,
            isPublic,
            isSelf,
            isMutSelf,
            isStatic: !isSelf,
            isAsync,
            isUnsafe,
            isConst
          });
        }
      }
    }

    return methods;
  }

  private extractAssociatedTypes(lines: string[], traitStart: number, traitEnd: number): RustAssociatedType[] {
    const associatedTypes: RustAssociatedType[] = [];

    for (let i = traitStart + 1; i < traitEnd; i++) {
      const line = lines[i].trim();

      if (line.startsWith('type ')) {
        const typeMatch = line.match(/type\s+([A-Za-z_]\w*)(?::\s*([^=;]+))?(?:\s*=\s*([^;]+))?;/);
        if (typeMatch) {
          const typeName = typeMatch[1];
          const bounds = typeMatch[2] ? typeMatch[2].split('+').map(b => b.trim()) : [];
          const defaultType = typeMatch[3]?.trim();

          associatedTypes.push({
            name: typeName,
            bounds,
            defaultType,
            lineNumber: i + 1
          });
        }
      }
    }

    return associatedTypes;
  }

  private extractFunctionParameters(paramsStr: string): RustParameter[] {
    const parameters: RustParameter[] = [];

    if (!paramsStr || !paramsStr.trim()) {
      return parameters;
    }

    const params = this.splitParameters(paramsStr);

    for (const param of params) {
      const trimmed = param.trim();

      if (trimmed === 'self') {
        parameters.push({
          name: 'self',
          type: 'Self',
          isMutable: false,
          isReference: false,
          isLifetime: false
        });
      } else if (trimmed === '&self') {
        parameters.push({
          name: 'self',
          type: '&Self',
          isMutable: false,
          isReference: true,
          isLifetime: false
        });
      } else if (trimmed === '&mut self') {
        parameters.push({
          name: 'self',
          type: '&mut Self',
          isMutable: true,
          isReference: true,
          isLifetime: false
        });
      } else {
        const paramMatch = trimmed.match(/^(mut\s+)?([A-Za-z_]\w*):\s*(.+)/);
        if (paramMatch) {
          const isMutable = !!paramMatch[1];
          const paramName = paramMatch[2];
          const paramType = paramMatch[3];

          parameters.push({
            name: paramName,
            type: paramType,
            isMutable,
            isReference: paramType.startsWith('&'),
            isLifetime: paramType.includes("'")
          });
        }
      }
    }

    return parameters;
  }

  private parseEnumStructFields(fieldsStr: string): RustField[] {
    const fields: RustField[] = [];
    const fieldParts = fieldsStr.split(',').map(f => f.trim()).filter(f => f);

    for (const field of fieldParts) {
      const fieldMatch = field.match(/(pub\s+)?([A-Za-z_]\w*):\s*(.+)/);
      if (fieldMatch) {
        const isPublic = !!fieldMatch[1];
        const fieldName = fieldMatch[2];
        const fieldType = fieldMatch[3];

        fields.push({
          name: fieldName,
          type: fieldType,
          attributes: [],
          visibility: isPublic ? 'pub' : 'private',
          lineNumber: 0,
          isPublic
        });
      }
    }

    return fields;
  }

  private parseEnumTupleFields(fieldsStr: string): RustField[] {
    const fields: RustField[] = [];
    const fieldTypes = fieldsStr.split(',').map(f => f.trim()).filter(f => f);

    fieldTypes.forEach((type, index) => {
      const isPublic = type.startsWith('pub ');
      const cleanType = isPublic ? type.substring(4) : type;

      fields.push({
        name: index.toString(),
        type: cleanType,
        attributes: [],
        visibility: isPublic ? 'pub' : 'private',
        lineNumber: 0,
        isPublic
      });
    });

    return fields;
  }

  private extractAttributes(lines: string[], lineIndex: number): string[] {
    const attributes: string[] = [];

    for (let i = lineIndex - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line.startsWith('#[')) {
        const attrMatch = line.match(/#\[([^\]]+)\]/);
        if (attrMatch) {
          attributes.unshift(attrMatch[1]);
        }
      } else if (line && !line.startsWith('//')) {
        break;
      }
    }

    return attributes;
  }

  private splitParameters(paramsStr: string): string[] {
    const params: string[] = [];
    let current = '';
    let depth = 0;
    let inAngleBrackets = 0;

    for (const char of paramsStr) {
      if (char === '(') depth++;
      else if (char === ')') depth--;
      else if (char === '<') inAngleBrackets++;
      else if (char === '>') inAngleBrackets--;
      else if (char === ',' && depth === 0 && inAngleBrackets === 0) {
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

  private isInsideImpl(lines: string[], lineIndex: number): boolean {
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
            return lineStr.startsWith('impl ');
          }
        }
      }
    }

    return false;
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
    const frameworkPatterns = {
      actix: ['HttpRequest', 'HttpResponse', 'Result', 'web::'],
      rocket: ['Request', 'Response', 'rocket::', 'routes!'],
      warp: ['Filter', 'Reply', 'warp::'],
      axum: ['Router', 'Handler', 'axum::']
    };

    for (const node of nodes) {
      if (node.type === 'function' && node.metadata?.attributes) {
        const attributes = node.metadata.attributes as string[];

        for (const [framework, patterns] of Object.entries(frameworkPatterns)) {
          if (patterns.some(pattern =>
            attributes.some(attr => attr.includes(pattern)) ||
            (node.metadata?.attributes?.returnType as string)?.includes(pattern) ||
            (node.metadata?.attributes?.parameters as RustParameter[])?.some(p => p.type.includes(pattern))
          )) {
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

  private buildTraitRelationships(nodes: CASNode[], edges: CASEdge[]): void {
    const traitNodes = nodes.filter(n => n.type === 'trait');
    const implNodes = nodes.filter(n => n.type === 'impl');

    for (const implNode of implNodes) {
      const traitName = implNode.metadata?.attributes?.traitName as string;
      const typeName = implNode.metadata?.attributes?.typeName as string;

      if (traitName) {
        const traitNode = traitNodes.find(t => t.name === traitName);
        if (traitNode) {
          edges.push(this.createEdge(
            `${implNode.id}_implements_${traitNode.id}`,
            implNode.id,
            traitNode.id,
            'implements'
          ));
        }
      }

      const typeNode = nodes.find(n =>
        (n.type === 'struct' || n.type === 'enum') && n.name === typeName
      );
      if (typeNode) {
        edges.push(this.createEdge(
          `${implNode.id}_for_${typeNode.id}`,
          implNode.id,
          typeNode.id,
          'implements_for'
        ));
      }
    }

    for (const traitNode of traitNodes) {
      const supertraits = traitNode.metadata?.attributes?.supertraits as string[];
      if (supertraits) {
        for (const supertrait of supertraits) {
          const supertraitNode = traitNodes.find(t => t.name === supertrait);
          if (supertraitNode) {
            edges.push(this.createEdge(
              `${traitNode.id}_extends_${supertraitNode.id}`,
              traitNode.id,
              supertraitNode.id,
              'extends'
            ));
          }
        }
      }
    }
  }

  private getModuleName(filePath: string): string {
    return filePath.replace(/\.rs$/, '').replace(/\//g, '::');
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
      'enum-detection',
      'trait-analysis',
      'impl-block-parsing',
      'function-mapping',
      'module-organization',
      'lifetime-tracking',
      'framework-detection'
    ];
  }
}