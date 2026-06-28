import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import { EFCoreAnalyzer } from './efcore-analyzer';

async function makeProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'efcore-analyzer-test-'));

  await fs.writeFile(path.join(dir, 'App.csproj'), [
    '<Project Sdk="Microsoft.NET.Sdk">',
    '  <ItemGroup>',
    '    <PackageReference Include="Microsoft.EntityFrameworkCore" Version="8.0.0" />',
    '  </ItemGroup>',
    '</Project>',
    '',
  ].join('\n'));

  const data = path.join(dir, 'Data');
  await fs.ensureDir(data);

  await fs.writeFile(path.join(data, 'AppDbContext.cs'), [
    'using Microsoft.EntityFrameworkCore;',
    '',
    'namespace App.Data;',
    '',
    'public class AppDbContext : DbContext',
    '{',
    '    public DbSet<User> Users { get; set; }',
    '    public DbSet<Order> Orders { get; set; }',
    '',
    '    protected override void OnModelCreating(ModelBuilder modelBuilder)',
    '    {',
    '        modelBuilder.Entity<User>().HasMany(u => u.Orders).WithOne(o => o.User);',
    '    }',
    '}',
    '',
  ].join('\n'));

  await fs.writeFile(path.join(data, 'User.cs'), [
    'using System.Collections.Generic;',
    'using System.ComponentModel.DataAnnotations;',
    '',
    'namespace App.Data;',
    '',
    'public class User',
    '{',
    '    [Key]',
    '    public int Id { get; set; }',
    '',
    '    [Required]',
    '    [MaxLength(255)]',
    '    public string Email { get; set; }',
    '',
    '    public List<Order> Orders { get; set; }',
    '}',
    '',
  ].join('\n'));

  await fs.writeFile(path.join(data, 'Order.cs'), [
    'using System.ComponentModel.DataAnnotations.Schema;',
    '',
    'namespace App.Data;',
    '',
    'public class Order',
    '{',
    '    public int Id { get; set; }',
    '',
    '    public int UserId { get; set; }',
    '',
    '    [ForeignKey("UserId")]',
    '    public User User { get; set; }',
    '}',
    '',
  ].join('\n'));

  return dir;
}

test('EFCoreAnalyzer extracts context, entities, fields, and relations', async () => {
  const dir = await makeProject();
  try {
    const analyzer = new EFCoreAnalyzer();
    assert.equal(await analyzer.canAnalyze(dir), true);

    const result = await analyzer.analyze({ projectPath: dir });

    // DbContext node
    const ctx = result.nodes.find(n => n.type === 'db-context' && n.name === 'AppDbContext');
    assert.ok(ctx, 'AppDbContext context node present');
    const dbSets = (ctx!.metadata?.dbSets as any[]).map(s => s.entity).sort();
    assert.deepEqual(dbSets, ['Order', 'User']);

    // User + Order entities
    const user = result.nodes.find(n => n.type === 'entity' && n.name === 'User');
    const order = result.nodes.find(n => n.type === 'entity' && n.name === 'Order');
    assert.ok(user, 'User entity present');
    assert.ok(order, 'Order entity present');

    const userFields = (user!.metadata?.fields as any[]);
    const idField = userFields.find(f => f.name === 'Id');
    assert.ok(idField && idField.primary, 'User.Id is key');
    const emailField = userFields.find(f => f.name === 'Email');
    assert.ok(emailField && emailField.required && emailField.maxLength === 255, 'Email required + maxLength 255');

    // relation edge User -> Order (navigation List<Order> Orders, one-to-many)
    const relEdge = result.edges.find(
      e => e.type === 'references' && e.source === user!.id && e.target === order!.id
        && e.metadata?.attributes?.kind === 'navigation'
    );
    assert.ok(relEdge, 'User -> Order navigation relation edge present');
    assert.equal(relEdge!.metadata?.attributes?.relationType, 'OneToMany');

    // fluent-API relation from OnModelCreating also captured
    const fluentEdge = result.edges.find(
      e => e.type === 'references' && e.metadata?.attributes?.kind === 'fluent'
    );
    assert.ok(fluentEdge, 'fluent OnModelCreating relation edge present');

    // reverse relation Order -> User (reference nav + [ForeignKey])
    const reverse = result.edges.find(
      e => e.type === 'references' && e.source === order!.id && e.target === user!.id
    );
    assert.ok(reverse, 'Order -> User relation edge present');
  } finally {
    await fs.remove(dir);
  }
});

test('EFCoreAnalyzer supports incremental single-file analysis', async () => {
  const dir = await makeProject();
  try {
    const analyzer = new EFCoreAnalyzer();
    assert.equal(analyzer.supportsIncrementalAnalysis(), true);
    const files = await analyzer.getRelevantFiles!(dir);
    assert.ok(files.some(f => f.endsWith('AppDbContext.cs')));

    const rel = path.join('Data', 'AppDbContext.cs');
    const single = await analyzer.analyzeFileSingle!({
      projectPath: dir,
      filePath: path.join(dir, rel),
      relativePath: rel,
    });
    assert.ok(single.nodes.some(n => n.type === 'db-context' && n.name === 'AppDbContext'));
  } finally {
    await fs.remove(dir);
  }
});
