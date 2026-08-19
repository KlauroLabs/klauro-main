jest.unmock('fs-extra');
jest.unmock('fs');
jest.unmock('glob');

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { PrismaAnalyzer } from '../../analyzer/libraries/orm/prisma-analyzer';
import { createPrismaModelIdentity, prismaSchemaNodeId } from '../../analyzer/libraries/orm/prisma-model-identity';

describe('PrismaAnalyzer', () => {
  let projectPath: string;

  beforeEach(async () => {
    projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-prisma-analyzer-'));
  });

  afterEach(async () => {
    await fs.remove(projectPath);
  });

  it('discovers nested schemas and preserves same-named model ownership', async () => {
    const schemas = ['apps/billing/prisma/schema.prisma', 'apps/audit/prisma/schema.prisma'];
    for (const schema of schemas) {
      await fs.ensureDir(path.dirname(path.join(projectPath, schema)));
      await fs.writeFile(path.join(projectPath, schema), 'model Record {\n  id Int @id\n}\n');
    }

    const analyzer = new PrismaAnalyzer();
    expect(await analyzer.canAnalyze(projectPath)).toBe(true);
    const contribution = await analyzer.analyze({ projectPath, analysisRootPath: projectPath } as any);
    const nodeIds = new Set((contribution.nodes || []).map(node => node.id));
    const modelIds = schemas.map(schema => createPrismaModelIdentity(schema, 'Record').nodeId);

    expect(new Set(modelIds).size).toBe(2);
    expect(modelIds.every(id => nodeIds.has(id))).toBe(true);
    expect(schemas.every(schema => nodeIds.has(prismaSchemaNodeId(schema)))).toBe(true);
    expect((contribution.edges || []).filter(edge => edge.type === 'contains')).toHaveLength(2);
    expect((contribution.edges || []).every(edge => nodeIds.has(edge.source) && nodeIds.has(edge.target))).toBe(true);
  });
});
