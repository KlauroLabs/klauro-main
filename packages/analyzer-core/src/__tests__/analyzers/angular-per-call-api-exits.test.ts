jest.unmock('fs-extra');
jest.unmock('fs');
jest.unmock('glob');

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AngularAnalyzer } from '../../analyzer/frameworks/web/angular-analyzer';
import { classifyCommunicationSeams } from '../../analyzer/core/communication-seams';

/**
 * Regression coverage for the per-call Angular HttpClient exit-point
 * extraction (angular-analyzer.ts's extractPerCallApiExits /
 * extractHttpCallsForOwner). Before this fix, an Angular app emitted exactly
 * ONE synthetic `exit_angular_api` exit point (target.endpoint:'various') no
 * matter how many distinct HttpClient calls existed, so no UI flow ever
 * carried evidence of WHICH backend route it calls.
 */
describe('AngularAnalyzer: per-call HttpClient API exit extraction', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'angular-api-exits-'));
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'fixture', dependencies: { '@angular/core': '^17.0.0', '@angular/common': '^17.0.0' } })
    );
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const write = (relative: string, content: string) => {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };

  const apiExits = (cas: any) => (cas.exit_points || []).filter((e: any) => e.type === 'api');

  it('extracts one exit point PER literal-URL call, keyed to the enclosing method', async () => {
    write(
      'src/app/core/services/fuel.service.ts',
      [
        "import { Injectable } from '@angular/core';",
        "import { HttpClient } from '@angular/common/http';",
        '',
        '@Injectable({ providedIn: \'root\' })',
        'export class FuelService {',
        '  constructor(private http: HttpClient) {}',
        '',
        '  getStations() {',
        "    return this.http.get('/api/web/fuel/stations');",
        '  }',
        '',
        '  getCards() {',
        "    return this.http.get('/api/web/fuel/cards');",
        '  }',
        '}',
      ].join('\n')
    );

    const analyzer = new AngularAnalyzer();
    const cas: any = await analyzer.analyze({ projectPath: root } as any);
    const exits = apiExits(cas);

    // Two distinct calls -> two distinct exit points, not one collapsed
    // app-wide placeholder.
    expect(exits.length).toBe(2);
    const stations = exits.find((e: any) => e.target?.endpoint === '/api/web/fuel/stations');
    const cards = exits.find((e: any) => e.target?.endpoint === '/api/web/fuel/cards');
    expect(stations).toBeTruthy();
    expect(cards).toBeTruthy();
    expect(stations.operation?.method).toBe('GET');
    expect(stations.type).toBe('api');

    // Keyed to the enclosing method's own node, not the service or app root.
    const getStationsMethodNode = (cas.nodes || []).find(
      (n: any) => n.type === 'method' && n.name === 'getStations'
    );
    expect(getStationsMethodNode).toBeTruthy();
    expect(stations.source_node).toBe(getStationsMethodNode.id);

    // The old app-wide placeholder must be gone now that real per-call
    // extraction found something.
    expect(exits.some((e: any) => e.target?.endpoint === 'various')).toBe(false);
  });

  it('resolves a template literal with a same-file resolvable base-URL constant to a full literal endpoint', async () => {
    write(
      'src/app/core/services/partner.service.ts',
      [
        "import { Injectable } from '@angular/core';",
        "import { HttpClient } from '@angular/common/http';",
        '',
        '@Injectable({ providedIn: \'root\' })',
        'export class PartnerService {',
        "  private readonly pathPrefixWeb = '/api/web/partner';",
        '',
        '  constructor(private http: HttpClient) {}',
        '',
        '  createCompany(data: unknown) {',
        '    return this.http.post(`${ this.pathPrefixWeb }/companies`, data);',
        '  }',
        '}',
      ].join('\n')
    );

    const analyzer = new AngularAnalyzer();
    const cas: any = await analyzer.analyze({ projectPath: root } as any);
    const exits = apiExits(cas);

    expect(exits.length).toBe(1);
    expect(exits[0].target?.endpoint).toBe('/api/web/partner/companies');
    expect(exits[0].operation?.method).toBe('POST');
    expect(exits[0].metadata?.base_ref).toBe('pathPrefixWeb');
    expect(exits[0].metadata?.base_resolved).toBe(true);
  });

  it('keeps a symbolic (cross-file-unresolvable) template base as a tail-only endpoint tagged base_ref', async () => {
    write(
      'src/app/core/services/devices.service.ts',
      [
        "import { Injectable } from '@angular/core';",
        "import { HttpClient } from '@angular/common/http';",
        '',
        '@Injectable({ providedIn: \'root\' })',
        'export class DevicesService {',
        '  constructor(private http: HttpClient) {}',
        '',
        '  getFuelCards() {',
        '    return this.http.get(`${ environmentBase }/fuel/cards`);',
        '  }',
        '}',
      ].join('\n')
    );

    const analyzer = new AngularAnalyzer();
    const cas: any = await analyzer.analyze({ projectPath: root } as any);
    const exits = apiExits(cas);

    expect(exits.length).toBe(1);
    expect(exits[0].target?.endpoint).toBe('/fuel/cards');
    expect(exits[0].metadata?.base_ref).toBe('environmentBase');
    expect(exits[0].metadata?.base_resolved).toBe(false);
  });

  it('keeps a fully dynamic, unresolvable URL as a call with the endpoint omitted rather than fabricated', async () => {
    write(
      'src/app/core/services/dynamic.service.ts',
      [
        "import { Injectable } from '@angular/core';",
        "import { HttpClient } from '@angular/common/http';",
        '',
        '@Injectable({ providedIn: \'root\' })',
        'export class DynamicService {',
        '  constructor(private http: HttpClient) {}',
        '',
        '  callWhatever(url: string) {',
        '    return this.http.get(url);',
        '  }',
        '}',
      ].join('\n')
    );

    const analyzer = new AngularAnalyzer();
    const cas: any = await analyzer.analyze({ projectPath: root } as any);
    const exits = apiExits(cas);

    expect(exits.length).toBe(1);
    expect(exits[0].target?.endpoint).toBeUndefined();
    expect(exits[0].metadata?.endpoint_unresolved).toBe(true);
    // The 'various' placeholder is still dropped: per-call extraction DID
    // find a real call site, even though this one's endpoint is opaque.
    expect(exits.some((e: any) => e.target?.endpoint === 'various')).toBe(false);
  });

  it('extracts the real HTTP verb from the .request(verb, url) positional-args form', async () => {
    write(
      'src/app/core/services/partner-admin.service.ts',
      [
        "import { Injectable } from '@angular/core';",
        "import { HttpClient } from '@angular/common/http';",
        '',
        '@Injectable({ providedIn: \'root\' })',
        'export class PartnerAdminService {',
        '  constructor(private http: HttpClient) {}',
        '',
        '  removeCompany(companyId: string) {',
        "    return this.http.request('DELETE', `/api/web/partner/companies/${ companyId }`);",
        '  }',
        '}',
      ].join('\n')
    );

    const analyzer = new AngularAnalyzer();
    const cas: any = await analyzer.analyze({ projectPath: root } as any);
    const exits = apiExits(cas);

    expect(exits.length).toBe(1);
    expect(exits[0].operation?.method).toBe('DELETE');
    expect(exits[0].target?.endpoint).toBe('/api/web/partner/companies/:companyId');
  });

  it('keeps the app-wide "various" placeholder when the app imports HttpClient but no per-call extraction fires', async () => {
    write(
      'src/app/core/services/typed-only.service.ts',
      [
        "import { Injectable } from '@angular/core';",
        "import { HttpClient } from '@angular/common/http';",
        '',
        '@Injectable({ providedIn: \'root\' })',
        'export class TypedOnlyService {',
        '  // References HttpClient only as a type; never calls a get/post/etc.',
        '  constructor(private http: HttpClient) {}',
        '}',
      ].join('\n')
    );

    const analyzer = new AngularAnalyzer();
    const cas: any = await analyzer.analyze({ projectPath: root } as any);
    const exits = apiExits(cas);

    expect(exits.length).toBe(1);
    expect(exits[0].target?.endpoint).toBe('various');
  });

  it('a real per-call api exit point survives the library-plumbing seam filter (never a false-positive plumbing drop)', async () => {
    write(
      'src/app/core/services/fuel.service.ts',
      [
        "import { Injectable } from '@angular/core';",
        "import { HttpClient } from '@angular/common/http';",
        '',
        '@Injectable({ providedIn: \'root\' })',
        'export class FuelService {',
        '  constructor(private http: HttpClient) {}',
        '',
        '  getStations() {',
        "    return this.http.get('/api/web/fuel/stations');",
        '  }',
        '}',
      ].join('\n')
    );

    const analyzer = new AngularAnalyzer();
    const cas: any = await analyzer.analyze({ projectPath: root } as any);

    const seamsResult = classifyCommunicationSeams({
      nodes: cas.nodes || [],
      exit_points: cas.exit_points || [],
      entry_points: cas.entry_points || [],
      data_lineage: [],
      data_entities: [],
      deployable_evidence: [],
    });

    const stationsExit = apiExits(cas).find((e: any) => e.target?.endpoint === '/api/web/fuel/stations');
    expect(stationsExit).toBeTruthy();
    const seam = seamsResult.seams.find(s => (s.metadata as any)?.exit_point === stationsExit.id);
    expect(seam).toBeTruthy();
    expect(seam!.modality).toBe('sync');
  });

  it('deduplicates identical (method, path) calls made twice from the same method', async () => {
    write(
      'src/app/core/services/repeat.service.ts',
      [
        "import { Injectable } from '@angular/core';",
        "import { HttpClient } from '@angular/common/http';",
        '',
        '@Injectable({ providedIn: \'root\' })',
        'export class RepeatService {',
        '  constructor(private http: HttpClient) {}',
        '',
        '  refreshTwice() {',
        "    this.http.get('/api/web/status').subscribe();",
        "    return this.http.get('/api/web/status');",
        '  }',
        '}',
      ].join('\n')
    );

    const analyzer = new AngularAnalyzer();
    const cas: any = await analyzer.analyze({ projectPath: root } as any);
    const exits = apiExits(cas);

    expect(exits.length).toBe(1);
    expect(exits[0].target?.endpoint).toBe('/api/web/status');
  });
});
