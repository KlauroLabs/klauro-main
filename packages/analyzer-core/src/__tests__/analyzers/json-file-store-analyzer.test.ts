import {
  detectJsonFileStores,
  entityNameFromJsonFile,
  jsonFileNameFrom,
  serializedFieldNames,
} from '../../analyzer/languages/json-file-store-analyzer';

// WHY: measured 2026-08-11 on a real repo. `persistence: 'sql-table'` was the ONLY
// persistence the product recognised anywhere, so a gateway/CLI repo with no ORM and
// no DDL — state kept in JSON files that modules read and write — shipped
// `data.entities: 0`, every capability with `entities: []`, and the caveat "No data
// lineage derived". Entity-driven capability<->flow linkage was starved for an entire
// class of repos.

describe('JSON file store detection', () => {
  it('recognises a read-write round trip as a persisted store and reads its literal shape', () => {
    const stores = detectJsonFileStores(`
      const path = require('path');
      const STATE = path.join(dataDir, 'google-state.json');
      function load() {
        const raw = fs.readFileSync(STATE, 'utf8');
        return JSON.parse(raw);
      }
      function save(state) {
        fs.writeFileSync(STATE, JSON.stringify({
          accounts: state.accounts,
          refreshToken: state.refreshToken,
          syncedAt: Date.now(),
        }, null, 2));
      }
    `);
    expect(stores).toHaveLength(1);
    expect(stores[0].storePath).toBe('google-state.json');
    expect(stores[0].entityName).toBe('GoogleState');
    expect(stores[0].fields).toEqual(['accounts', 'refreshToken', 'syncedAt']);
  });

  // A write-only path is an export or a log; a read-only path is configuration or a
  // fixture. Reporting either as a persisted entity would be the fabrication this
  // analyzer exists to avoid.
  it('does not report a write-only path, nor a read-only one', () => {
    const writeOnly = detectJsonFileStores(`
      fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ total: 1 }));
    `);
    expect(writeOnly).toHaveLength(0);

    const readOnly = detectJsonFileStores(`
      const cfg = JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'));
    `);
    expect(readOnly).toHaveLength(0);
  });

  it('requires the payload to be serialised JSON, not any file write', () => {
    const templateWrite = detectJsonFileStores(`
      const P = 'notes.json';
      const existing = fs.readFileSync(P, 'utf8');
      JSON.parse(existing);
      fs.writeFileSync(P, renderTemplate(existing));
    `);
    expect(templateWrite).toHaveLength(0);
  });

  it('treats fs-extra writeJson/readJson as serialising by contract', () => {
    const stores = detectJsonFileStores(`
      await fs.readJson(path.join(dir, 'topic-registry.json'));
      await fs.writeJson(path.join(dir, 'topic-registry.json'), { topics, updatedAt });
    `);
    expect(stores.map(store => store.entityName)).toEqual(['TopicRegistry']);
    expect(stores[0].fields).toEqual(['topics', 'updatedAt']);
  });

  // A store whose shape is a variable is still a store — the honest result is an
  // entity with no fields, never an invented schema.
  it('records a store with no fields when the serialised shape is not statically visible', () => {
    const stores = detectJsonFileStores(`
      const F = 'nodes.json';
      const all = JSON.parse(fs.readFileSync(F, 'utf8'));
      fs.writeFileSync(F, JSON.stringify(all));
    `);
    expect(stores).toHaveLength(1);
    expect(stores[0].entityName).toBe('Nodes');
    expect(stores[0].fields).toEqual([]);
  });

  it('ignores package-manager and tooling metadata files', () => {
    expect(jsonFileNameFrom("path.join(root, 'package.json')")).toBeUndefined();
    expect(jsonFileNameFrom("'tsconfig.json'")).toBeUndefined();
    expect(jsonFileNameFrom("path.join(root, 'agent-state.json')")).toBe('agent-state.json');
  });

  it('derives the entity name from the file, mechanically', () => {
    expect(entityNameFromJsonFile('google-state.json')).toBe('GoogleState');
    expect(entityNameFromJsonFile('topics.json')).toBe('Topics');
    expect(entityNameFromJsonFile('agent_registry.json')).toBe('AgentRegistry');
  });

  it('does not let a nested object end the field scan early', () => {
    expect(serializedFieldNames("JSON.stringify({ id, meta: { a: 1, b: [2, 3] }, name })"))
      .toEqual(['id', 'meta', 'name']);
  });

  it('detects several stores owned by one module, in a stable order', () => {
    const stores = detectJsonFileStores(`
      const A = 'accounts.json', B = 'sessions.json';
      JSON.parse(fs.readFileSync(A, 'utf8'));
      JSON.parse(fs.readFileSync(B, 'utf8'));
      fs.writeFileSync(A, JSON.stringify({ accounts: [] }));
      fs.writeFileSync(B, JSON.stringify({ sessions: [] }));
    `);
    expect(stores.map(store => store.storePath)).toEqual(['accounts.json', 'sessions.json']);
  });
});
