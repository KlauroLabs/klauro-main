import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import { AspNetCoreAnalyzer } from './aspnet-core-analyzer';
import { CASContribution, CASNode } from '../../../types/cas.types';

test('AspNetCoreAnalyzer keeps DbContext exits and entity relationships on canonical nodes', async () => {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'aspnet-core-analyzer-'));
  try {
    await fs.writeFile(path.join(projectPath, 'DataContext.cs'), [
      'public class DataContext : DbContext',
      '{',
      '    public DbSet<User> Users { get; set; }',
      '    public DbSet<Role> Roles { get; set; }',
      '}',
    ].join('\n'));
    await fs.writeFile(path.join(projectPath, 'User.cs'), [
      'public class User',
      '{',
      '    public ICollection<Role> Roles { get; set; }',
      '}',
    ].join('\n'));
    await fs.writeFile(path.join(projectPath, 'Role.cs'), 'public class Role {}\n');

    const existingNodes: CASNode[] = [
      { id: 'class_data_context', name: 'DataContext', type: 'class', level: 3, source: { file: 'DataContext.cs' } },
      { id: 'class_user', name: 'User', type: 'class', level: 3, source: { file: 'User.cs' } },
      { id: 'class_role', name: 'Role', type: 'class', level: 3, source: { file: 'Role.cs' } },
    ];
    const existingContribution: CASContribution = {
      nodes: existingNodes,
      analyzer_metadata: {
        analyzer_id: 'fixture',
        analyzer_name: 'Fixture',
        contribution_type: 'language',
      },
    };
    const result = await new AspNetCoreAnalyzer().analyze({ projectPath, existingAnalysis: [existingContribution] });
    const availableIds = new Set([...existingNodes.map(node => node.id), ...result.nodes.map(node => node.id)]);
    const relationship = result.edges.find(edge => edge.type === 'entity-relationship');

    assert.ok(result.exit_points.every(exit => exit.source_node === 'class_data_context'));
    assert.equal(relationship?.source, 'class_user');
    assert.equal(relationship?.target, 'class_role');
    assert.ok(result.edges.every(edge => availableIds.has(edge.source) && availableIds.has(edge.target)));
  } finally {
    await fs.remove(projectPath);
  }
});
