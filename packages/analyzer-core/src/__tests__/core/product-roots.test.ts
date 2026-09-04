import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { declaredProductRoots, isWithinDeclaredRoots } from '../../analyzer/core/product-roots';

describe('declaredProductRoots', () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-roots-')); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it('reads the npm publish allow-list, so examples and tests are outside the product', async () => {
    // The shape of a real web framework: it ships index.js and lib/, and keeps
    // examples/ and test/ beside them. Those had been producing entry points that
    // made the framework look like an application.
    await fs.writeJson(path.join(dir, 'package.json'), { name: 'fw', files: ['LICENSE', 'Readme.md', 'index.js', 'lib/'] });
    await fs.writeFile(path.join(dir, 'index.js'), '');
    await fs.ensureDir(path.join(dir, 'lib'));
    await fs.ensureDir(path.join(dir, 'examples'));
    const { roots, source } = declaredProductRoots(dir);
    expect(source).toBe('package.json');
    expect(isWithinDeclaredRoots('lib/router/index.js', roots)).toBe(true);
    expect(isWithinDeclaredRoots('index.js', roots)).toBe(true);
    expect(isWithinDeclaredRoots('examples/hello-world/index.js', roots)).toBe(false);
    expect(isWithinDeclaredRoots('test/app.js', roots)).toBe(false);
  });

  it('never treats main or bin as a boundary on their own', async () => {
    // `main: dist/analyzer/index.js` is exactly the shape that excluded every
    // src/ node in this repository's own tests: it names a build artifact, not the
    // source tree, and dist/ does not even exist in a checkout.
    await fs.writeJson(path.join(dir, 'package.json'), { name: 'a', main: 'dist/analyzer/index.js', bin: { a: 'bin/a.js' } });
    await fs.ensureDir(path.join(dir, 'src'));
    expect(declaredProductRoots(dir).roots).toEqual([]);
  });

  it('ignores a files allow-list whose entries are absent from the checkout', async () => {
    // A library that publishes only its build output: `files: ["dist"]` with no
    // dist/ present. No boundary can be built from missing paths, so no restriction.
    await fs.writeJson(path.join(dir, 'package.json'), { name: 'lib', files: ['dist'], main: 'dist/index.js' });
    await fs.ensureDir(path.join(dir, 'src'));
    expect(declaredProductRoots(dir).roots).toEqual([]);
  });

  it('adds main and bin to an existing files boundary', async () => {
    await fs.writeJson(path.join(dir, 'package.json'), { name: 'c', files: ['lib/'], main: 'index.js' });
    await fs.ensureDir(path.join(dir, 'lib'));
    await fs.writeFile(path.join(dir, 'index.js'), '');
    expect(declaredProductRoots(dir).roots).toEqual(['index.js', 'lib']);
  });

  it('uses the pyproject default package layout, so docs_src is outside the product', async () => {
    // A Python framework whose tutorial source lives in docs_src/ next to the real
    // package. Those tutorials had supplied the entities and the domain.
    await fs.writeFile(path.join(dir, 'pyproject.toml'), '[project]\nname = "fast-api"\n');
    await fs.ensureDir(path.join(dir, 'fast_api'));
    await fs.ensureDir(path.join(dir, 'docs_src'));
    const { roots, source } = declaredProductRoots(dir);
    expect(source).toBe('pyproject.toml');
    expect(roots).toEqual(['fast_api']);
    expect(isWithinDeclaredRoots('docs_src/tutorial/heroes.py', roots)).toBe(false);
  });

  it('prefers an explicit packages declaration over the default layout', async () => {
    await fs.writeFile(path.join(dir, 'pyproject.toml'), '[project]\nname = "x"\n[tool.hatch.build]\npackages = ["src/x", "src/y"]\n');
    await fs.ensureDir(path.join(dir, 'src/x'));
    await fs.ensureDir(path.join(dir, 'src/y'));
    expect(declaredProductRoots(dir).roots).toEqual(['src/x', 'src/y']);
  });

  it('treats a Cargo crate as shipping src/ plus any declared bin or lib paths', async () => {
    await fs.writeFile(path.join(dir, 'Cargo.toml'), '[package]\nname = "c"\n[[bin]]\nname = "tool"\npath = "tools/main.rs"\n');
    await fs.ensureDir(path.join(dir, 'src'));
    await fs.ensureDir(path.join(dir, 'tools'));
    await fs.writeFile(path.join(dir, 'tools/main.rs'), '');
    expect(declaredProductRoots(dir).roots).toEqual(['src', 'tools/main.rs']);
  });

  it('applies no restriction to a Composer application skeleton', async () => {
    // routes/, config/ and resources/ are product but never appear in autoload,
    // so autoload cannot be the boundary of a `project`.
    await fs.writeJson(path.join(dir, 'composer.json'), { type: 'project', autoload: { 'psr-4': { 'App\\': 'app/' } } });
    expect(declaredProductRoots(dir).roots).toEqual([]);
  });

  it('uses a Composer library autoload map as its boundary', async () => {
    await fs.writeJson(path.join(dir, 'composer.json'), { type: 'library', autoload: { 'psr-4': { 'Vendor\\Lib\\': 'src/' } } });
    await fs.ensureDir(path.join(dir, 'src'));
    expect(declaredProductRoots(dir).roots).toEqual(['src']);
  });

  it('records nothing for a repository with no manifest', () => {
    expect(declaredProductRoots(dir)).toEqual({ roots: [] });
  });
});
