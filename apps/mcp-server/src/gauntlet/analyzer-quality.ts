












import * as path from 'path';
import * as fs from 'fs-extra';
import { analyzeForBench } from './product-analysis';

export interface CategoryScore {
  category: string;
  expected: number;
  produced: number;
  correct: number;
  correctProduced: number;
  precision: number;
  recall: number;
  f1: number;
  missing: string[];
  spurious: string[];
}

export interface QualityReport {
  fixture: string;
  stack: string;
  categories: CategoryScore[];
  overall: { precision: number; recall: number; f1: number };
}




function norm(s: string): string {
  return s.toLowerCase().replace(/\/\d+$/, '').replace(/\(.*\)$/, '').trim();
}




function score(expected: string[], produced: string[][]): Omit<CategoryScore, 'category'> {
  const exp = expected.map(norm);
  const tail = (s: string) => s.split(/[.#:]/).pop() || s;
  const items = produced.map(alts => alts.map(norm));
  const itemMatchesExpected = (alts: string[], e: string) =>
    alts.some(a => a === e || tail(a) === e || a === tail(e) || tail(a) === tail(e));
  const matchedExp = exp.filter(e => items.some(alts => itemMatchesExpected(alts, e)));
  const correctItems = items.filter(alts => exp.some(e => itemMatchesExpected(alts, e)));
  const precision = items.length ? correctItems.length / items.length : (exp.length ? 0 : 1);
  const recall = exp.length ? matchedExp.length / exp.length : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return {
    expected: exp.length, produced: items.length, correct: matchedExp.length,
    correctProduced: correctItems.length,
    precision: round(precision), recall: round(recall), f1: round(f1),
    missing: exp.filter(e => !items.some(alts => itemMatchesExpected(alts, e))),
    spurious: items.filter(alts => !exp.some(e => itemMatchesExpected(alts, e))).map(a => a[0]),
  };
}
function round(n: number): number { return Math.round(n * 100) / 100; }

function truthRoot(): string {
  return path.resolve(__dirname, '../../fixtures/analysis-truth');
}


export async function scoreAllFixtures(): Promise<QualityReport[]> {
  const root = truthRoot();
  let dirs: string[] = [];
  try { dirs = await fs.readdir(root); } catch { return []; }
  const reports: QualityReport[] = [];
  for (const d of dirs.sort()) {
    const dir = path.join(root, d);
    if (!(await fs.pathExists(path.join(dir, 'expected.json')))) continue;
    try { reports.push(await scoreFixture(dir)); } catch (err) {
      reports.push({ fixture: d, stack: d, categories: [], overall: { precision: 0, recall: 0, f1: 0 } });
    }
  }
  return reports;
}


export async function scoreFixture(fixtureDir: string): Promise<QualityReport> {
  const expected = await fs.readJson(path.join(fixtureDir, 'expected.json'));



  const cas: any = await analyzeForBench(fixtureDir);
  const nodes: any[] = cas.nodes || [];
  const edges: any[] = cas.edges || [];



  const nodeNames = (pred: (n: any) => boolean): string[][] => nodes.filter(pred)
    .map(n => [n.name, n.qualified_name].filter(Boolean).map(String));
  const byId = new Map<string, any>(nodes.map(n => [n.id, n] as const));
  const anonymous = (n: any): boolean => String(n?.id ?? '').includes(':callback:');
  const named = (n: any): any => {
    let held = n;
    for (let hops = 0; held && anonymous(held) && hops < 16; hops += 1) held = byId.get(held.parent);
    return held;
  };
  const edgePairs = (type: RegExp) => edges
    .filter(e => type.test(String(e.type || '')))
    .map(e => {
      const s = nodes.find(n => n.id === (e.source || e.from));
      const t = nodes.find(n => n.id === (e.target || e.to));
      return [String(s?.name || '').toLowerCase(), String(t?.name || '').toLowerCase()].join('→');
    });
  const callPairs = () => edges
    .filter(e => /call|invoke/.test(String(e.type || '')) && e.metadata?.attributes?.via !== 'rule')
    .map(e => [named(byId.get(e.source || e.from)), byId.get(e.target || e.to)])
    .filter(([source, target]) => source && target && FN(source) && FN(target))
    .map(([source, target]) => [String(source.name).toLowerCase(), String(target.name).toLowerCase()].join('→'));

  const FN = (n: any) => /function|method|procedure|rpc|operation|instruction|action/.test(String(n.type)) && !anonymous(n);
  const TYPE = (n: any) => /class|interface|struct|enum|module|namespace|contract|protocol|component|service|controller|trait/.test(String(n.type));
  const ENTITY = (n: any) => /entity|data-entity|table|schema|dto|model/.test(String(n.type));
  const ROUTE = (n: any) => /route|endpoint|operation|rpc/.test(String(n.type));

  const cats: CategoryScore[] = [];
  if (expected.functions) cats.push({ category: 'functions', ...score(expected.functions, nodeNames(FN)) });
  if (expected.classes) cats.push({ category: 'types', ...score(expected.classes, nodeNames(TYPE)) });
  if (expected.types) cats.push({ category: 'types', ...score(expected.types, nodeNames(TYPE)) });
  const contractFile = (n: any): boolean => /\.(graphql|gql|proto)$/i.test(String(n.source?.file ?? ''));
  const rootOperationType = (n: any): boolean => /^(Query|Mutation|Subscription)$/.test(String(n.name));
  const entityNames = (): string[][] => [
    ...(cas.entities || []).map((entity: any) => [entity.name, entity.schema_source].filter(Boolean).map(String)),
    ...nodeNames(ENTITY),
    ...nodeNames((n: any) => contractFile(n) && n.type === 'class' && !rootOperationType(n)),
  ];
  const routeNames = (): string[][] => [
    ...(cas.route_table || []).map((route: any) => [route.path, route.handler, `${route.method} ${route.path}`].filter(Boolean).map(String)),
    ...(cas.entry_points || []).filter((entry: any) => entry.trigger?.path === undefined)
      .map((entry: any) => [entry.name, entry.handler?.method_name].filter(Boolean).map(String)),
    ...nodeNames(ROUTE),
    ...nodeNames((n: any) => (/\.proto$/i.test(String(n.source?.file ?? '')) && n.type === 'method')
      || (/\.(graphql|gql)$/i.test(String(n.source?.file ?? '')) && n.type === 'property' && rootOperationType(byId.get(n.parent) ?? {}))),
  ];
  if (expected.entities) cats.push({ category: 'entities', ...score(expected.entities, entityNames()) });
  if (expected.routes) cats.push({ category: 'routes', ...score(expected.routes, routeNames()) });
  if (expected.calls) cats.push({ category: 'calls', ...score(expected.calls.map((c: string[]) => c.join('→')), callPairs().map(p => [p])) });

  const entityRelations = (): string[] => (cas.entities || []).flatMap((entity: any) =>
    (entity.relations || []).map((relation: any) => [String(entity.name).toLowerCase(), String(relation.target_name).toLowerCase()].join('→')));
  if (expected.relations) cats.push({ category: 'relations', ...score(expected.relations.map((c: string[]) => c.join('→')), [...new Set([...edgePairs(/relat|references|belongs|foreign|association/), ...entityRelations()])].map(p => [p])) });
  const importedFiles = (): string[][] => nodes
    .filter(n => n.type === 'import' && n.source?.file && n.name)
    .map(n => [[path.basename(String(n.source.file)), path.basename(String(n.name))].join('→').toLowerCase()]);
  if (expected.includes) cats.push({
    category: 'includes',
    ...score(expected.includes.map((c: string[]) => c.map((x: string) => x.split('/').pop()).join('→').toLowerCase()),
      [
        ...edges.filter(e => /import|include|depend/.test(String(e.type || ''))).map(e => {
          const s = nodes.find(n => n.id === (e.source || e.from));
          const t = nodes.find(n => n.id === (e.target || e.to));
          return [[path.basename(String(s?.source?.file || s?.name || '')), path.basename(String(t?.source?.file || t?.name || ''))].join('→').toLowerCase()];
        }),
        ...importedFiles(),
      ]),
  });

  const sumExp = cats.reduce((a, c) => a + c.expected, 0);
  const sumProd = cats.reduce((a, c) => a + c.produced, 0);
  const sumCorrect = cats.reduce((a, c) => a + c.correct, 0);
  const sumCorrectProduced = cats.reduce((a, c) => a + c.correctProduced, 0);




  const precision = sumProd ? sumCorrectProduced / sumProd : 0;
  const recall = sumExp ? sumCorrect / sumExp : 0;
  return {
    fixture: path.basename(fixtureDir),
    stack: expected.stack || path.basename(fixtureDir),
    categories: cats,
    overall: { precision: round(precision), recall: round(recall), f1: round(precision + recall ? (2 * precision * recall) / (precision + recall) : 0) },
  };
}
