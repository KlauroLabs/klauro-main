import { BaseAnalyzer, AnalysisContext } from '../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint,
  CASDocumentation, CASComment, CASTodo, CASImplementationStatus
} from '../../types/cas.types';
import { AnalyzerError } from '../core/errors';
import * as fs from 'fs-extra';
import { glob } from 'glob';
import { ASTRunner, RustASTNode } from '../core/ast-runner';
import * as path from 'path';

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
  private astRunner: ASTRunner;
  private astCache = new Map<string, RustASTNode>();
  private todoCounter = 0;
  private commentCounter = 0;

  constructor() {
    super(
      'rust-analyzer',
      'Rust Language Analyzer',
      '1.0.0',
      'language'
    );
    this.astRunner = new ASTRunner();
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

      await this.analyzeCallGraph(context.projectPath, nodes, edges, exitPoints);

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
      const fileComments = this.extractCommentsFromFile(content, fullPath);
      const fileTodos = this.extractTodosFromComments(fileComments, fullPath);

      nodes.push(this.createNodeBuilder(
        fileId,
        relativePath.split('/').pop() || 'unknown.rs',
        'file'
      )
        .withLevel(1, 'File/Module')
        .withCategory('modules', ['rust-files'])
        .withSource({ file: fullPath, line: 1, end_line: lines.length })
        .withMetadata({
          attributes: {
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
            modCount: mods.length,
            extension: '.rs',
            commentCount: fileComments.length,
            todoCount: fileTodos.length
          }
        })
        .withComments(fileComments.length > 0 ? fileComments : undefined)
        .withTodos(fileTodos.length > 0 ? fileTodos : undefined)
        .build());

      for (const use of uses) {
        const useId = `use_${fileId}_${this.sanitizeId(use.path)}`;
        nodes.push(this.createNodeBuilder(
          useId,
          use.alias || use.path,
          'use'
        )
          .withLevel(2, 'Import/Dependency')
          .withCategory('imports', ['rust-uses'])
          .withSource({ file: fullPath, line: use.lineNumber })
          .withMetadata({
            attributes: {
              path: use.path,
              alias: use.alias,
              isGlob: use.isGlob,
              isExternal: use.isExternal,
              importType: use.isExternal ? 'external' : 'internal'
            }
          })
          .build());

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
        nodes.push(this.createNodeBuilder(
          constantId,
          constant.name,
          'constant'
        )
          .withLevel(3, 'Constant/Property')
          .withCategory('data', ['rust-constants'])
          .withSource({ file: fullPath, line: constant.lineNumber })
          .withMetadata({
            is_exported: constant.isPublic,
            attributes: {
              type: constant.type,
              value: constant.value,
              moduleName: constant.moduleName,
              visibility: constant.visibility,
              rustAttributes: constant.attributes,
              constantType: constant.type
            }
          })
          .build());

        edges.push(this.createEdge(
          `${fileId}_contains_${constantId}`,
          fileId,
          constantId,
          'contains'
        ));
      }

      for (const staticVar of statics) {
        const staticId = `static_${fileId}_${this.sanitizeId(staticVar.name)}`;
        nodes.push(this.createNodeBuilder(
          staticId,
          staticVar.name,
          'static'
        )
          .withLevel(3, 'Static/Property')
          .withCategory('data', ['rust-statics'])
          .withSource({ file: fullPath, line: staticVar.lineNumber })
          .withMetadata({
            is_exported: staticVar.isPublic,
            attributes: {
              type: staticVar.type,
              value: staticVar.value,
              moduleName: staticVar.moduleName,
              visibility: staticVar.visibility,
              isMutable: staticVar.isMutable,
              rustAttributes: staticVar.attributes,
              staticType: staticVar.type
            }
          })
          .build());

        edges.push(this.createEdge(
          `${fileId}_contains_${staticId}`,
          fileId,
          staticId,
          'contains'
        ));
      }

      for (const type of types) {
        const typeId = `type_${fileId}_${this.sanitizeId(type.name)}`;
        nodes.push(this.createNodeBuilder(
          typeId,
          type.name,
          'type'
        )
          .withLevel(3, 'Type/Alias')
          .withCategory('structures', ['rust-types'])
          .withSource({ file: fullPath, line: type.lineNumber })
          .withMetadata({
            is_exported: type.isPublic,
            attributes: {
              underlying: type.underlying,
              moduleName: type.moduleName,
              generics: type.generics,
              visibility: type.visibility,
              rustAttributes: type.attributes,
              aliasType: type.underlying
            }
          })
          .build());

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
    const content = await fs.readFile(fullPath, 'utf-8');
    const structComments = this.extractCommentsFromFile(content, fullPath).filter(c =>
      c.location.line >= struct.lineStart - 3 && c.location.line <= struct.lineStart
    );
    const structTodos = this.extractTodosFromComments(structComments, structId);
    const structDocs = this.extractDocumentationFromRustDoc(
      content.split('\n'),
      struct.lineStart - 1
    );

    nodes.push(this.createNodeBuilder(
      structId,
      struct.name,
      'struct'
    )
      .withLevel(2, 'Class/Interface')
      .withCategory('structures', ['rust-structs'])
      .withSource({ file: fullPath, line: struct.lineStart, end_line: struct.lineEnd })
      .withMetadata({
        is_exported: struct.isPublic,
        attributes: {
          moduleName: struct.moduleName,
          fieldCount: struct.fields.length,
          generics: struct.generics,
          visibility: struct.visibility,
          isUnion: struct.isUnion,
          rustAttributes: struct.attributes,
          hasDocumentation: !!structDocs
        }
      })
      .withDocumentation(structDocs)
      .withComments(structComments.length > 0 ? structComments : undefined)
      .withTodos(structTodos.length > 0 ? structTodos : undefined)
      .build());

    edges.push(this.createEdge(
      `${fileId}_contains_${structId}`,
      fileId,
      structId,
      'contains'
    ));

    for (const field of struct.fields) {
      const fieldId = `field_${structId}_${this.sanitizeId(field.name)}`;
      nodes.push(this.createNodeBuilder(
        fieldId,
        field.name,
        'field'
      )
        .withLevel(4, 'Field/Property')
        .withCategory('data', ['struct-fields'])
        .withSource({ file: fullPath, line: field.lineNumber })
        .withMetadata({
          is_exported: field.isPublic,
          attributes: {
            type: field.type,
            visibility: field.visibility,
            rustAttributes: field.attributes,
            fieldType: field.type
          }
        })
        .withParent(structId)
        .build());

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
    const content = await fs.readFile(fullPath, 'utf-8');
    const enumComments = this.extractCommentsFromFile(content, fullPath).filter(c =>
      c.location.line >= enm.lineStart - 3 && c.location.line <= enm.lineStart
    );
    const enumTodos = this.extractTodosFromComments(enumComments, enumId);
    const enumDocs = this.extractDocumentationFromRustDoc(
      content.split('\n'),
      enm.lineStart - 1
    );

    nodes.push(this.createNodeBuilder(
      enumId,
      enm.name,
      'enum'
    )
      .withLevel(2, 'Enum/Type')
      .withCategory('structures', ['rust-enums'])
      .withSource({ file: fullPath, line: enm.lineStart, end_line: enm.lineEnd })
      .withMetadata({
        is_exported: enm.isPublic,
        attributes: {
          moduleName: enm.moduleName,
          variantCount: enm.variants.length,
          generics: enm.generics,
          visibility: enm.visibility,
          rustAttributes: enm.attributes,
          hasDocumentation: !!enumDocs
        }
      })
      .withDocumentation(enumDocs)
      .withComments(enumComments.length > 0 ? enumComments : undefined)
      .withTodos(enumTodos.length > 0 ? enumTodos : undefined)
      .build());

    edges.push(this.createEdge(
      `${fileId}_contains_${enumId}`,
      fileId,
      enumId,
      'contains'
    ));

    for (const variant of enm.variants) {
      const variantId = `variant_${enumId}_${this.sanitizeId(variant.name)}`;
      nodes.push(this.createNodeBuilder(
        variantId,
        variant.name,
        'enum_variant'
      )
        .withLevel(4, 'Variant/Case')
        .withCategory('data', ['enum-variants'])
        .withSource({ file: fullPath, line: variant.lineNumber })
        .withMetadata({
          attributes: {
            discriminant: variant.discriminant,
            rustAttributes: variant.attributes,
            fieldCount: variant.fields?.length || 0,
            hasFields: !!variant.fields
          }
        })
        .withParent(enumId)
        .build());

      edges.push(this.createEdge(
        `${enumId}_has_variant_${variantId}`,
        enumId,
        variantId,
        'has_variant'
      ));

      if (variant.fields) {
        for (const field of variant.fields) {
          const fieldId = `field_${variantId}_${this.sanitizeId(field.name)}`;
          nodes.push(this.createNodeBuilder(
            fieldId,
            field.name,
            'field'
          )
            .withLevel(5, 'Field/Property')
            .withCategory('data', ['variant-fields'])
            .withSource({ file: fullPath, line: field.lineNumber })
            .withMetadata({
              is_exported: field.isPublic,
              attributes: {
                type: field.type,
                visibility: field.visibility,
                rustAttributes: field.attributes,
                fieldType: field.type
              }
            })
            .withParent(variantId)
            .build());

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
    const content = await fs.readFile(fullPath, 'utf-8');
    const traitComments = this.extractCommentsFromFile(content, fullPath).filter(c =>
      c.location.line >= trait.lineStart - 3 && c.location.line <= trait.lineStart
    );
    const traitTodos = this.extractTodosFromComments(traitComments, traitId);
    const traitDocs = this.extractDocumentationFromRustDoc(
      content.split('\n'),
      trait.lineStart - 1
    );

    nodes.push(this.createNodeBuilder(
      traitId,
      trait.name,
      'trait'
    )
      .withLevel(2, 'Trait/Interface')
      .withCategory('structures', ['rust-traits'])
      .withSource({ file: fullPath, line: trait.lineStart, end_line: trait.lineEnd })
      .withMetadata({
        is_exported: trait.isPublic,
        attributes: {
          moduleName: trait.moduleName,
          methodCount: trait.methods.length,
          associatedTypeCount: trait.associatedTypes.length,
          supertraits: trait.supertraits,
          generics: trait.generics,
          visibility: trait.visibility,
          rustAttributes: trait.attributes,
          hasDocumentation: !!traitDocs
        }
      })
      .withDocumentation(traitDocs)
      .withComments(traitComments.length > 0 ? traitComments : undefined)
      .withTodos(traitTodos.length > 0 ? traitTodos : undefined)
      .build());

    edges.push(this.createEdge(
      `${fileId}_contains_${traitId}`,
      fileId,
      traitId,
      'contains'
    ));

    for (const method of trait.methods) {
      const methodId = `method_${traitId}_${this.sanitizeId(method.name)}_${method.lineStart}`;
      const methodDocs = this.extractDocumentationFromRustDoc(
        content.split('\n'),
        method.lineStart - 1
      );
      const methodComments = this.extractCommentsFromFile(content, fullPath).filter(c =>
        c.location.line >= method.lineStart && c.location.line <= method.lineEnd
      );
      const methodTodos = this.extractTodosFromComments(methodComments, methodId);

      nodes.push(this.createNodeBuilder(
        methodId,
        method.name,
        'trait_method'
      )
        .withLevel(4, 'Method/Function')
        .withCategory('methods', ['trait-methods'])
        .withSource({ file: fullPath, line: method.lineStart, end_line: method.lineEnd })
        .withMetadata({
          is_exported: method.isPublic,
          attributes: {
            generics: method.generics,
            visibility: method.visibility,
            isSelf: method.isSelf,
            isMutSelf: method.isMutSelf,
            isStatic: method.isStatic,
            isAsync: method.isAsync,
            isUnsafe: method.isUnsafe,
            isConst: method.isConst,
            rustAttributes: method.attributes,
            hasDocumentation: !!methodDocs
          }
        })
        .withSignature({
          parameters: method.parameters,
          return_type: method.returnType
        })
        .withParent(traitId)
        .withDocumentation(methodDocs)
        .withComments(methodComments.length > 0 ? methodComments : undefined)
        .withTodos(methodTodos.length > 0 ? methodTodos : undefined)
        .build());

      edges.push(this.createEdge(
        `${traitId}_declares_${methodId}`,
        traitId,
        methodId,
        'declares'
      ));
    }

    for (const assocType of trait.associatedTypes) {
      const assocTypeId = `assoc_type_${traitId}_${this.sanitizeId(assocType.name)}`;
      nodes.push(this.createNodeBuilder(
        assocTypeId,
        assocType.name,
        'associated_type'
      )
        .withLevel(4, 'Type/Association')
        .withCategory('structures', ['associated-types'])
        .withSource({ file: fullPath, line: assocType.lineNumber })
        .withMetadata({
          attributes: {
            bounds: assocType.bounds,
            defaultType: assocType.defaultType,
            hasBounds: assocType.bounds.length > 0,
            hasDefault: !!assocType.defaultType
          }
        })
        .withParent(traitId)
        .build());

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
    const content = await fs.readFile(fullPath, 'utf-8');
    const implComments = this.extractCommentsFromFile(content, fullPath).filter(c =>
      c.location.line >= impl.lineStart - 3 && c.location.line <= impl.lineStart
    );
    const implTodos = this.extractTodosFromComments(implComments, implId);
    const implDocs = this.extractDocumentationFromRustDoc(
      content.split('\n'),
      impl.lineStart - 1
    );

    nodes.push(this.createNodeBuilder(
      implId,
      `impl ${impl.traitName || ''} for ${impl.typeName}`.trim(),
      'impl'
    )
      .withLevel(2, 'Implementation')
      .withCategory('structures', ['rust-impls'])
      .withSource({ file: fullPath, line: impl.lineStart, end_line: impl.lineEnd })
      .withMetadata({
        attributes: {
          traitName: impl.traitName,
          typeName: impl.typeName,
          moduleName: impl.moduleName,
          methodCount: impl.methods.length,
          generics: impl.generics,
          whereClause: impl.whereClause,
          implementsTrait: !!impl.traitName,
          hasDocumentation: !!implDocs
        }
      })
      .withDocumentation(implDocs)
      .withComments(implComments.length > 0 ? implComments : undefined)
      .withTodos(implTodos.length > 0 ? implTodos : undefined)
      .build());

    edges.push(this.createEdge(
      `${fileId}_contains_${implId}`,
      fileId,
      implId,
      'contains'
    ));

    for (const method of impl.methods) {
      const methodId = `method_${implId}_${this.sanitizeId(method.name)}_${method.lineStart}`;
      const methodDocs = this.extractDocumentationFromRustDoc(
        content.split('\n'),
        method.lineStart - 1
      );
      const methodComments = this.extractCommentsFromFile(content, fullPath).filter(c =>
        c.location.line >= method.lineStart && c.location.line <= method.lineEnd
      );
      const methodTodos = this.extractTodosFromComments(methodComments, methodId);
      const lines = content.split('\n');
      const methodBody = lines.slice(method.lineStart - 1, method.lineEnd);
      const implementationStatus = this.detectImplementationStatus({
        name: method.name,
        attributes: method.attributes,
        moduleName: impl.moduleName,
        filePath: fullPath,
        parameters: method.parameters,
        returnType: method.returnType,
        generics: method.generics,
        visibility: method.visibility,
        lineStart: method.lineStart,
        lineEnd: method.lineEnd,
        isPublic: method.isPublic,
        isMain: false,
        isTest: method.attributes.includes('test'),
        isAsync: method.isAsync,
        isUnsafe: method.isUnsafe,
        isConst: method.isConst
      }, methodBody);

      nodes.push(this.createNodeBuilder(
        methodId,
        method.name,
        'method'
      )
        .withLevel(4, 'Method/Function')
        .withCategory('methods', ['impl-methods'])
        .withSource({ file: fullPath, line: method.lineStart, end_line: method.lineEnd })
        .withMetadata({
          is_exported: method.isPublic,
          attributes: {
            generics: method.generics,
            visibility: method.visibility,
            isSelf: method.isSelf,
            isMutSelf: method.isMutSelf,
            isStatic: method.isStatic,
            isAsync: method.isAsync,
            isUnsafe: method.isUnsafe,
            isConst: method.isConst,
            rustAttributes: method.attributes,
            hasDocumentation: !!methodDocs
          }
        })
        .withSignature({
          parameters: method.parameters,
          return_type: method.returnType
        })
        .withParent(implId)
        .withDocumentation(methodDocs)
        .withComments(methodComments.length > 0 ? methodComments : undefined)
        .withTodos(methodTodos.length > 0 ? methodTodos : undefined)
        .withImplementationStatus(implementationStatus)
        .build());

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
    const content = await fs.readFile(fullPath, 'utf-8');
    const lines = content.split('\n');
    const functionComments = this.extractCommentsFromFile(content, fullPath).filter(c =>
      c.location.line >= func.lineStart - 3 && c.location.line <= func.lineStart
    );
    const functionTodos = this.extractTodosFromComments(functionComments, functionId);
    const functionDocs = this.extractDocumentationFromRustDoc(lines, func.lineStart - 1);
    const functionBody = lines.slice(func.lineStart - 1, func.lineEnd);
    const implementationStatus = this.detectImplementationStatus(func, functionBody);

    nodes.push(this.createNodeBuilder(
      functionId,
      func.name,
      'function'
    )
      .withLevel(3, 'Function/Method')
      .withCategory('functions', ['standalone-functions'])
      .withSource({ file: fullPath, line: func.lineStart, end_line: func.lineEnd })
      .withMetadata({
        is_exported: func.isPublic,
        attributes: {
          moduleName: func.moduleName,
          generics: func.generics,
          visibility: func.visibility,
          isMain: func.isMain,
          isTest: func.isTest,
          isAsync: func.isAsync,
          isUnsafe: func.isUnsafe,
          isConst: func.isConst,
          rustAttributes: func.attributes,
          hasDocumentation: !!functionDocs
        }
      })
      .withSignature({
        parameters: func.parameters,
        return_type: func.returnType
      })
      .withDocumentation(functionDocs)
      .withComments(functionComments.length > 0 ? functionComments : undefined)
      .withTodos(functionTodos.length > 0 ? functionTodos : undefined)
      .withImplementationStatus(implementationStatus)
      .build());

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

      nodes.push(this.createNodeBuilder(
        moduleId,
        moduleName,
        'module'
      )
        .withLevel(1, 'Module/Package')
        .withCategory('modules', ['rust-modules'])
        .withMetadata({
          attributes: {
            fileCount: files.length,
            files: files,
            moduleType: moduleName === 'main' ? 'executable' : 'library'
          }
        })
        .build());

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

  private extractModuleName(file: string): string {
    return this.getModuleName(file);
  }

  private async analyzeCallGraph(projectPath: string, nodes: CASNode[], edges: CASEdge[], exitPoints: CASExitPoint[]): Promise<void> {
    const rustFiles = await glob(['**/*.rs'], {
      cwd: projectPath,
      ignore: ['**/target/**', '**/.git/**']
    });

    const functionNodes = nodes.filter(n => n.type === 'function' || n.type === 'method' || n.type === 'trait_method');
    const structNodes = nodes.filter(n => n.type === 'struct' || n.type === 'enum' || n.type === 'trait');
    const implNodes = nodes.filter(n => n.type === 'impl');

    for (const file of rustFiles) {
      const fullPath = path.join(projectPath, file);

      const ast = await this.astRunner.parseRustAST(fullPath);
      if (!ast) {
        await this.analyzeCallGraphFallback(fullPath, file, nodes, edges, exitPoints, functionNodes, structNodes, projectPath);
        continue;
      }

      this.astCache.set(file, ast);
      const currentModule = this.getModuleName(file);

      for (const child of ast.children || []) {
        if ((child.kind === 'Function' || child.kind === 'Method') && child.calls) {
          const callerFunction = functionNodes.find(n =>
            n.name === child.name &&
            n.source?.file === fullPath
          );

          if (!callerFunction) continue;

          for (const call of child.calls) {
            let targetFunction: CASNode | undefined;

            if (call.module) {
              targetFunction = functionNodes.find(n =>
                n.name === call.function &&
                (n.type === 'method' || n.metadata?.attributes?.module === call.module)
              );

              if (!targetFunction) {
                const targetStruct = structNodes.find(s => s.name === call.module);
                if (targetStruct) {
                  targetFunction = functionNodes.find(n =>
                    n.name === call.function &&
                    edges.some(e => e.source === targetStruct.id && e.target === n.id &&
                              (e.type === 'has_method' || e.type === 'implements'))
                  );
                }
              }
            } else {
              targetFunction = functionNodes.find(n =>
                n.name === call.function &&
                n.type === 'function'
              );
            }

            if (targetFunction && targetFunction.id !== callerFunction.id) {
              const callEdgeId = `call_${callerFunction.id}_to_${targetFunction.id}_line_${call.line}`;
              if (!edges.some(e => e.id === callEdgeId)) {
                edges.push(this.createEdge(
                  callEdgeId,
                  callerFunction.id,
                  targetFunction.id,
                  'calls',
                  'behavior',
                  {
                    line: call.line,
                    callType: call.module ? 'method' : 'function',
                    targetModule: call.module,
                    targetFunction: call.function
                  }
                ));
              }
            } else if (this.isExternalLibraryCall(call.module || call.function, call.module ? call.function : undefined, currentModule)) {
              const exitId = `exit_call_${callerFunction.id}_${call.module || ''}_${call.function}_${call.line}`;
              if (!exitPoints.some(e => e.id === exitId)) {
                exitPoints.push(this.createExitPoint(
                  exitId,
                  callerFunction.id,
                  'sdk',
                  call.module ? `External call: ${call.module}::${call.function}` : `External call: ${call.function}`,
                  `Library call to ${this.identifyRustLibrary(call.module || call.function)}`,
                  undefined,
                  undefined,
                  {
                    targetModule: call.module || call.function,
                    targetFunction: call.function,
                    line: call.line,
                    library: this.identifyRustLibrary(call.module || call.function)
                  }
                ));
              }
            }
          }
        }
      }
    }
  }

  private async analyzeCallGraphFallback(
    fullPath: string,
    file: string,
    nodes: CASNode[],
    edges: CASEdge[],
    exitPoints: CASExitPoint[],
    functionNodes: CASNode[],
    structNodes: CASNode[],
    projectPath: string
  ): Promise<void> {
    const content = await fs.readFile(fullPath, 'utf-8');
    const lines = content.split('\n');
    const currentModule = this.getModuleName(file);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      const functionCalls = [
        ...Array.from(line.matchAll(/(\w+)\s*\(/g)),
        ...Array.from(line.matchAll(/(\w+)::(\w+)\s*\(/g)),
        ...Array.from(line.matchAll(/self\.(\w+)\s*\(/g)).map(m => [m[0], 'self', m[1]]),
        ...Array.from(line.matchAll(/Self::(\w+)\s*\(/g)).map(m => [m[0], 'Self', m[1]])
      ];

        for (const match of functionCalls) {
          const fullMatch = match[0];
          const objectOrFunc = match[1];
          const functionName = match[2];

          const callerFunction = functionNodes.find(n =>
            n.source?.file === fullPath &&
            n.source?.line !== undefined && n.source.line <= i + 1 &&
            n.source?.end_line !== undefined && n.source.end_line >= i + 1
          );

          if (callerFunction) {
            let targetFunction: CASNode | undefined;

            if (objectOrFunc === 'self' || objectOrFunc === 'Self') {
              const containingStruct = structNodes.find(s =>
                edges.some(e => e.source === s.id && e.target === callerFunction.id &&
                          (e.type === 'has_method' || e.type === 'implements'))
              );

              if (containingStruct) {
                targetFunction = functionNodes.find(n =>
                  n.name === functionName &&
                  edges.some(e => e.source === containingStruct.id && e.target === n.id &&
                            (e.type === 'has_method' || e.type === 'implements'))
                );
              }
            } else if (functionName) {
              const targetStruct = structNodes.find(s => s.name === objectOrFunc);
              if (targetStruct) {
                targetFunction = functionNodes.find(n =>
                  n.name === functionName &&
                  edges.some(e => e.source === targetStruct.id && e.target === n.id &&
                            (e.type === 'has_method' || e.type === 'implements'))
                );
              }
            } else {
              targetFunction = functionNodes.find(n => n.name === objectOrFunc);
            }

            if (targetFunction) {
              const callEdgeId = `call_${callerFunction.id}_to_${targetFunction.id}_${i}`;
              if (!edges.some(e => e.id === callEdgeId)) {
                edges.push(this.createEdge(
                  callEdgeId,
                  callerFunction.id,
                  targetFunction.id,
                  'calls',
                  'behavior',
                  {
                    line: i + 1,
                    callType: objectOrFunc === 'self' ? 'self' :
                             objectOrFunc === 'Self' ? 'associated' :
                             functionName ? 'method' : 'function'
                  }
                ));
              }
            } else if (this.isExternalLibraryCall(objectOrFunc, functionName, currentModule)) {
              const exitId = `exit_call_${callerFunction.id}_${objectOrFunc}_${functionName || 'func'}_${i}`;
              if (!exitPoints.some(e => e.id === exitId)) {
                exitPoints.push(this.createExitPoint(
                  exitId,
                  callerFunction.id,
                  'sdk',
                  functionName ? `External call: ${objectOrFunc}::${functionName}` : `External call: ${objectOrFunc}`,
                  `Library call to ${this.identifyRustLibrary(objectOrFunc)}`,
                  undefined,
                  undefined,
                  {
                    targetModule: objectOrFunc,
                    targetFunction: functionName || objectOrFunc,
                    line: i + 1,
                    library: this.identifyRustLibrary(objectOrFunc)
                  }
                ));
              }
            }
          }
        }

        // TODO: Fix macro processing scope issue - temporarily disabled

        const routeAttributes = [
          ...Array.from(line.matchAll(/#\[(?:get|post|put|delete|patch)\s*\(\s*["']([^"']+)["']\s*\)\]/g)),
          ...Array.from(line.matchAll(/#\[route\s*\(\s*["']([^"']+)["']\s*,\s*method\s*=\s*"(\w+)"\s*\)\]/g))
        ];

        for (const route of routeAttributes) {
          const path = route[1];
          const method = route[2] || route[0].match(/#\[(\w+)/)?.[1]?.toUpperCase();

          const nextFunctionLine = this.findNextFunctionDeclaration(lines, i);
          if (nextFunctionLine !== -1) {
            const functionAtLine = functionNodes.find(n =>
              n.source?.file === fullPath &&
              n.source?.line === nextFunctionLine + 1
            );

            if (functionAtLine && method) {
              const endpointEdgeId = `http_endpoint_${functionAtLine.id}_${method}_${i}`;
              if (!edges.some(e => e.id === endpointEdgeId)) {
                edges.push(this.createEdge(
                  endpointEdgeId,
                  `entry_${functionAtLine.id}`,
                  functionAtLine.id,
                  'exposes',
                  'behavior',
                  {
                    httpMethod: method,
                    path,
                    framework: this.detectWebFramework(content)
                  }
                ));
              }
            }
          }
        }
      }
    }

  private findNextFunctionDeclaration(lines: string[], startIndex: number): number {
    for (let i = startIndex + 1; i < lines.length; i++) {
      if (lines[i].trim().match(/^(pub\s+)?fn\s+\w+/)) {
        return i;
      }
    }
    return -1;
  }

  private isExternalLibraryCall(moduleOrFunc: string, functionName: string | undefined, currentModule: string): boolean {
    const stdModules = [
      'std', 'core', 'alloc', 'collections', 'env', 'fmt', 'fs', 'io',
      'mem', 'net', 'ops', 'os', 'path', 'process', 'sync', 'thread',
      'time', 'vec', 'HashMap', 'Vec', 'String', 'Option', 'Result'
    ];

    const commonCrates = [
      'tokio', 'async_std', 'futures', 'serde', 'serde_json', 'reqwest',
      'hyper', 'actix', 'actix_web', 'rocket', 'warp', 'axum', 'diesel',
      'sqlx', 'redis', 'mongodb', 'log', 'tracing', 'anyhow', 'thiserror'
    ];

    return stdModules.includes(moduleOrFunc) ||
           commonCrates.includes(moduleOrFunc) ||
           moduleOrFunc.startsWith('std::') ||
           moduleOrFunc.startsWith('core::') ||
           (moduleOrFunc.includes('::') && !moduleOrFunc.startsWith(currentModule));
  }

  private isStandardMacro(macroName: string): boolean {
    const standardMacros = [
      'println', 'print', 'eprintln', 'eprint', 'format', 'panic',
      'assert', 'assert_eq', 'assert_ne', 'debug_assert', 'todo',
      'unimplemented', 'unreachable', 'vec', 'include', 'include_str'
    ];
    return standardMacros.includes(macroName);
  }

  private identifyRustLibrary(moduleName: string): string {
    const stdLibraries: Record<string, string> = {
      'std': 'Rust Standard Library',
      'core': 'Rust Core Library',
      'alloc': 'Rust Allocation Library',
      'collections': 'Rust Collections',
      'io': 'Rust I/O',
      'fs': 'Rust File System',
      'net': 'Rust Networking',
      'sync': 'Rust Synchronization',
      'thread': 'Rust Threading',
      'tokio': 'Tokio Async Runtime',
      'async_std': 'Async-std Runtime',
      'actix': 'Actix Framework',
      'actix_web': 'Actix Web Framework',
      'rocket': 'Rocket Framework',
      'warp': 'Warp Framework',
      'axum': 'Axum Framework',
      'serde': 'Serde Serialization',
      'diesel': 'Diesel ORM',
      'sqlx': 'SQLx Database Library'
    };

    if (stdLibraries[moduleName]) {
      return stdLibraries[moduleName];
    }

    if (moduleName.startsWith('std::')) {
      return 'Rust Standard Library';
    }

    if (moduleName.startsWith('core::')) {
      return 'Rust Core Library';
    }

    return 'External Crate';
  }

  private identifyMacroSource(macroName: string): string {
    const macroSources: Record<string, string> = {
      'println': 'std::print',
      'format': 'std::format',
      'vec': 'std::vec',
      'assert': 'std::assert',
      'panic': 'std::panic',
      'todo': 'std::todo',
      'derive': 'proc_macro',
      'async_trait': 'async-trait crate',
      'tokio::main': 'tokio runtime',
      'rocket::launch': 'rocket framework'
    };

    return macroSources[macroName] || 'Rust Macro';
  }

  private detectWebFramework(content: string): string {
    if (content.includes('actix_web')) return 'Actix-Web';
    if (content.includes('rocket::')) return 'Rocket';
    if (content.includes('warp::')) return 'Warp';
    if (content.includes('axum::')) return 'Axum';
    if (content.includes('hyper::')) return 'Hyper';
    return 'Unknown';
  }

  private extractDocumentationFromRustDoc(lines: string[], lineIndex: number): CASDocumentation | undefined {
    let hasContent = false;
    let description = '';

    for (let i = lineIndex - 1; i >= 0; i--) {
      const line = lines[i].trim();

      if (line.startsWith('///')) {
        const commentText = line.replace(/^\/\/\/\s*/, '');
        if (commentText) {
          description = commentText + (description ? '\n' + description : '');
          hasContent = true;
        }
      } else if (line.startsWith('//!')) {
        const commentText = line.replace(/^\/\/!\s*/, '');
        if (commentText) {
          description = commentText + (description ? '\n' + description : '');
          hasContent = true;
        }
      } else if (!line.startsWith('//') && line !== '') {
        break;
      }
    }

    if (hasContent) {
      const docs: CASDocumentation = {
        type: 'rustdoc',
        raw: description,
        location: { start_line: lineIndex - description.split('\n').length, end_line: lineIndex }
      };

      docs.summary = description.split('.')[0] + (description.includes('.') ? '.' : '');
      docs.description = description;

      const exampleMatch = description.match(/# Examples?\s*(.*?)(?=\n#|$)/is);
      if (exampleMatch) {
        docs.examples = [{ code: exampleMatch[1].trim(), language: 'rust' }];
      }

      const panicMatch = description.match(/# Panics?\s*(.*?)(?=\n#|$)/is);
      if (panicMatch) {
        if (!docs.exceptions) docs.exceptions = [];
        docs.exceptions.push({
          type: 'panic',
          description: panicMatch[1].trim()
        });
      }

      return docs;
    }

    return undefined;
  }

  private extractCommentsFromFile(content: string, filePath: string): CASComment[] {
    const comments: CASComment[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      const singleLineMatch = line.match(/\/\/(.*)$/);
      if (singleLineMatch && !line.trim().startsWith('///') && !line.trim().startsWith('//!')) {
        const text = singleLineMatch[1].trim();
        const purpose = this.classifyCommentPurpose(text);
        comments.push({
          id: `comment_${++this.commentCounter}`,
          type: 'single-line',
          style: '//',
          text,
          purpose,
          location: {
            file: filePath,
            line: i + 1,
            relative_to: 'inline'
          },
          markers: this.extractCommentMarkers(text)
        });
      }

      if (line.includes('/*')) {
        let multiLineText = '';
        let endLine = i;
        let foundEnd = false;

        for (let j = i; j < lines.length; j++) {
          const currentLine = lines[j];
          if (j === i) {
            const startMatch = currentLine.match(/\/\*(.*)/);
            if (startMatch) {
              multiLineText = startMatch[1];
              if (currentLine.includes('*/')) {
                multiLineText = multiLineText.replace(/\*\/.*$/, '').trim();
                foundEnd = true;
                endLine = j;
              }
            }
          } else {
            if (currentLine.includes('*/')) {
              multiLineText += '\n' + currentLine.replace(/\*\/.*$/, '').replace(/^\s*\*/, '').trim();
              foundEnd = true;
              endLine = j;
              break;
            } else {
              multiLineText += '\n' + currentLine.replace(/^\s*\*/, '').trim();
            }
          }
        }

        if (foundEnd) {
          const purpose = this.classifyCommentPurpose(multiLineText);
          comments.push({
            id: `comment_${++this.commentCounter}`,
            type: 'multi-line',
            style: '/* */',
            text: multiLineText.trim(),
            purpose,
            location: {
              file: filePath,
              line: i + 1,
              end_line: endLine + 1,
              relative_to: 'above'
            },
            markers: this.extractCommentMarkers(multiLineText)
          });
          i = endLine;
        }
      }
    }

    return comments;
  }

  private classifyCommentPurpose(text: string): CASComment['purpose'] {
    const lowerText = text.toLowerCase();

    if (/\b(todo|fixme|hack|warning|note|xxx|optimize|refactor)\b/.test(lowerText)) {
      return 'todo';
    }
    if (/\b(warning|warn|caution|danger|important)\b/.test(lowerText)) {
      return 'warning';
    }
    if (/\b(note|info|tip|hint)\b/.test(lowerText)) {
      return 'note';
    }
    if (/\b(hack|temp|temporary|quick|dirty)\b/.test(lowerText)) {
      return 'hack';
    }

    return 'explanation';
  }

  private extractCommentMarkers(text: string): CASComment['markers'] {
    const markers: CASComment['markers'] = {};
    const lowerText = text.toLowerCase();

    markers.is_todo = /\btodo\b/.test(lowerText);
    markers.is_fixme = /\bfixme\b/.test(lowerText);
    markers.is_hack = /\bhack\b/.test(lowerText);
    markers.is_warning = /\b(warning|warn)\b/.test(lowerText);
    markers.is_note = /\b(note|info)\b/.test(lowerText);
    markers.is_important = /\b(important|critical|urgent)\b/.test(lowerText);
    markers.is_deprecated = /\b(deprecated|obsolete)\b/.test(lowerText);

    return markers;
  }

  private extractTodosFromComments(comments: CASComment[], context: string): CASTodo[] {
    const todos: CASTodo[] = [];

    comments.forEach(comment => {
      if (comment.markers?.is_todo || comment.markers?.is_fixme || comment.markers?.is_hack) {
        const typeMatch = comment.text.match(/\b(TODO|FIXME|HACK|NOTE|WARNING|XXX|OPTIMIZE|REFACTOR)\b/i);
        const type = typeMatch ? typeMatch[0].toUpperCase() as CASTodo['type'] : 'TODO';

        const assigneeMatch = comment.text.match(/\b(?:TODO|FIXME|HACK)\s*\(([^)]+)\)/);
        const assignee = assigneeMatch ? assigneeMatch[1] : undefined;

        const priority = comment.markers?.is_important ? 'high' :
                        comment.markers?.is_fixme ? 'medium' : 'low';

        const category = this.categorizeTodo(comment.text);

        todos.push({
          id: `todo_${++this.todoCounter}`,
          type,
          text: comment.text,
          priority,
          assignee,
          category,
          location: {
            file: comment.location.file,
            line: comment.location.line,
            context
          },
          metadata: {
            source: 'comment',
            comment_type: comment.type
          }
        });
      }
    });

    return todos;
  }

  private categorizeTodo(text: string): CASTodo['category'] {
    const lowerText = text.toLowerCase();

    if (/\b(fix|bug|error|issue|broken)\b/.test(lowerText)) return 'bug';
    if (/\b(feature|add|implement|new)\b/.test(lowerText)) return 'feature';
    if (/\b(refactor|clean|improve|restructure)\b/.test(lowerText)) return 'refactor';
    if (/\b(performance|optimize|speed|slow)\b/.test(lowerText)) return 'performance';
    if (/\b(security|secure|auth|permission)\b/.test(lowerText)) return 'security';

    return 'general';
  }

  private detectImplementationStatus(functionInfo: RustFunction, functionBody: string[]): CASImplementationStatus {
    const bodyText = functionBody.join('\n').toLowerCase();

    const indicators = {
      has_not_implemented_exceptions: bodyText.includes('todo!()') || bodyText.includes('unimplemented!()') || bodyText.includes('unreachable!()'),
      has_deprecated_markers: functionInfo.attributes.some(attr => attr.includes('deprecated')),
      has_todo_markers: bodyText.includes('todo') || bodyText.includes('fixme'),
      has_stub_returns: functionBody.length <= 2 && bodyText.includes('return'),
      has_empty_body: functionBody.length <= 1 || bodyText.trim() === '{}',
      has_placeholder_code: bodyText.includes('println!(\"todo'),
      has_hardcoded_values: false,
      has_commented_out_code: false
    };

    let status: CASImplementationStatus['status'] = 'complete';
    if (indicators.has_not_implemented_exceptions) {
      status = 'not-implemented';
    } else if (indicators.has_deprecated_markers) {
      status = 'deprecated';
    } else if (indicators.has_stub_returns || indicators.has_empty_body) {
      status = 'stub';
    } else if (indicators.has_todo_markers || indicators.has_placeholder_code) {
      status = 'partial';
    }

    return {
      status,
      indicators,
      completeness: status === 'complete' ? { estimated_percentage: 100 } :
                   status === 'partial' ? { estimated_percentage: 60 } :
                   status === 'stub' ? { estimated_percentage: 10 } :
                   { estimated_percentage: 0 }
    };
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