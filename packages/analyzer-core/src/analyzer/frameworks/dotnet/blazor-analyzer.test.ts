import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import { BlazorAnalyzer } from './blazor-analyzer';

async function makeProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'blazor-analyzer-test-'));

  await fs.writeFile(path.join(dir, 'BlazorApp.csproj'), [
    '<Project Sdk="Microsoft.NET.Sdk.Web">',
    '  <ItemGroup>',
    '    <PackageReference Include="Microsoft.AspNetCore.Components" Version="8.0.0" />',
    '  </ItemGroup>',
    '</Project>',
    ''
  ].join('\n'));

  const pages = path.join(dir, 'Pages');
  const shared = path.join(dir, 'Shared');
  await fs.ensureDir(pages);
  await fs.ensureDir(shared);

  await fs.writeFile(path.join(pages, 'Counter.razor'), [
    '@page "/counter"',
    '@inject IClock Clock',
    '',
    '<h1>@Title</h1>',
    '<p>Current count: @count</p>',
    '<button class="btn" @onclick="Increment">Click me</button>',
    '',
    '<NavMenu Title="@Title" />',
    '',
    '@code {',
    '    private int count;',
    '    [Parameter] public string Title { get; set; }',
    '',
    '    protected override void OnInitialized()',
    '    {',
    '        count = 0;',
    '    }',
    '',
    '    void Increment() { count++; }',
    '}',
    ''
  ].join('\n'));

  await fs.writeFile(path.join(shared, 'NavMenu.razor'), [
    '<nav>',
    '    <span>@Title</span>',
    '</nav>',
    '',
    '@code {',
    '    [Parameter] public string Title { get; set; }',
    '}',
    ''
  ].join('\n'));

  return dir;
}

test('BlazorAnalyzer detects components, pages, parameters, handlers, and composition', async () => {
  const dir = await makeProject();
  try {
    const analyzer = new BlazorAnalyzer();

    assert.equal(await analyzer.canAnalyze(dir), true, 'canAnalyze should be true for a Blazor project');

    const result = await analyzer.analyze({ projectPath: dir });

    // Components
    const components = result.nodes.filter(n => n.type === 'blazor-component');
    const counter = components.find(n => n.name === 'Counter');
    const navMenu = components.find(n => n.name === 'NavMenu');
    assert.ok(counter, 'expected a Counter blazor-component node');
    assert.ok(navMenu, 'expected a NavMenu blazor-component node');

    // @page /counter route + page entry point
    const routeNode = result.nodes.find(n => n.type === 'route' && n.name === '/counter');
    assert.ok(routeNode, 'expected a /counter route node');
    const pageEntry = result.entry_points.find(
      e => e.metadata?.entry_type === 'blazor-page' && e.metadata?.path === '/counter'
    );
    assert.ok(pageEntry, 'expected a /counter page entry point');

    // Title parameter
    const titleParam = result.nodes.find(
      n => n.type === 'parameter' && n.name === 'Title' && n.parent === counter!.id
    );
    assert.ok(titleParam, 'expected a Title parameter node on Counter');
    assert.equal(titleParam!.metadata?.attributes?.parameter_type, 'string');

    // Increment handler linked to @onclick
    const handlerNode = result.nodes.find(
      n => n.type === 'event_handler' &&
           n.metadata?.attributes?.event === 'onclick' &&
           n.metadata?.attributes?.method === 'Increment'
    );
    assert.ok(handlerNode, 'expected an onclick=Increment event_handler node');
    assert.equal(handlerNode!.metadata?.attributes?.resolved_to_code_method, true,
      'Increment should resolve to a @code method');
    const handlesEdge = result.edges.find(
      e => e.type === 'handles-event' && e.source === counter!.id && e.target === handlerNode!.id
    );
    assert.ok(handlesEdge, 'expected a handles-event edge from Counter to the handler');

    // Component-usage edge Counter -> NavMenu
    const usesEdge = result.edges.find(
      e => e.type === 'uses' && e.source === counter!.id && e.target === navMenu!.id
    );
    assert.ok(usesEdge, 'expected a component-usage edge from Counter to NavMenu');
    assert.deepEqual(
      usesEdge!.metadata?.attributes?.passed_parameters,
      ['Title'],
      'NavMenu usage should record the passed Title parameter'
    );

    // DI: injected IClock service surfaces as an exit point
    const injectExit = result.exit_points.find(
      e => e.metadata?.injected_type === 'IClock'
    );
    assert.ok(injectExit, 'expected an injected IClock service exit point');
  } finally {
    await fs.remove(dir);
  }
});
