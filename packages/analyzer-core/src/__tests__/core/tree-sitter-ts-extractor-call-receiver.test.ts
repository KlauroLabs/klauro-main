import {
  TreeSitterTSExtractor,
  TSExtractedCall,
  UNRESOLVED_RECEIVER,
} from '../../analyzer/core/tree-sitter-ts-extractor';

/**
 * Regression tests for the chained-call receiver defect.
 *
 * `extractCall` built a method call's target as `${obj.text}.${prop.text}`,
 * where `obj.text` is the receiver node's raw SOURCE TEXT. For a call on the
 * result of another call the receiver node is the entire preceding chain, so
 * the target became a multi-line blob of source. Consumers
 * (`isRepositoryCall` / `parseRepositoryCall` / `propertyNameToClassName`)
 * split that blob on `.` and capitalized its tail, so a plain
 * `Array.prototype.find` over a sorted array was published as a `database`
 * exit point on a repository named `Length)`:
 *
 *   exit_db_attachFallbackEntityAnchor_find_11954 :: "Length).find"
 *   exit_db_deriveDeterministicFallbackPurposeLabel_find_11917 :: "Get(id)).find"
 *
 * measured on a real analysis of this repo (2 occurrences in ~89,000 edges).
 *
 * The contract now: a receiver is either NAMED or recorded as
 * UNRESOLVED_RECEIVER — never a fragment of source text. An unresolved
 * receiver is UNKNOWN, so it must not classify as a store or API exit.
 */
describe('TreeSitterTSExtractor call receiver naming', () => {
  const extractor = new TreeSitterTSExtractor();

  function allCalls(source: string, file = 'file.ts'): TSExtractedCall[] {
    const extraction = extractor.extractFromSource(source, file);
    const calls: TSExtractedCall[] = [];
    for (const fn of extraction.functions) calls.push(...fn.calls);
    for (const cls of extraction.classes) {
      for (const method of cls.methods) calls.push(...method.calls);
    }
    return calls;
  }

  /**
   * A receiver name is a dotted chain of JS identifiers (plus `this`/`super`)
   * or the explicit unresolved marker. Anything else — a paren, a bracket, a
   * space, a newline, an operator — is source text that leaked through.
   */
  function sourceTextShapedTargets(calls: TSExtractedCall[]): string[] {
    const dottedIdentifiers = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
    return calls.map(c => c.target).filter(target => {
      // The marker stands where a receiver name would be; the rest of the
      // target still has to be a well-formed dotted chain.
      const normalized = target.startsWith(UNRESOLVED_RECEIVER)
        ? `receiver${target.slice(UNRESOLVED_RECEIVER.length)}`
        : target;
      return !dottedIdentifiers.test(normalized);
    });
  }

  it('does not name a chained-call receiver with the preceding source text', () => {
    // The exact shape from attachFallbackEntityAnchor: the receiver of `.find`
    // is the `.sort(...)` call, whose source text ends `...canonical.length)`.
    // That produced the repository name `Length)`.
    const source = `
      class Orchestrator {
        anchor(dataEntities: any[]) {
          return dataEntities
            .map(entity => ({ entity, canonical: this.canon(entity.name) }))
            .filter(item => item.canonical.length >= 4)
            .sort((left, right) => right.canonical.length - left.canonical.length)
            .find(item => item.canonical.includes('x'));
        }
      }
    `;
    const calls = allCalls(source);
    const targets = calls.map(c => c.target);

    expect(sourceTextShapedTargets(calls)).toEqual([]);
    expect(targets).not.toContain('length).find');
    expect(targets.some(t => t.toLowerCase().includes('length)'))).toBe(false);
    expect(targets).toContain(`${UNRESOLVED_RECEIVER}.find`);
  });

  it('does not name an Array.from({length}) chained receiver with source text', () => {
    const source = `
      function pick(n: number) {
        return Array.from({ length: n }).find(value => value !== undefined);
      }
    `;
    const calls = allCalls(source);
    expect(sourceTextShapedTargets(calls)).toEqual([]);
    expect(calls.map(c => c.target)).toContain(`${UNRESOLVED_RECEIVER}.find`);
  });

  it('does not name a call-result receiver with source text', () => {
    // The deriveDeterministicFallbackPurposeLabel shape: the receiver of
    // `.find` is a `.map(...)` whose text ends `entityById.get(id))`, which
    // produced the repository name `Get(id))`.
    const source = `
      function grounded(ids: string[], entityById: Map<string, string>) {
        return ids
          .map(id => entityById.get(id))
          .find(Boolean);
      }
    `;
    const calls = allCalls(source);
    const targets = calls.map(c => c.target);

    expect(sourceTextShapedTargets(calls)).toEqual([]);
    expect(targets.some(t => t.includes('get(id)'))).toBe(false);
    expect(targets).toContain(`${UNRESOLVED_RECEIVER}.find`);
  });

  it('marks every non-name receiver form as unresolved, not as source text', () => {
    const source = `
      class Client {
        async run(rows: any[], key: string) {
          rows[0].find((r: any) => r);
          (await this.connect()).query('select 1');
          (rows.length > 0 ? rows : []).find(Boolean);
          ({ a: 1 }).hasOwnProperty('a');
          'literal'.toUpperCase();
        }
      }
    `;
    const calls = allCalls(source);
    expect(sourceTextShapedTargets(calls)).toEqual([]);

    const unresolved = calls
      .filter(c => c.target.startsWith(`${UNRESOLVED_RECEIVER}.`))
      .map(c => c.target);
    expect(unresolved).toEqual(
      expect.arrayContaining([
        `${UNRESOLVED_RECEIVER}.find`,
        `${UNRESOLVED_RECEIVER}.query`,
      ]),
    );
  });

  it('sees through type-level and grouping syntax to the receiver name', () => {
    // These wrappers do not change WHAT the receiver is, so they must not cost
    // a receiver name — `capability.relatedFlows!.map(...)` is a named call, and
    // downstream DI-field/typed-receiver resolution keys off that name.
    const source = `
      class Wrapped {
        run(capability: any, a: any) {
          capability.relatedFlows!.map((f: any) => f);
          (a).first();
          (a as Foo).second();
          (a satisfies Foo).third();
          this.field!.fourth();
        }
      }
    `;
    const targets = allCalls(source).map(c => c.target);

    expect(targets).toEqual(
      expect.arrayContaining([
        'capability.relatedFlows.map',
        'a.first',
        'a.second',
        'a.third',
        'this.field.fourth',
      ]),
    );
    expect(targets.some(t => t.startsWith(`${UNRESOLVED_RECEIVER}.`))).toBe(false);
  });

  it('does not use an IIFE body as a call target', () => {
    // The sibling leak in the same function: a callee that is not a name fell
    // through to `target = callee.text`, so an IIFE carried its whole body.
    const source = `
      async function boot() {
        const ready = await (async () => {
          const parts: string[] = [];
          parts.push('a');
          return parts.join('.');
        })();
        return ready;
      }
    `;
    const calls = allCalls(source);
    expect(sourceTextShapedTargets(calls)).toEqual([]);
    expect(calls.every(c => !c.target.includes('\n'))).toBe(true);
    expect(calls.map(c => c.target)).toContain(UNRESOLVED_RECEIVER);
  });

  it('keeps `import` as the target of a dynamic import', () => {
    // A dynamic import is a real cross-file dependency named `import`. Marking
    // it unresolved because its callee is not an `identifier` node would drop
    // every lazy-route dependency in the graph.
    const source = `
      const Page = lazy(() => import('./Page'));
      async function load() {
        const mod = await import('./other');
        return mod;
      }
    `;
    expect(allCalls(source).map(c => c.target)).toContain('import');
  });

  it('names a non-null-asserted callee rather than keeping its punctuation', () => {
    const source = `
      function run(f: any) {
        f!();
      }
    `;
    expect(allCalls(source).map(c => c.target)).toContain('f');
  });

  it('still names real receivers, so the fix costs no resolvable calls', () => {
    const source = `
      class Service {
        constructor(private readonly userRepository: any) {}
        async handle(repo: any, entityById: Map<string, string>, id: string) {
          await this.userRepository.find({});
          await repo.save({});
          entityById.get(id);
          this.helper.inner.deep();
          super.setup();
        }
      }
    `;
    const targets = allCalls(source).map(c => c.target);

    expect(targets).toEqual(
      expect.arrayContaining([
        'this.userRepository.find',
        'repo.save',
        'entityById.get',
        'this.helper.inner.deep',
        'super.setup',
      ]),
    );
    expect(targets.some(t => t.startsWith(`${UNRESOLVED_RECEIVER}.`))).toBe(false);
  });
});
