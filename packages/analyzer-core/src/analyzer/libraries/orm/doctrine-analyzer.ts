import { BaseAnalyzer, AnalysisContext, FileAnalysisContext } from '../../core/base-analyzer';
import { CASNode, CASEdge, CASContribution, FileAnalysisResult } from '../../../types/cas.types';
import * as path from 'path';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../../core/glob-cache';

type DoctrineRelationKind = 'OneToMany' | 'ManyToOne' | 'ManyToMany' | 'OneToOne';

interface DoctrineField {
  name: string;
  type: string;
  nullable: boolean;
  unique: boolean;
  primary: boolean;
  generated: boolean;
  embedded: boolean;
  line: number;
}

interface DoctrineRelationField {
  name: string;
  kind: DoctrineRelationKind;
  targetEntity: string;
  mappedBy?: string;
  inversedBy?: string;
  line: number;
}

interface DoctrineEntity {
  className: string;
  namespace: string;
  tableName?: string;
  repositoryClass?: string;
  fields: DoctrineField[];
  relations: DoctrineRelationField[];
  lifecycleCallbacks: string[];
  filePath: string;
  line: number;
  evidenceKind: 'attribute' | 'annotation';
}

interface DoctrineWriteSite {
  op: 'persist' | 'remove';
  action: 'insert' | 'update' | 'delete';
  entityName: string;
  filePath: string;
  line: number;
  via: string;
}

interface OrmAttributeMatch {
  name: string;
  args: string;
}

/** A `trait Xxx { ... }` declaration found anywhere in the project, resolved
 *  once up front so any entity class that `use`s it can pull in ORM
 *  fields/relations declared INSIDE the trait (e.g. a shared
 *  `ConnectionBindTrait` that carries the `#[ManyToOne(targetEntity:
 *  Connection::class)] protected $connection` relation every *ConnectionBind
 *  subclass inherits — invisible to a parser that only walks the class's own
 *  body). `content`/`bodyOffset` are the TRAIT'S OWN file/offset, kept
 *  separate from the entity class's, so line numbers resolved from
 *  `collectPrecedingAttributeText` stay correct. */
interface DoctrineTraitInfo {
  content: string;
  body: string;
  bodyOffset: number;
}

/**
 * Doctrine ORM analyzer. Must parse via a bracket-balanced attribute-group
 * collector (collectPrecedingAttributeText), not adjacency regex — real
 * Doctrine code commonly uses the PHP 8 grouped attribute form (multi-line
 * `#[...]` groups) and stacks unrelated attribute groups between a field's ORM
 * attribute and its visibility modifier, both of which a simple adjacency
 * check misses. Supports both PHP 8 attribute syntax and legacy `@ORM\Xxx(...)`
 * docblock annotations through the same code path.
 *
 * Node conventions mirror TypeORMAnalyzer: entity nodes are type 'entity',
 * level 3, id `entity_doctrine_<name>`, with embedded fields[] metadata.
 * Cross-entity relations become `references` edges, database-category.
 * persist()/remove() call sites become database-category exit points plus
 * creates/updates/deletes edges into the entity node, using the same
 * write-edge vocabulary orchestrator.buildDataEntities()/data-lineage.ts
 * already recognize. Repository-binding resolution is intentionally not
 * duplicated here — that lives in PHPAnalyzer's PhpTypeIndex; this analyzer
 * owns the entity/field/relation/write-fact layer only.
 */
export class DoctrineAnalyzer extends BaseAnalyzer {
  constructor() {
    super('doctrine', 'Doctrine ORM Analyzer', '1.0.0', 'library');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    const composerPath = path.join(projectPath, 'composer.json');
    if (await fs.pathExists(composerPath)) {
      try {
        const composerJson = await fs.readJson(composerPath);
        const allDeps: Record<string, string> = {
          ...composerJson.require,
          ...composerJson['require-dev']
        };
        if (Object.keys(allDeps).some(dep => dep.toLowerCase().startsWith('doctrine/'))) {
          return true;
        }
      } catch {
        // ignore unreadable/invalid composer.json
      }
    }

    const ignorePatterns = ['vendor/**', '**/vendor/**'];
    const sourceFiles = this.sortFiles(await glob('**/*.php', {
      cwd: projectPath,
      ignore: ignorePatterns,
      absolute: true,
      nodir: true
    }));

    for (const file of sourceFiles.slice(0, 400)) {
      try {
        const content = await fs.readFile(file, 'utf-8');
        if (/ORM\\Entity\b|@ORM\\Entity\b/.test(content)) {
          return true;
        }
      } catch {
        // ignore unreadable files
      }
    }

    return false;
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const exitPoints: CASContribution['exit_points'] = [];

    const ignorePatterns = this.getIgnorePatterns(context);
    // Sorted before the read fan-out below. Root cause lives in glob-cache.ts
    // (cachedGlob now sorts its result unconditionally, including outside an
    // orchestrator beginGlobRun/endGlobRun window — see its NO-TOKEN
    // DETERMINISM note), so this sort is belt-and-suspenders: it keeps
    // fileContents' insertion order — which drives entity/write-site
    // discovery order, which drives node/edge/exit-point emission order —
    // deterministic locally, independent of whether a future caller bypasses
    // or changes the shared glob cache.
    const sourceFiles = this.sortFiles(await glob('**/*.php', {
      cwd: context.projectPath,
      ignore: ignorePatterns,
      absolute: true,
      nodir: true
    }));

    const entities: DoctrineEntity[] = [];
    const fileContents = new Map<string, string>();

    // Pass 0: read every PHP file's content once. Needed up front (not
    // interleaved with entity parsing) so the trait registry below sees
    // trait declarations regardless of which file is scanned first — a
    // `ConnectionBindTrait` used by `DeviceConnectionBind.php` commonly lives
    // in a different directory (src/Model/Connection/) than the entity that
    // consumes it.
    for (const file of sourceFiles) {
      let content: string;
      try {
        content = await fs.readFile(file, 'utf-8');
      } catch {
        continue;
      }
      fileContents.set(file, content);
    }

    // Every `trait Xxx { ... }` declaration in the project, keyed by trait
    // name. A class's OWN ORM attributes only cover properties declared
    // directly in its body — properties declared inside a `use`d trait
    // (a common Symfony/Doctrine idiom for shared bind/audit columns) are
    // invisible to a body-only scan without this.
    const traitInfoByName = this.collectTraitInfo(fileContents);

    // Pass 1: parse every Doctrine entity in the project. Needed up front
    // (not per-file) because relation targetEntity resolution and write-site
    // entity binding both need the FULL project-wide entity name set.
    for (const [file, content] of fileContents) {
      if (!/ORM\\Entity\b|@ORM\\Entity\b/.test(content)) {
        continue;
      }
      const relativePath = path.relative(context.projectPath, file);
      entities.push(...this.parseEntities(content, relativePath, traitInfoByName));
    }

    // Emission order is a pure function of WHAT was found, never of the order
    // it was discovered in — the file list above is already sorted, and this
    // keeps that property local to the analyzer rather than dependent on a
    // distant glob contract.
    this.sortEntities(entities);
    this.emitEntityGraph(entities, nodes, edges);

    // Pass 2: scan every PHP file (not just entity files) for
    // persist()/remove() write call sites, bound to a known entity name.
    //
    // NOT gated on `EntityManagerInterface`/`getEntityManager()` being
    // visible in the SAME file: the dominant real-world Symfony/Doctrine
    // idiom (Symfony's own recommended practice, and what a benchmarked
    // Symfony repo's BaseRepository does) wraps the EntityManager in domain-repository
    // `persist()`/`remove()` methods, so the actual call sites live in
    // SERVICE classes that call `$this->bookingRepository->persist($booking)`
    // and never mention EntityManagerInterface at all. Requiring that import
    // in the caller's own file would silently drop nearly every real write
    // site. The `->persist(`/`->remove(` substring check below is just a
    // cheap pre-filter; the actual evidence gate is the entity-name BINDING
    // in extractWriteSites (inline `new Entity(...)`, a locally-constructed
    // variable, a typed parameter, or a `ServiceEntityRepository`-scoped
    // fallback) — a call site with none of those produces no fact.
    const knownEntityNames = new Set(entities.map(e => e.className));
    const writeSites: DoctrineWriteSite[] = [];
    for (const [file, content] of fileContents) {
      if (!/->persist\s*\(|->remove\s*\(/.test(content)) {
        continue;
      }
      const relativePath = path.relative(context.projectPath, file);
      writeSites.push(...this.extractWriteSites(content, relativePath, knownEntityNames));
    }

    this.sortWriteSites(writeSites);
    exitPoints.push(...this.emitWriteFacts(writeSites, entities, nodes, edges));

    return this.createContribution(nodes, edges, [], exitPoints, {
      orm: 'Doctrine',
      entitiesFound: entities.length,
      relationshipsFound: edges.filter(e => e.type === 'references').length,
      writeSitesFound: writeSites.length
    });
  }

  supportsIncrementalAnalysis(): boolean {
    return true;
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    let sourceFiles: string[] = [];
    try {
      sourceFiles = await glob('**/*.php', {
        cwd: projectPath,
        ignore: this.getIgnorePatterns({ projectPath }),
        nodir: true
      });
    } catch {
      return [];
    }

    const relevant: string[] = [];
    for (const file of sourceFiles) {
      let content: string;
      try {
        content = await fs.readFile(path.join(projectPath, file), 'utf-8');
      } catch {
        continue;
      }
      if (/ORM\\Entity\b|@ORM\\Entity\b/.test(content)) {
        relevant.push(file);
      }
    }
    return relevant.sort();
  }

  async analyzeFileSingle(context: FileAnalysisContext): Promise<FileAnalysisResult> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const content = await fs.readFile(context.filePath, 'utf-8');
    const stat = await fs.stat(context.filePath);

    const entities: DoctrineEntity[] = [];
    if (/ORM\\Entity\b|@ORM\\Entity\b/.test(content)) {
      // Single-file scope has no visibility into trait declarations that may
      // live in other files (same limitation as the cross-file relation/
      // write-site gaps noted below) — pass an empty registry rather than
      // guess; full analysis re-derives the complete picture.
      entities.push(...this.parseEntities(content, context.relativePath, new Map()));
    }

    // Single-file scope: relation edges to entities defined in other files,
    // and write-site facts (which need the project-wide entity name set),
    // under-populate here and re-derive on full analysis — same documented
    // limitation as TypeORMAnalyzer.analyzeFileSingle.
    this.emitEntityGraph(entities, nodes, edges);

    const exports = entities.map(e => e.className);

    return this.createFileAnalysisResult(
      context.filePath,
      context.relativePath,
      context.contentHash || this.computeContentHash(content),
      stat.mtimeMs,
      nodes,
      edges,
      [],
      [],
      [],
      exports
    );
  }

  // ---------------------------------------------------------------------
  // Entity / field / relation extraction
  // ---------------------------------------------------------------------

  private parseEntities(content: string, filePath: string, traitInfoByName: Map<string, DoctrineTraitInfo>): DoctrineEntity[] {
    const entities: DoctrineEntity[] = [];
    const namespace = this.extractNamespace(content);
    const classRe = /\bclass\s+(\w+)/g;

    let match: RegExpExecArray | null;
    while ((match = classRe.exec(content)) !== null) {
      const className = match[1];
      const classKeywordIndex = match.index;

      const { text: evidenceText } = this.collectPrecedingAttributeText(content, classKeywordIndex);

      const ormAttrs = this.extractOrmAttributes(evidenceText);
      const entityAttr = ormAttrs.find(a => a.name === 'Entity');
      if (!entityAttr) {
        continue;
      }

      const evidenceKind: 'attribute' | 'annotation' = evidenceText.includes('#[') ? 'attribute' : 'annotation';

      const tableAttr = ormAttrs.find(a => a.name === 'Table');
      const tableName = tableAttr ? this.matchFirst(tableAttr.args, /name\s*[:=]\s*['"]([^'"]+)['"]/) : undefined;

      const repositoryClass =
        this.matchFirst(entityAttr.args, /repositoryClass\s*:\s*(\w+)::class/) ||
        this.matchFirst(entityAttr.args, /repositoryClass\s*=\s*["']([^"']+)["']/)?.split('\\').pop();

      const classBodyOpen = content.indexOf('{', classRe.lastIndex);
      const bodyStart = classBodyOpen + 1;
      const body = classBodyOpen === -1 ? null : this.extractBalanced(content, classBodyOpen, '{', '}');

      const fields: DoctrineField[] = [];
      const relations: DoctrineRelationField[] = [];
      const lifecycleCallbacks: string[] = [];

      if (body !== null) {
        this.parseMembers(content, body, bodyStart, fields, relations, lifecycleCallbacks);

        // Fold in ORM fields/relations declared inside any `use`d trait. A
        // property the subclass ALSO declares directly wins (skip the trait's
        // copy) so an explicit override is never shadowed by the shared default.
        for (const traitName of this.extractUsedTraitNames(body)) {
          const traitInfo = traitInfoByName.get(traitName);
          if (!traitInfo) continue;
          const traitFields: DoctrineField[] = [];
          const traitRelations: DoctrineRelationField[] = [];
          const traitLifecycle: string[] = [];
          this.parseMembers(traitInfo.content, traitInfo.body, traitInfo.bodyOffset, traitFields, traitRelations, traitLifecycle);
          const alreadyDeclared = new Set([...fields.map(f => f.name), ...relations.map(r => r.name)]);
          for (const f of traitFields) if (!alreadyDeclared.has(f.name)) fields.push(f);
          for (const r of traitRelations) if (!alreadyDeclared.has(r.name)) relations.push(r);
          lifecycleCallbacks.push(...traitLifecycle.filter(cb => !lifecycleCallbacks.includes(cb)));
        }
      }

      const line = content.slice(0, match.index).split('\n').length;
      entities.push({
        className,
        namespace,
        tableName,
        repositoryClass,
        fields,
        relations,
        lifecycleCallbacks,
        filePath,
        line,
        evidenceKind
      });
    }

    return entities;
  }

  /**
   * Walk every property declaration in a class body, resolving each one's
   * OWN preceding attribute/docblock evidence (which may be split across
   * multiple stacked `#[...]` groups — e.g. `#[ORM\Column(...)] #[JMS\Type(...)]`)
   * into a Column/Id/GeneratedValue/Embedded field or an OneToMany/ManyToOne/
   * ManyToMany/OneToOne relation. Also collects `#[ORM\PrePersist]`-style
   * method-level lifecycle callback attributes.
   */
  private parseMembers(
    fullContent: string,
    body: string,
    bodyOffset: number,
    fields: DoctrineField[],
    relations: DoctrineRelationField[],
    lifecycleCallbacks: string[]
  ): void {
    const relationKinds: DoctrineRelationKind[] = ['OneToMany', 'ManyToOne', 'ManyToMany', 'OneToOne'];
    const lifecycleAttrs = new Set([
      'PrePersist', 'PostPersist', 'PreUpdate', 'PostUpdate', 'PreRemove', 'PostRemove', 'PostLoad', 'PreFlush'
    ]);

    // Property declarations.
    const propRe = /(?:private|protected|public)\s+(?:static\s+)?(?:readonly\s+)?(?:\??[\w\\|]+\s+)?\$(\w+)/g;
    let match: RegExpExecArray | null;
    while ((match = propRe.exec(body)) !== null) {
      const propName = match[1];
      const absoluteIndex = bodyOffset + match.index;
      const line = fullContent.slice(0, absoluteIndex).split('\n').length;

      const { text: evidenceText } = this.collectPrecedingAttributeText(fullContent, absoluteIndex);
      const ormAttrs = this.extractOrmAttributes(evidenceText);
      if (ormAttrs.length === 0) continue;

      const relationAttr = ormAttrs.find(a => relationKinds.includes(a.name as DoctrineRelationKind));
      if (relationAttr) {
        const targetEntity =
          this.matchFirst(relationAttr.args, /targetEntity\s*:\s*([\w\\]+)::class/) ||
          this.matchFirst(relationAttr.args, /targetEntity\s*=\s*["']?([^"',)\s]+)/);
        const resolvedTarget = targetEntity ? targetEntity.replace('::class', '').split('\\').pop()! : 'unknown';
        const mappedBy = this.matchFirst(relationAttr.args, /mappedBy\s*[:=]\s*["'](\w+)["']/);
        const inversedBy = this.matchFirst(relationAttr.args, /inversedBy\s*[:=]\s*["'](\w+)["']/);
        relations.push({
          name: propName,
          kind: relationAttr.name as DoctrineRelationKind,
          targetEntity: resolvedTarget,
          mappedBy,
          inversedBy,
          line
        });
        continue;
      }

      const embeddedAttr = ormAttrs.find(a => a.name === 'Embedded');
      const columnAttr = ormAttrs.find(a => a.name === 'Column');
      const isId = ormAttrs.some(a => a.name === 'Id');
      const isGenerated = ormAttrs.some(a => a.name === 'GeneratedValue');

      if (embeddedAttr) {
        const embeddedType =
          this.matchFirst(embeddedAttr.args, /class\s*:\s*([\w\\]+)::class/) ||
          this.matchFirst(embeddedAttr.args, /class\s*=\s*["']?([^"',)\s]+)/) ||
          'unknown';
        fields.push({
          name: propName,
          type: embeddedType.replace('::class', '').split('\\').pop()!,
          nullable: true,
          unique: false,
          primary: false,
          generated: false,
          embedded: true,
          line
        });
        continue;
      }

      if (columnAttr || isId) {
        const args = columnAttr?.args || '';
        const typeFromTypes = this.matchFirst(args, /type\s*[:=]\s*Types::(\w+)/);
        const typeFromLiteral = this.matchFirst(args, /type\s*[:=]\s*['"](\w+)['"]/);
        const type = (typeFromTypes || typeFromLiteral || 'string').toLowerCase();
        const nullable = /nullable\s*[:=]\s*true/.test(args);
        const unique = /unique\s*[:=]\s*true/.test(args);
        fields.push({
          name: propName,
          type,
          nullable,
          unique,
          primary: isId,
          generated: isGenerated,
          embedded: false,
          line
        });
      }
    }

    // Method-level lifecycle callback attributes/annotations:
    // `#[ORM\PrePersist] public function onPrePersist() {}` or
    // `/** @ORM\PrePersist */ public function onCreate() {}`.
    const methodRe = /(?:public|protected|private)\s+function\s+(\w+)\s*\(/g;
    while ((match = methodRe.exec(body)) !== null) {
      const absoluteIndex = bodyOffset + match.index;
      const { text: evidenceText } = this.collectPrecedingAttributeText(fullContent, absoluteIndex);
      const ormAttrs = this.extractOrmAttributes(evidenceText);
      for (const attr of ormAttrs) {
        if (lifecycleAttrs.has(attr.name)) {
          lifecycleCallbacks.push(attr.name);
        }
      }
    }
  }

  private emitEntityGraph(entities: DoctrineEntity[], nodes: CASNode[], edges: CASEdge[]): void {
    const entityByClass = new Map<string, DoctrineEntity>();
    for (const entity of entities) {
      entityByClass.set(entity.className, entity);
    }

    for (const entity of entities) {
      const nodeId = `entity_doctrine_${entity.className.toLowerCase()}`;

      const fieldMeta = [
        ...entity.fields.map(f => ({
          name: f.name,
          type: f.type,
          primary: f.primary,
          generated: f.generated,
          nullable: f.nullable,
          unique: f.unique,
          embedded: f.embedded,
          relation: false
        })),
        ...entity.relations.map(r => ({
          name: r.name,
          type: r.targetEntity,
          primary: false,
          generated: false,
          nullable: true,
          unique: false,
          embedded: false,
          relation: true,
          relationType: r.kind
        }))
      ];

      nodes.push(this.createNode(
        nodeId,
        entity.className,
        'entity',
        3,
        entity.filePath,
        entity.line,
        undefined,
        {
          orm: 'Doctrine',
          source: 'doctrine_entity',
          tableName: entity.tableName || entity.className.toLowerCase(),
          repositoryClass: entity.repositoryClass,
          fields: fieldMeta,
          annotations: ['Entity'],
          evidenceKind: entity.evidenceKind,
          lifecycleCallbacks: entity.lifecycleCallbacks,
          subcategories: ['entity', 'doctrine']
        }
      ));

      for (const rel of entity.relations) {
        if (!entityByClass.has(rel.targetEntity)) {
          continue;
        }
        edges.push(this.createEdge(
          `doctrine_rel_${entity.className}_${rel.name}_${rel.targetEntity}`,
          nodeId,
          `entity_doctrine_${rel.targetEntity.toLowerCase()}`,
          'references',
          'database',
          {
            attributes: {
              relationType: rel.kind,
              field: rel.name,
              targetEntity: rel.targetEntity,
              mappedBy: rel.mappedBy,
              inversedBy: rel.inversedBy,
              via: 'attribute'
            }
          }
        ));
      }
    }
  }

  // ---------------------------------------------------------------------
  // persist()/remove() write-site extraction
  // ---------------------------------------------------------------------

  /**
   * Scan a file for `->persist(...)`/`->remove(...)` call sites and bind each
   * one to a known Doctrine entity name using three evidence sources, in
   * order: (1) an inline `new Entity(...)` argument, (2) a local variable
   * previously assigned `$var = new Entity(...)` or typed as `Entity $var` in
   * the same method's signature, (3) a file-level ServiceEntityRepository ->
   * entity binding (`parent::__construct($registry, Entity::class)`). A call
   * site with none of these is skipped rather than guessed — evidence-first.
   *
   * `flush()` alone is NOT turned into its own write fact: it is Doctrine's
   * batch-commit boundary, not an entity-identifying call, so attributing it
   * would require the exact same binding evidence persist()/remove() already
   * provide.
   */
  private extractWriteSites(content: string, filePath: string, knownEntityNames: Set<string>): DoctrineWriteSite[] {
    const sites: DoctrineWriteSite[] = [];
    const fileLevelEntity = this.extractFileLevelRepositoryEntity(content, knownEntityNames);

    const methodRe = /(?:public|protected|private)\s+(?:static\s+)?function\s+(\w+)\s*\(([^)]*)\)[^{]*\{/g;
    let match: RegExpExecArray | null;
    while ((match = methodRe.exec(content)) !== null) {
      const params = match[2];
      const bodyOpen = methodRe.lastIndex - 1;
      const body = this.extractBalanced(content, bodyOpen, '{', '}');
      if (body === null) continue;
      const bodyOffset = bodyOpen + 1;

      // Two binding tiers, kept separate so the write ACTION reflects real
      // evidence: a var bound to a fresh `new Entity(...)` is a genuine
      // insert; a var bound only via a TYPED PARAMETER is an already-existing
      // object handed in (the common `save(Booking $booking)` shape), which
      // is an update/re-attach, not a creation.
      const constructedVars = new Map<string, string>();
      const paramVars = new Map<string, string>();
      const paramRe = /(\w+)\s+\$(\w+)/g;
      let paramMatch: RegExpExecArray | null;
      while ((paramMatch = paramRe.exec(params)) !== null) {
        const typeHint = paramMatch[1];
        // Accept the entity's own conventional interface name too
        // (`BookingInterface $booking` for entity `Booking`) — Symfony/
        // Doctrine code overwhelmingly type-hints against the domain
        // interface rather than the concrete entity class.
        const resolved = knownEntityNames.has(typeHint)
          ? typeHint
          : (typeHint.endsWith('Interface') && knownEntityNames.has(typeHint.slice(0, -'Interface'.length)))
            ? typeHint.slice(0, -'Interface'.length)
            : undefined;
        if (resolved) {
          paramVars.set(paramMatch[2], resolved);
        }
      }
      // Local assignment from a constructor call: `$x = new EntityName(`.
      const assignRe = /\$(\w+)\s*=\s*new\s+(\w+)\s*\(/g;
      let assignMatch: RegExpExecArray | null;
      while ((assignMatch = assignRe.exec(body)) !== null) {
        if (knownEntityNames.has(assignMatch[2])) {
          constructedVars.set(assignMatch[1], assignMatch[2]);
        }
      }
      // Named-constructor / static factory-method assignment:
      // `$x = EntityName::createNew(...)` / `EntityName::create(...)`. Common
      // when the entity's real `__construct` is private (Doctrine entities
      // frequently expose a named factory instead), which `new EntityName(`
      // above never matches.
      const factoryRe = /\$(\w+)\s*=\s*(\w+)::\w+\s*\(/g;
      let factoryMatch: RegExpExecArray | null;
      while ((factoryMatch = factoryRe.exec(body)) !== null) {
        if (knownEntityNames.has(factoryMatch[2]) && !constructedVars.has(factoryMatch[1])) {
          constructedVars.set(factoryMatch[1], factoryMatch[2]);
        }
      }
      const varToEntity = new Map<string, string>([...paramVars, ...constructedVars]);

      // persist(new Entity(...)) or persist($var).
      const persistRe = /->persist\s*\(\s*(?:new\s+(\w+)\s*\(|\$(\w+)\b)/g;
      let persistMatch: RegExpExecArray | null;
      while ((persistMatch = persistRe.exec(body)) !== null) {
        const inlineEntity = persistMatch[1];
        const varName = persistMatch[2];
        let entityName: string | undefined;
        let action: 'insert' | 'update' = 'update';
        let via = '';
        if (inlineEntity && knownEntityNames.has(inlineEntity)) {
          entityName = inlineEntity;
          action = 'insert';
          via = `inline "new ${inlineEntity}(...)" argument to persist()`;
        } else if (varName && constructedVars.has(varName)) {
          entityName = constructedVars.get(varName)!;
          action = 'insert';
          via = `variable "$${varName}" bound to a constructed/factory-built "${entityName}" earlier in method`;
        } else if (varName && paramVars.has(varName)) {
          entityName = paramVars.get(varName)!;
          action = 'update';
          via = `variable "$${varName}" bound via typed parameter "${entityName} $${varName}"`;
        } else if (fileLevelEntity) {
          entityName = fileLevelEntity;
          action = 'update';
          via = `repository-scoped entity binding for "${fileLevelEntity}"`;
        }
        if (entityName) {
          const line = content.slice(0, bodyOffset + persistMatch.index).split('\n').length;
          sites.push({ op: 'persist', action, entityName, filePath, line, via });
        }
      }

      // remove($var).
      const removeRe = /->remove\s*\(\s*\$(\w+)\b/g;
      let removeMatch: RegExpExecArray | null;
      while ((removeMatch = removeRe.exec(body)) !== null) {
        const varName = removeMatch[1];
        let entityName: string | undefined;
        let via = '';
        if (varToEntity.has(varName)) {
          entityName = varToEntity.get(varName)!;
          via = `variable "$${varName}" bound to entity "${entityName}"`;
        } else if (fileLevelEntity) {
          entityName = fileLevelEntity;
          via = `repository-scoped entity binding for "${fileLevelEntity}"`;
        }
        if (entityName) {
          const line = content.slice(0, bodyOffset + removeMatch.index).split('\n').length;
          sites.push({ op: 'remove', action: 'delete', entityName, filePath, line, via });
        }
      }
    }

    return sites;
  }

  /**
   * `class XRepository extends ServiceEntityRepository { public function
   * __construct(ManagerRegistry $registry) { parent::__construct($registry,
   * Booking::class); } }` — binds every persist()/remove() call in this file
   * to `Booking` when no stronger per-call-site evidence exists.
   */
  private extractFileLevelRepositoryEntity(content: string, knownEntityNames: Set<string>): string | undefined {
    if (!/extends\s+ServiceEntityRepository/.test(content)) {
      return undefined;
    }
    const ctorEntity = this.matchFirst(content, /parent::__construct\s*\([^)]*?,\s*(\w+)::class\s*\)/);
    if (ctorEntity && knownEntityNames.has(ctorEntity)) {
      return ctorEntity;
    }
    // Fallback: generic type param on the class declaration
    // `extends ServiceEntityRepository<Booking>` or an `@extends` docblock.
    const genericEntity =
      this.matchFirst(content, /extends\s+ServiceEntityRepository\s*<\s*(\w+)\s*>/) ||
      this.matchFirst(content, /@extends\s+ServiceEntityRepository<\s*(\w+)\s*>/);
    if (genericEntity && knownEntityNames.has(genericEntity)) {
      return genericEntity;
    }
    return undefined;
  }

  private emitWriteFacts(
    writeSites: DoctrineWriteSite[],
    entities: DoctrineEntity[],
    nodes: CASNode[],
    edges: CASEdge[]
  ): NonNullable<CASContribution['exit_points']> {
    const entityByClass = new Map(entities.map(e => [e.className, e]));
    const edgeTypeForAction: Record<DoctrineWriteSite['action'], string> = {
      insert: 'creates',
      update: 'updates',
      delete: 'deletes'
    };

    return writeSites.map((site, index) => {
      const nodeId = `query_doctrine_${site.op}_${this.sanitizeId(site.entityName)}_${this.sanitizeId(site.filePath)}_${site.line}_${index}`;
      nodes.push(this.createNode(
        nodeId,
        `Doctrine ${site.op} ${site.entityName}`,
        'database_query',
        4,
        site.filePath,
        site.line,
        undefined,
        {
          orm: 'Doctrine',
          source: 'doctrine_write_site',
          entity: site.entityName,
          operation: site.op,
          action: site.action,
          evidence: site.via,
          subcategories: ['query', 'doctrine']
        }
      ));

      const targetEntity = entityByClass.get(site.entityName);
      if (targetEntity) {
        const entityNodeId = `entity_doctrine_${site.entityName.toLowerCase()}`;
        edges.push(this.createEdge(
          `doctrine_write_${nodeId}`,
          nodeId,
          entityNodeId,
          edgeTypeForAction[site.action],
          'database',
          { attributes: { entity: site.entityName, operation: site.op, via: site.via } }
        ));
      }

      return this.createExitPoint(
        `exit_doctrine_${nodeId}`,
        nodeId,
        'database',
        `Doctrine ${site.op} ${site.entityName}`,
        `Doctrine ORM ${site.op}() call writing entity '${site.entityName}' (${site.via}).`,
        { resource: site.entityName },
        { action: site.action },
        { orm: 'Doctrine', entity: site.entityName, operation: site.op, file: site.filePath, line: site.line }
      );
    });
  }

  // ---------------------------------------------------------------------
  // Trait-declared ORM member support
  // ---------------------------------------------------------------------

  /** Scan every file's content once for `trait Xxx { ... }` declarations,
   *  keyed by trait name (first declaration wins on a same-name collision —
   *  real projects don't declare two traits with the same bare name). Each
   *  entry keeps its OWN file's content + body offset so line numbers stay
   *  correct when its members are parsed independently of the consuming
   *  entity class. */
  private collectTraitInfo(fileContents: Map<string, string>): Map<string, DoctrineTraitInfo> {
    const traits = new Map<string, DoctrineTraitInfo>();
    const traitRe = /\btrait\s+(\w+)/g;
    for (const content of fileContents.values()) {
      traitRe.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = traitRe.exec(content)) !== null) {
        const name = m[1];
        if (traits.has(name)) continue;
        const bodyOpen = content.indexOf('{', traitRe.lastIndex);
        if (bodyOpen === -1) continue;
        const body = this.extractBalanced(content, bodyOpen, '{', '}');
        if (body === null) continue;
        traits.set(name, { content, body, bodyOffset: bodyOpen + 1 });
      }
    }
    return traits;
  }

  /** Bare trait names from `use TraitName;` / `use Ns\TraitName, OtherTrait;`
   *  statements inside a class body. Deliberately simple: only the plain
   *  `use A, B;` form (no conflict-resolution `{ ... }` block) is matched —
   *  PHP closures (`function () use ($x) { ... }`) never match because they
   *  are followed by `(`, not an identifier, so this cannot mis-fire there. */
  private extractUsedTraitNames(classBody: string): string[] {
    const names = new Set<string>();
    const useRe = /\buse\s+([A-Za-z_\\][\w\\]*(?:\s*,\s*[A-Za-z_\\][\w\\]*)*)\s*;/g;
    let m: RegExpExecArray | null;
    while ((m = useRe.exec(classBody)) !== null) {
      for (const raw of m[1].split(',')) {
        const name = raw.trim().split('\\').pop();
        if (name) names.add(name);
      }
    }
    return [...names];
  }

  // ---------------------------------------------------------------------
  // Deterministic ordering
  //
  // Root fix lives in glob-cache.ts (cachedGlob sorts its result even
  // outside an orchestrator beginGlobRun/endGlobRun window now — see its
  // NO-TOKEN DETERMINISM note). The sorts below are a local, defense-in-depth
  // guarantee: they make this analyzer's own emission order a pure function
  // of file/entity/write-site identity, independent of the cache layer, so
  // it stays byte-stable even if a future caller bypasses or changes the
  // shared glob cache.
  // ---------------------------------------------------------------------

  /** Discovery order for every glob in this analyzer. Plain codepoint sort so
   *  the result is locale-independent (localeCompare is not). */
  private sortFiles(files: string[]): string[] {
    return [...files].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  private compareStrings(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
  }

  /** Entity node/edge emission order: file path, then declaration line, then
   *  class name (two classes never share a file+line, so the third key is only
   *  a total-order guarantee). */
  private sortEntities(entities: DoctrineEntity[]): void {
    entities.sort((a, b) =>
      this.compareStrings(a.filePath, b.filePath) ||
      a.line - b.line ||
      this.compareStrings(a.className, b.className)
    );
  }

  /** Write-fact emission order. Also fixes the `_${index}` suffix in the
   *  emitted query node ids, which is positional. */
  private sortWriteSites(sites: DoctrineWriteSite[]): void {
    sites.sort((a, b) =>
      this.compareStrings(a.filePath, b.filePath) ||
      a.line - b.line ||
      this.compareStrings(a.op, b.op) ||
      this.compareStrings(a.entityName, b.entityName) ||
      this.compareStrings(a.via, b.via)
    );
  }

  // ---------------------------------------------------------------------
  // Shared text-parsing helpers
  // ---------------------------------------------------------------------

  private extractNamespace(content: string): string {
    const match = content.match(/namespace\s+([^;]+);/);
    return match ? match[1].trim() : 'global';
  }

  private matchFirst(text: string, re: RegExp): string | undefined {
    const m = re.exec(text);
    return m ? m[1] : undefined;
  }

  /**
   * Extract every `ORM\Xxx(...)` / `ORM\Xxx` (bare) / `@Xxx(...)` occurrence
   * in a blob of combined attribute-group + docblock text, with a balanced-
   * paren argument extractor so nested `[...]`/`(...)` in the args (e.g.
   * `indexes: [new ORM\Index(columns: [...])]`) don't truncate the match.
   */
  private extractOrmAttributes(text: string): OrmAttributeMatch[] {
    const results: OrmAttributeMatch[] = [];
    const nameRe = /ORM\\(\w+)|@(Entity|Column|Id|GeneratedValue|OneToMany|ManyToOne|ManyToMany|OneToOne|Table|JoinColumn|Embedded|PrePersist|PostPersist|PreUpdate|PostUpdate|PreRemove|PostRemove|PostLoad|PreFlush)\b/g;
    let m: RegExpExecArray | null;
    while ((m = nameRe.exec(text)) !== null) {
      const name = m[1] || m[2];
      let i = nameRe.lastIndex;
      while (i < text.length && /\s/.test(text[i])) i++;
      let args = '';
      if (text[i] === '(') {
        const end = this.findMatchingBracket(text, i, '(', ')');
        if (end !== -1) {
          args = text.slice(i + 1, end);
          nameRe.lastIndex = end + 1;
        }
      }
      results.push({ name, args });
    }
    return results;
  }

  /**
   * Walk backward from `beforeIndex`, collecting every contiguous `#[...]`
   * attribute group (bracket-balanced, so nested `[...]` inside the group's
   * own arguments doesn't break the scan) AND every contiguous `/** ... *\/`
   * PHPDoc block, in WHATEVER ORDER they appear (real Doctrine entities mix
   * both — e.g. Company.php stacks three attribute groups
   * `#[ORM\Entity(...)]#[UniqueEntity(...)]#[JMS\ExclusionPolicy(...), ...]`
   * and THEN a trailing `/** @see CompanyTest *\/` docblock before `class`,
   * the reverse of the more common "docblock, then attributes" ordering). A
   * collector that only recognized one fixed order would silently return NO
   * evidence for the other — this walks one token backward at a time,
   * stopping only when neither a `]`-closed attribute group nor a `*\/`-
   * closed docblock is found immediately (after whitespace) before the
   * current position.
   */
  private collectPrecedingAttributeText(content: string, beforeIndex: number): { text: string; start: number } {
    const chunks: string[] = [];
    let pos = beforeIndex;
    while (true) {
      let p = pos;
      while (p > 0 && /\s/.test(content[p - 1])) p--;
      if (p === 0) break;

      if (content[p - 1] === ']') {
        const closeIdx = p - 1;
        const openIdx = this.findMatchingBracketBackward(content, closeIdx, '[', ']');
        if (openIdx === -1 || content[openIdx - 1] !== '#') break;
        const groupStart = openIdx - 1;
        chunks.unshift(content.slice(groupStart, p));
        pos = groupStart;
        continue;
      }

      if (p >= 2 && content.slice(p - 2, p) === '*/') {
        const start = content.lastIndexOf('/**', p - 2);
        if (start === -1) break;
        chunks.unshift(content.slice(start, p));
        pos = start;
        continue;
      }

      break;
    }
    return { text: chunks.join('\n'), start: pos };
  }

  private findMatchingBracket(text: string, openIndex: number, open: string, close: string): number {
    let depth = 0;
    for (let i = openIndex; i < text.length; i++) {
      if (text[i] === open) depth++;
      else if (text[i] === close) {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  private findMatchingBracketBackward(text: string, closeIndex: number, open: string, close: string): number {
    let depth = 0;
    for (let i = closeIndex; i >= 0; i--) {
      if (text[i] === close) depth++;
      else if (text[i] === open) {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  private extractBalanced(content: string, openIndex: number, open: string, close: string): string | null {
    if (content[openIndex] !== open) {
      return null;
    }
    let depth = 0;
    for (let i = openIndex; i < content.length; i++) {
      const ch = content[i];
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          return content.slice(openIndex + 1, i);
        }
      }
    }
    return null;
  }

  protected getCapabilities(): string[] {
    return ['doctrine-entities', 'doctrine-columns', 'doctrine-relations', 'doctrine-write-facts'];
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'system';
      case 2: return 'architectural';
      case 3: return 'code';
      case 4: return 'member';
      case 5: return 'implementation';
      default: return 'unknown';
    }
  }
}
