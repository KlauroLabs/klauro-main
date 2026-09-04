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
    const { roots, source } = declaredProductRoots(dir);
    expect(source).toBe('package.json');
    expect(isWithinDeclaredRoots('lib/router/index.js', roots)).toBe(true);
    expect(isWithinDeclaredRoots('index.js', roots)).toBe(true);
    expect(isWithinDeclaredRoots('examples/hello-world/index.js', roots)).toBe(false);
    expect(isWithinDeclaredRoots('test/app.js', roots)).toBe(false);
  });

  it('falls back to main/bin when there is no files list, and to no restriction when there is neither', async () => {
    await fs.writeJson(path.join(dir, 'package.json'), { name: 'a', main: 'src/index.js', bin: { a: 'bin/a.js' } });
    expect(declaredProductRoots(dir).roots).toEqual(['bin/a.js', 'src/index.js']);
    await fs.writeJson(path.join(dir, 'package.json'), { name: 'b' });
    expect(declaredProductRoots(dir).roots).toEqual([]);
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
    expect(declaredProductRoots(dir).roots).toEqual(['src/x', 'src/y']);
  });

  it('treats a Cargo crate as shipping src/ plus any declared bin or lib paths', async () => {
    await fs.writeFile(path.join(dir, 'Cargo.toml'), '[package]\nname = "c"\n[[bin]]\nname = "tool"\npath = "tools/main.rs"\n');
    await fs.ensureDir(path.join(dir, 'src'));
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
    expect(declaredProductRoots(dir).roots).toEqual(['src']);
  });

  it('records nothing for a repository with no manifest', () => {
    expect(declaredProductRoots(dir)).toEqual({ roots: [] });
  });
});
