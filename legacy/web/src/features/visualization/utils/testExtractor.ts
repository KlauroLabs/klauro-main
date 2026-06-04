import {
  CASOutput,
  CASNode,
  EntryPoint,
  CASTestSuite,
  CASTestCase,
  CASMock,
  CASTestSummary,
} from '../../../types/cas.types';
import { TestSection } from '../types/sections';

export interface TestArea {
  id: string;
  name: string;
  description: string;
  tests: TestEntry[];
  stats: {
    total: number;
    byType: {
      unit: number;
      integration: number;
      e2e: number;
      acceptance: number;
    };
    bddCount: number;
    mockCount: number;
    coveragePercent?: number;
  };
}

export interface TestEntry {
  id: string;
  name: string;
  description?: string;
  testType: 'unit' | 'integration' | 'e2e' | 'acceptance' | 'bdd' | 'other';
  testStyle: 'procedural' | 'bdd' | 'property-based' | 'snapshot' | 'parameterized';
  framework: string;
  usesMocks: boolean;
  isAsync: boolean;
  file?: string;
  line?: number;
  entryPointId?: string;
  nodeId?: string;
  assertions?: number;
  bddSteps?: Array<{
    type: 'given' | 'when' | 'then' | 'and' | 'but';
    text: string;
  }>;
  mocksUsed?: string[];
  targets?: string[];
}

export interface TestSummaryData {
  totalTests: number;
  byType: {
    unit: number;
    integration: number;
    e2e: number;
    acceptance: number;
    bdd: number;
    other: number;
  };
  byStatus: {
    passing: number;
    failing: number;
    skipped: number;
    flaky: number;
  };
  coveragePercent?: number;
  mockCount: number;
  fixtureCount: number;
  topAreas: Array<{ name: string; count: number }>;
}

const TEST_AREA_COLORS: string[] = [
  '#00bcd4', '#26c6da', '#4dd0e1', '#80deea',
  '#00acc1', '#0097a7', '#00838f', '#006064',
];

function getTestAreaColor(index: number): string {
  return TEST_AREA_COLORS[index % TEST_AREA_COLORS.length];
}

function inferTestTypeFromMetadata(metadata: Record<string, any> | undefined): TestEntry['testType'] {
  if (!metadata) return 'unit';

  const testType = metadata.test_type || metadata.testType;
  if (testType) {
    const normalized = testType.toLowerCase();
    if (['unit', 'integration', 'e2e', 'acceptance', 'bdd'].includes(normalized)) {
      return normalized as TestEntry['testType'];
    }
  }
  return 'unit';
}

function inferTestStyleFromMetadata(metadata: Record<string, any> | undefined): TestEntry['testStyle'] {
  if (!metadata) return 'procedural';

  const testStyle = metadata.test_style || metadata.testStyle;
  if (testStyle) {
    const normalized = testStyle.toLowerCase();
    if (['procedural', 'bdd', 'property-based', 'snapshot', 'parameterized'].includes(normalized)) {
      return normalized as TestEntry['testStyle'];
    }
  }
  return 'procedural';
}

function inferTestAreaFromPath(filePath: string): string {
  const parts = filePath.split('/');

  const testsIndex = parts.findIndex(p => p === 'tests' || p === '__tests__' || p === 'test');
  if (testsIndex !== -1 && testsIndex < parts.length - 1) {
    const areaSegment = parts[testsIndex + 1];
    if (areaSegment && !areaSegment.includes('.')) {
      return formatAreaName(areaSegment);
    }
  }

  const srcIndex = parts.findIndex(p => p === 'src');
  if (srcIndex !== -1 && srcIndex < parts.length - 2) {
    return formatAreaName(parts[srcIndex + 1]);
  }

  const fileName = parts[parts.length - 1] || '';
  const baseName = fileName.replace(/\.(test|spec)\.(ts|js|tsx|jsx|rs)$/, '');
  return formatAreaName(baseName);
}

function formatAreaName(name: string): string {
  return name
    .replace(/-/g, ' ')
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

export function extractTestSummary(cas: CASOutput): TestSummaryData {
  const entryPoints = cas.entry_points || [];
  const testEntryPoints = entryPoints.filter(ep => ep.type === 'test');

  const testAreas = extractTestAreas(cas);

  const byType = {
    unit: 0,
    integration: 0,
    e2e: 0,
    acceptance: 0,
    bdd: 0,
    other: 0,
  };

  let mockCount = 0;
  let skippedCount = 0;

  testEntryPoints.forEach(ep => {
    const metadata = ep.metadata as Record<string, any>;
    const testType = inferTestTypeFromMetadata(metadata);

    if (testType in byType) {
      byType[testType as keyof typeof byType]++;
    } else {
      byType.other++;
    }

    if (metadata?.uses_mocks || metadata?.usesMocks) {
      mockCount++;
    }

    if (metadata?.skipped) {
      skippedCount++;
    }

    const testStyle = inferTestStyleFromMetadata(metadata);
    if (testStyle === 'bdd') {
      byType.bdd++;
    }
  });

  const topAreas = testAreas
    .map(area => ({ name: area.name, count: area.stats.total }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  return {
    totalTests: testEntryPoints.length,
    byType,
    byStatus: {
      passing: testEntryPoints.length - skippedCount,
      failing: 0,
      skipped: skippedCount,
      flaky: 0,
    },
    coveragePercent: cas.test_summary?.coverage?.overall_percentage,
    mockCount,
    fixtureCount: cas.fixtures?.length || 0,
    topAreas,
  };
}

export function extractTestAreas(cas: CASOutput): TestArea[] {
  const entryPoints = cas.entry_points || [];
  const testEntryPoints = entryPoints.filter(ep => ep.type === 'test');

  const areaMap = new Map<string, {
    tests: TestEntry[];
    byType: { unit: number; integration: number; e2e: number; acceptance: number };
    bddCount: number;
    mockCount: number;
  }>();

  testEntryPoints.forEach(ep => {
    const metadata = ep.metadata as Record<string, any>;
    const file = ep.handler?.file || metadata?.file || '';
    const areaName = inferTestAreaFromPath(file);

    if (!areaMap.has(areaName)) {
      areaMap.set(areaName, {
        tests: [],
        byType: { unit: 0, integration: 0, e2e: 0, acceptance: 0 },
        bddCount: 0,
        mockCount: 0,
      });
    }

    const area = areaMap.get(areaName)!;

    const testType = inferTestTypeFromMetadata(metadata);
    const testStyle = inferTestStyleFromMetadata(metadata);
    const usesMocks = metadata?.uses_mocks || metadata?.usesMocks || false;

    const testEntry: TestEntry = {
      id: ep.id,
      name: ep.name,
      description: ep.description,
      testType,
      testStyle,
      framework: metadata?.framework || 'unknown',
      usesMocks,
      isAsync: metadata?.is_async || metadata?.isAsync || false,
      file,
      line: ep.handler?.line,
      entryPointId: ep.id,
      nodeId: ep.handler?.node_id,
      assertions: metadata?.assertionCount,
    };

    area.tests.push(testEntry);

    if (testType in area.byType) {
      area.byType[testType as keyof typeof area.byType]++;
    }

    if (testStyle === 'bdd') {
      area.bddCount++;
    }

    if (usesMocks) {
      area.mockCount++;
    }
  });

  const areas: TestArea[] = [];
  let colorIndex = 0;

  areaMap.forEach((data, areaName) => {
    areas.push({
      id: areaName.toLowerCase().replace(/\s+/g, '-'),
      name: areaName,
      description: `Tests for ${areaName.toLowerCase()}`,
      tests: data.tests,
      stats: {
        total: data.tests.length,
        byType: data.byType,
        bddCount: data.bddCount,
        mockCount: data.mockCount,
      },
    });
    colorIndex++;
  });

  return areas.sort((a, b) => b.stats.total - a.stats.total);
}

export function extractTestsFromSuites(cas: CASOutput): TestEntry[] {
  const tests: TestEntry[] = [];
  const testSuites = cas.test_suites || [];

  testSuites.forEach(suite => {
    suite.tests.forEach(test => {
      tests.push({
        id: test.id,
        name: test.name,
        description: test.description,
        testType: test.test_type,
        testStyle: 'procedural',
        framework: suite.framework,
        usesMocks: (test.mocks_used?.length || 0) > 0,
        isAsync: false,
        file: suite.file_path,
        bddSteps: test.bdd_steps,
        mocksUsed: test.mocks_used,
        targets: test.targets,
      });
    });
  });

  return tests;
}

export function filterTestsByType(tests: TestEntry[], type: TestEntry['testType']): TestEntry[] {
  return tests.filter(t => t.testType === type);
}

export function filterTestsByStyle(tests: TestEntry[], style: TestEntry['testStyle']): TestEntry[] {
  return tests.filter(t => t.testStyle === style);
}

export function filterTestsWithMocks(tests: TestEntry[]): TestEntry[] {
  return tests.filter(t => t.usesMocks);
}

export function filterBddTests(tests: TestEntry[]): TestEntry[] {
  return tests.filter(t => t.testStyle === 'bdd' || (t.bddSteps && t.bddSteps.length > 0));
}

export function convertToTestSection(area: TestArea, index: number): TestSection {
  return {
    id: area.id,
    type: 'test-suite',
    name: area.name,
    description: area.description,
    color: getTestAreaColor(index),
    icon: 'science',
    capabilities: area.tests.map(test => ({
      id: test.id,
      name: test.name,
      description: test.description,
      requiresAuth: false,
      entryPoint: test.entryPointId ? {
        id: test.entryPointId,
        type: 'test',
      } : undefined,
      metadata: {
        testType: test.testType,
        testStyle: test.testStyle,
        framework: test.framework,
        usesMocks: test.usesMocks,
        isAsync: test.isAsync,
      },
    })),
    stats: {
      entryPoints: area.stats.total,
      hasAuth: false,
      hasDatabase: false,
      hasExternalCalls: false,
    },
    testStats: {
      byType: area.stats.byType,
      bddCount: area.stats.bddCount,
      mockCount: area.stats.mockCount,
    },
  };
}

export function getMocksForArea(cas: CASOutput, areaId: string): CASMock[] {
  const mocks = cas.mocks || [];
  const area = extractTestAreas(cas).find(a => a.id === areaId);
  if (!area) return [];

  const testIds = new Set(area.tests.map(t => t.id));
  return mocks.filter(mock =>
    mock.used_by?.some(id => testIds.has(id))
  );
}
