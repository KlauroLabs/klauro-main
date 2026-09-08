jest.unmock('fs');
jest.unmock('fs-extra');
jest.unmock('glob');

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { BaseAnalyzer, FileAnalysisContext } from '../../analyzer/core/base-analyzer';
import { RubyAnalyzer } from '../../analyzer/languages/ruby-analyzer';
import { NestJSAnalyzer } from '../../analyzer/frameworks/web/nestjs-analyzer';
import { DiContainerBindingAnalyzer } from '../../analyzer/libraries/architecture/di-container-analyzer';
import { ReactRouterAnalyzer } from '../../analyzer/libraries/routing/react-router-analyzer';
import type { CASContribution, CASNode } from '../../types/cas.types';

const cases: Array<{
  name: string;
  analyzer: () => BaseAnalyzer;
  file: string;
  source: string;
  target: CASNode;
  dependencies?: Record<string, string>;
}> = [
  {
    name: 'Ruby inheritance',
    analyzer: () => new RubyAnalyzer(),
    file: 'child.rb',
    source: 'class Child < Parent\nend\n',
    target: { id: 'retained-parent', name: 'Parent', type: 'class', source: { file: 'parent.rb' } },
  },
  {
    name: 'NestJS dependency injection',
    analyzer: () => new NestJSAnalyzer(),
    file: 'booking.service.ts',
    source: "import { Injectable } from '@nestjs/common';\n@Injectable()\nexport class BookingService {\n constructor(private readonly repository: BookingRepository) {}\n}\n",
    target: { id: 'retained-repository', name: 'BookingRepository', type: 'repository', source: { file: 'booking.repository.ts' } },
    dependencies: { '@nestjs/common': '10.0.0' },
  },
  {
    name: 'DI implementation binding',
    analyzer: () => new DiContainerBindingAnalyzer(),
    file: 'container.ts',
    source: "import { Container } from 'inversify';\nconst container = new Container();\ncontainer.bind<IFooService>(TYPES.FooService).to(FooService).inSingletonScope();\n",
    target: { id: 'retained-service', name: 'FooService', type: 'class', source: { file: 'foo-service.ts' } },
    dependencies: { inversify: '6.0.2' },
  },
  {
    name: 'React Router component rendering',
    analyzer: () => new ReactRouterAnalyzer(),
    file: 'routes.tsx',
    source: 'import { Route, Routes } from "react-router-dom";\nexport function App() { return <Routes><Route path="/bookings" element={<Bookings />} /></Routes>; }\n',
    target: { id: 'retained-component', name: 'Bookings', type: 'functional_component', source: { file: 'Bookings.tsx' } },
    dependencies: { 'react-router-dom': '6.0.0' },
  },
];

describe('file-scoped recomputation preserves upstream relationships', () => {
  it.each(cases)('$name observes retained-node mutation and restoration', async fixture => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'incremental-upstream-'));
    try {
      const filePath = path.join(projectPath, fixture.file);
      await fs.writeFile(filePath, fixture.source);
      if (fixture.dependencies) await fs.writeJson(path.join(projectPath, 'package.json'), { dependencies: fixture.dependencies });
      const target = structuredClone(fixture.target);
      const contribution: CASContribution = {
        nodes: [target], edges: [], entry_points: [], exit_points: [],
        analyzer_metadata: {
          analyzer_id: 'retained', analyzer_name: 'Retained Analysis', version: '1',
          contribution_type: 'language', nodes_contributed: 1, edges_contributed: 0,
        },
      };
      const context: FileAnalysisContext = { projectPath, filePath, relativePath: fixture.file, existingAnalysis: [contribution] };
      const analyzer = fixture.analyzer();
      expect(analyzer.incrementalContributionScope()).toBe('file');
      expect(analyzer.incrementalFileCachePolicy()).toBe('recompute');
      const original = await analyzer.analyzeFileSingle!(context);
      expect(original.edges.some(edge => edge.target === target.id)).toBe(true);
      target.name = 'UnrelatedType';
      const changed = await analyzer.analyzeFileSingle!(context);
      expect(changed.edges.some(edge => edge.target === target.id)).toBe(false);
      target.name = fixture.target.name;
      const restored = await analyzer.analyzeFileSingle!(context);
      expect(restored).toEqual(original);
    } finally {
      await fs.remove(projectPath);
    }
  });
});
