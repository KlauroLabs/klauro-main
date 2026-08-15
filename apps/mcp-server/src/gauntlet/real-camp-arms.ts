

















import { execFileSync } from 'child_process';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';


export function scipCliPath(): string | null {
  const candidates = [path.join(os.homedir(), 'go', 'bin', 'scip'), 'scip'];
  for (const c of candidates) {
    try {
      execFileSync(c, ['--version'], { stdio: 'ignore' });
      return c;
    } catch {

    }
  }
  return null;
}

export function scipTypescriptAvailable(): boolean {
  try {
    execFileSync('scip-typescript', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}




function symbolNamesMethod(symbol: string, className: string, methodName: string): boolean {
  if (!symbol) return false;

  const re = new RegExp(`[#.\\/]${className}#${methodName}\\b`);
  if (re.test(symbol)) return true;

  return symbol.includes(`${className}#${methodName}`);
}

export interface ScipCallersResult {
  files: string[];
  ms: number;
  indexBytes: number;
  available: true;
}







export function scipCallers(
  dir: string,
  className: string,
  methodName: string,
): ScipCallersResult | null {
  const scip = scipCliPath();
  if (!scip || !scipTypescriptAvailable()) return null;

  const t0 = Date.now();
  const indexPath = path.join(dir, 'index.scip');
  try {

    execFileSync('scip-typescript', ['index', '--infer-tsconfig', '--output', indexPath], {
      cwd: dir,
      stdio: 'ignore',
      timeout: 180_000,
    });
  } catch {
    try { fs.removeSync(indexPath); } catch {   }
    return null;
  }

  let indexBytes = 0;
  try { indexBytes = fs.statSync(indexPath).size; } catch {   }

  let json = '';
  try {
    json = execFileSync(scip, ['print', '--json', indexPath], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch {
    try { fs.removeSync(indexPath); } catch {   }
    return null;
  }
  try { fs.removeSync(indexPath); } catch {   }

  const files = new Set<string>();
  try {
    const doc = JSON.parse(json);
    for (const d of doc.documents || []) {
      const rel: string = d.relative_path || d.relativePath || '';
      for (const occ of d.occurrences || []) {
        const sym: string = occ.symbol || '';
        const roles: number = occ.symbol_roles ?? occ.symbolRoles ?? 0;
        const isDefinition = (roles & 1) === 1;
        if (!isDefinition && symbolNamesMethod(sym, className, methodName)) {
          files.add(path.basename(rel));
        }
      }
    }
  } catch {
    return null;
  }

  return { files: [...files], ms: Date.now() - t0, indexBytes, available: true };
}


export function stackGraphsTsPath(): string | null {
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'tree-sitter-stack-graphs-typescript'),
    'tree-sitter-stack-graphs-typescript',
  ];
  for (const c of candidates) {
    try {
      execFileSync(c, ['--version'], { stdio: 'ignore' });
      return c;
    } catch {

    }
  }
  return null;
}


function parseStackGraphDef(out: string): { file: string; line: number } | null {
  const m = out.match(/has definition\s*\n\s*([^\s:]+\.[A-Za-z0-9]+):(\d+):(\d+)/);
  if (!m) return null;
  return { file: m[1], line: parseInt(m[2], 10) };
}



function defBelongsToClass(
  defFile: string,
  defLine: number,
  className: string,
  methodName: string,
): boolean {
  let lines: string[];
  try {
    lines = fs.readFileSync(defFile, 'utf8').split('\n');
  } catch {
    return false;
  }
  const defText = lines[defLine - 1] || '';
  if (!new RegExp(`\\b${methodName}\\b`).test(defText)) return false;
  for (let i = defLine - 1; i >= 0; i--) {
    const cm = lines[i].match(/\bclass\s+([A-Za-z_]\w*)/);
    if (cm) return cm[1] === className;
  }
  return false;
}









export function stackGraphsCallers(
  dir: string,
  className: string,
  methodName: string,
): { files: string[]; ms: number } | null {
  const sg = stackGraphsTsPath();
  if (!sg) return null;

  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter(f => /\.(ts|tsx|js|jsx)$/.test(f));
  } catch {
    return null;
  }
  if (entries.length === 0) return null;

  const t0 = Date.now();
  const dbPath = path.join(os.tmpdir(), `klauro-sg-${process.pid}-${path.basename(dir)}.sqlite`);
  try {
    execFileSync(sg, ['index', '--force', '-D', dbPath, ...entries], {
      cwd: dir,
      stdio: 'ignore',
      timeout: 120_000,
    });
  } catch {
    try { fs.removeSync(dbPath); } catch {   }
    return null;
  }


  const callRe = new RegExp(`\\.\\s*${methodName}\\s*\\(`, 'g');
  const sites: Array<{ file: string; line: number; col: number }> = [];
  for (const file of entries) {
    let lines: string[];
    try {
      lines = fs.readFileSync(path.join(dir, file), 'utf8').split('\n');
    } catch {
      continue;
    }
    lines.forEach((ln, i) => {
      callRe.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = callRe.exec(ln))) {
        const nameIdx = ln.indexOf(methodName, m.index);
        if (nameIdx >= 0) sites.push({ file, line: i + 1, col: nameIdx + 1 });
      }
    });
  }

  const callerFiles = new Set<string>();
  for (const s of sites) {
    let out = '';
    try {
      out = execFileSync(sg, ['query', '-D', dbPath, 'definition', `${s.file}:${s.line}:${s.col}`], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 30_000,
      });
    } catch {
      continue;
    }
    const def = parseStackGraphDef(out);
    if (def && defBelongsToClass(def.file, def.line, className, methodName)) {
      callerFiles.add(path.basename(s.file));
    }
  }

  try { fs.removeSync(dbPath); } catch {   }
  return { files: [...callerFiles], ms: Date.now() - t0 };
}



export function codebaseMemoryPath(): string | null {
  const candidates = [path.join(os.homedir(), '.local', 'bin', 'codebase-memory-mcp'), 'codebase-memory-mcp'];
  for (const c of candidates) {
    try {
      execFileSync(c, ['--version'], { stdio: 'ignore' });
      return c;
    } catch {

    }
  }
  return null;
}








export function codebaseMemoryCallers(
  dir: string,
  className: string,
): { files: string[]; ms: number } | null {
  const bin = codebaseMemoryPath();
  if (!bin) return null;
  const t0 = Date.now();
  try {
    execFileSync(bin, ['cli', 'index_repository', JSON.stringify({ repo_path: dir })], {
      stdio: 'ignore',
      timeout: 120_000,
    });
  } catch {
    return null;
  }




  const project = dir.replace(/^\/+/, '').replace(/[^A-Za-z0-9_]+/g, '-');
  let out = '';
  try {
    out = execFileSync(bin, ['cli', 'get_architecture', JSON.stringify({ project })], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
  const jsonLine = out.split('\n').find(l => l.trim().startsWith('{')) || '{}';
  let arch: any;
  try {
    arch = JSON.parse(jsonLine);
  } catch {
    return null;
  }
  const callerPkgs: string[] = (arch.boundaries || [])
    .filter((b: any) => b.to === className)
    .map((b: any) => String(b.from));


  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {

  }
  const files = new Set<string>();
  for (const pkg of callerPkgs) {
    const match = entries.find(f => f.replace(/\.[A-Za-z0-9]+$/, '') === pkg);
    if (match) files.add(match);
  }
  return { files: [...files], ms: Date.now() - t0 };
}










export function codebaseMemoryNodesByLabel(
  dir: string,
  label: string,
): { names: string[]; ms: number } | null {
  const bin = codebaseMemoryPath();
  if (!bin) return null;
  const t0 = Date.now();
  try {
    execFileSync(bin, ['cli', 'index_repository', JSON.stringify({ repo_path: dir })], {
      stdio: 'ignore',
      timeout: 120_000,
    });
  } catch {
    return null;
  }
  const project = dir.replace(/^\/+/, '').replace(/[^A-Za-z0-9_]+/g, '-');
  let out = '';
  try {
    out = execFileSync(bin, ['cli', 'search_graph', JSON.stringify({ project, label })], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
  const jsonLine = out.split('\n').find(l => l.trim().startsWith('{')) || '{}';
  let parsed: any;
  try {
    parsed = JSON.parse(jsonLine);
  } catch {
    return null;
  }
  const names: string[] = (parsed.results || []).map((r: any) => String(r.name));
  return { names, ms: Date.now() - t0 };
}









export function codebaseMemoryEdgeTypes(dir: string): { types: string[]; ms: number } | null {
  const bin = codebaseMemoryPath();
  if (!bin) return null;
  const t0 = Date.now();
  try {
    execFileSync(bin, ['cli', 'index_repository', JSON.stringify({ repo_path: dir })], {
      stdio: 'ignore',
      timeout: 120_000,
    });
  } catch {
    return null;
  }
  const project = dir.replace(/^\/+/, '').replace(/[^A-Za-z0-9_]+/g, '-');
  let out = '';
  try {
    out = execFileSync(bin, ['cli', 'get_architecture', JSON.stringify({ project })], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
  const jsonLine = out.split('\n').find(l => l.trim().startsWith('{')) || '{}';
  let arch: any;
  try {
    arch = JSON.parse(jsonLine);
  } catch {
    return null;
  }
  const types: string[] = (arch.edge_types || []).map((e: any) => String(e.type));
  return { types, ms: Date.now() - t0 };
}






function isNonSourceScipFile(relPath: string): boolean {
  if (!relPath) return false;
  const p = relPath.toLowerCase();



  return (
    p.includes('/test/') || p.startsWith('test/') ||
    p.includes('/tests/') || p.startsWith('tests/') ||
    p.includes('/benchmark/') || p.startsWith('benchmark/') ||
    p.includes('/bench/') || p.startsWith('bench/') ||
    /(^|\/)test[^/]*\.[jt]sx?$/.test(p) ||
    /\.test-d\.[jt]sx?$/.test(p)
  );
}











export function scipSymbolNames(dir: string): { names: string[]; ms: number } | null {
  const scip = scipCliPath();
  if (!scip || !scipTypescriptAvailable()) return null;

  const t0 = Date.now();
  const indexPath = path.join(dir, 'index.scip');
  try {
    execFileSync('scip-typescript', ['index', '--infer-tsconfig', '--output', indexPath], {
      cwd: dir,
      stdio: 'ignore',
      timeout: 180_000,
    });
  } catch {
    try { fs.removeSync(indexPath); } catch {   }
    return null;
  }

  let json = '';
  try {
    json = execFileSync(scip, ['print', '--json', indexPath], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch {
    try { fs.removeSync(indexPath); } catch {   }
    return null;
  }
  try { fs.removeSync(indexPath); } catch {   }
















  const names = new Set<string>();
  try {
    const doc = JSON.parse(json);
    for (const d of doc.documents || []) {
      const rel: string = d.relative_path || d.relativePath || '';
      if (isNonSourceScipFile(rel)) continue;
      for (const occ of d.occurrences || []) {
        const sym: string = occ.symbol || '';
        const roles: number = occ.symbol_roles ?? occ.symbolRoles ?? 0;
        const isDefinition = (roles & 1) === 1;
        if (!isDefinition || !sym || sym === 'local') continue;
        const m = sym.match(/[/#]([A-Za-z_$][\w$]*)\(\)\.$/);
        if (m) names.add(m[1]);
      }
    }
  } catch {
    return null;
  }

  return { names: [...names], ms: Date.now() - t0 };
}





export function moderneCliPath(): string | null {
  const candidates = [path.join(os.homedir(), '.moderne', 'cli', 'mod'), 'mod'];
  for (const c of candidates) {
    try {
      execFileSync(c, ['--version'], { stdio: 'ignore' });
      return c;
    } catch {

    }
  }
  return null;
}




export function javaBuildToolchainAvailable(): boolean {
  try {
    execFileSync('java', ['-version'], { stdio: 'ignore' });
  } catch {
    return false;
  }
  for (const tool of ['mvn', 'gradle']) {
    try {
      execFileSync(tool, ['--version'], { stdio: 'ignore' });
      return true;
    } catch {

    }
  }
  return false;
}

export interface ModerneAvailability {
  available: boolean;
  reason?: string;
}






export function moderneAvailability(): ModerneAvailability {
  const mod = moderneCliPath();
  if (!mod) return { available: false, reason: 'mod CLI not installed' };
  if (!javaBuildToolchainAvailable()) {
    return { available: false, reason: 'mod CLI found but no Java build toolchain (mvn/gradle) installed' };
  }
  return { available: true };
}












export function moderneSymbolNames(dir: string): { names: string[]; ms: number } | null {
  const avail = moderneAvailability();
  if (!avail.available) return null;
  const mod = moderneCliPath();
  if (!mod) return null;

  const t0 = Date.now();
  const lstDir = path.join(os.tmpdir(), `klauro-moderne-${process.pid}-${path.basename(dir)}`);
  try {


    execFileSync(mod, ['build', dir, '--no-download'], {
      cwd: dir,
      stdio: 'ignore',
      timeout: 300_000,
    });
  } catch {
    return null;
  } finally {
    try { fs.removeSync(lstDir); } catch {   }
  }





  let out = '';
  try {
    out = execFileSync(mod, ['study', dir, '--recipe', 'org.openrewrite.java.search.FindMethodDeclaration'], {
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return { names: [], ms: Date.now() - t0 };
  }
  const names = new Set<string>();
  for (const line of out.split('\n')) {
    const m = line.match(/\b([A-Za-z_$][\w$]*)\s*\(/);
    if (m) names.add(m[1]);
  }
  return { names: [...names], ms: Date.now() - t0 };
}

export function ctagsAvailable(): boolean {
  try {
    execFileSync('ctags', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}









export function ctagsCallers(dir: string, methodName: string): { files: string[]; ms: number } | null {
  if (!ctagsAvailable()) return null;
  const t0 = Date.now();
  let out = '';
  try {


    out = execFileSync(
      'ctags',
      ['-R', '--extras=+r', '--fields=+r', '-f', '-', dir],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
  } catch {
    return { files: [], ms: Date.now() - t0 };
  }
  const files = new Set<string>();
  for (const line of out.split('\n')) {
    if (!line || line.startsWith('!')) continue;
    const [name, file] = line.split('\t');
    if (name === methodName && file && file !== 'truth.json') {
      files.add(path.basename(file));
    }
  }
  return { files: [...files], ms: Date.now() - t0 };
}
