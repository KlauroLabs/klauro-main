import { parseSqlTables } from '../../analyzer/languages/sql-schema-analyzer';

// WHY: measured 2026-08-11 on a real repo. `.sql` was claimed by no language and
// no code anywhere read CREATE TABLE, so a TypeScript backend persisting through
// raw `pg` queries produced ZERO domain entities — and because capability<->flow
// linkage is entity-driven, all 38 of that repo's flows reported
// `no-entity-evidence` and flows_to_capabilities was 0/38. Flows named
// `POST / (SongService)` sat unlinked while the tables they write were declared
// in a schema.sql in plain sight.
const REAL_SHAPE = `
-- Postgres schema, the shape that produced zero entities
CREATE TABLE IF NOT EXISTS voice_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  profile_type VARCHAR(50) NOT NULL,
  display_name TEXT,
  is_public BOOLEAN DEFAULT false,
  customization_settings JSONB,
  price NUMERIC(10,2),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE generation_jobs (
  id UUID,
  song_version_id UUID,
  status TEXT NOT NULL,
  started_at TIMESTAMPTZ,
  PRIMARY KEY (id),
  FOREIGN KEY (song_version_id) REFERENCES song_versions (id)
);

/* A commented-out declaration must never count as evidence.
CREATE TABLE ghost_table (id INT);
*/
-- CREATE TABLE also_ghost (id INT);
`;

test('tables and columns are extracted from real-world DDL', () => {
  const tables = parseSqlTables(REAL_SHAPE);
  expect(tables.map(t => t.name)).toEqual(['voice_profiles', 'generation_jobs']);

  const profiles = tables[0];
  expect(profiles.columns.length).toBe(8); // every declared column, and no constraint rows
  const byName = new Map(profiles.columns.map(c => [c.name, c]));
  expect(byName.get('id')?.primaryKey).toBe(true);
  expect(byName.get('user_id')?.nullable).toBe(false); // NOT NULL is an explicit declaration
  expect(byName.get('display_name')?.nullable).toBe(true); // absent NOT NULL means nullable
  expect(byName.get('user_id')?.references).toEqual({ table: 'users', column: 'id' });
  // NUMERIC(10,2) must not split on its internal comma.
  expect(byName.get('price')?.type).toBe('NUMERIC(10,2)');
});

test('table-level PRIMARY KEY and FOREIGN KEY constraints are honoured', () => {
  const jobs = parseSqlTables(REAL_SHAPE)[1];
  const byName = new Map(jobs.columns.map(c => [c.name, c]));
  expect(byName.get('id')?.primaryKey).toBe(true); // PRIMARY KEY (id) declared at table level
  // FOREIGN KEY ... REFERENCES is the deterministic ground for ERD cardinality.
  expect(byName.get('song_version_id')?.references).toEqual({ table: 'song_versions', column: 'id' });
});

test('commented-out declarations are not evidence', () => {
  const names = parseSqlTables(REAL_SHAPE).map(t => t.name);
  expect(names).not.toContain('ghost_table'); // block-commented CREATE TABLE must be ignored
  expect(names).not.toContain('also_ghost'); // line-commented CREATE TABLE must be ignored
});

test('a re-declared table across migrations is one entity, not several', () => {
  const tables = parseSqlTables(`
    CREATE TABLE songs (id INT PRIMARY KEY, title TEXT);
    DROP TABLE songs;
    CREATE TABLE songs (id INT PRIMARY KEY, title TEXT, artist TEXT);
  `);
  expect(tables.length).toBe(1); // the canonical first declaration wins
});

test('schema-qualified and quoted identifiers resolve to the bare table name', () => {
  const tables = parseSqlTables(`
    CREATE TABLE public."Audio_Files" ("Id" INT PRIMARY KEY, path TEXT NOT NULL);
    CREATE TABLE \`backtick_table\` (id INT PRIMARY KEY, x TEXT);
  `);
  expect(tables.map(t => t.name)).toEqual(['Audio_Files', 'backtick_table']);
});

test('files with no table declaration yield nothing rather than a guess', () => {
  expect(parseSqlTables('SELECT * FROM songs; INSERT INTO songs VALUES (1);').length).toBe(0);
  expect(parseSqlTables('CREATE TABLE broken (id INT').length).toBe(0); // unbalanced parens are skipped, not guessed
});
