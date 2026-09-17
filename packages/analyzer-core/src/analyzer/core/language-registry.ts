import * as path from 'path';



















export interface LanguageRegistryEntry {

  id: string;

  extensions: string[];

  manifests: string[];

  manifestPatterns?: RegExp[];

  manifestExtensions?: string[];
}

export const LANGUAGE_REGISTRY: LanguageRegistryEntry[] = [
  {
    id: 'javascript',
    extensions: ['js', 'jsx', 'mjs', 'cjs'],
    manifests: ['package.json']
  },
  {



    id: 'sql',
    extensions: ['sql', 'ddl'],

    manifests: [],
  },
  {
    id: 'typescript',
    extensions: ['ts', 'tsx'],
    manifests: []
  },
  {
    id: 'python',
    extensions: ['py'],
    manifests: ['setup.py', 'pyproject.toml', 'pipfile'],
    manifestPatterns: [/^requirements.*\.txt$/]
  },
  {
    id: 'java',
    extensions: ['java'],
    manifests: ['pom.xml', 'build.gradle', 'build.gradle.kts']
  },
  {
    id: 'kotlin',
    extensions: ['kt', 'kts'],
    manifests: ['build.gradle', 'build.gradle.kts', 'pom.xml', 'settings.gradle', 'settings.gradle.kts']
  },
  {

    id: 'csharp',
    extensions: ['cs', 'xaml'],
    manifests: [],
    manifestExtensions: ['csproj', 'fsproj', 'vbproj', 'sln']
  },
  {
    id: 'go',
    extensions: ['go'],
    manifests: ['go.mod']
  },
  {
    id: 'rust',
    extensions: ['rs'],
    manifests: ['cargo.toml']
  },
  {
    id: 'php',
    extensions: ['php'],
    manifests: ['composer.json']
  },
  {
    id: 'dart',
    extensions: ['dart'],
    manifests: ['pubspec.yaml']
  },
  {
    id: 'ruby',
    extensions: ['rb', 'rake'],
    manifests: ['gemfile', 'gemfile.lock']
  },
  {
    id: 'terraform',
    extensions: ['tf', 'tfvars'],
    manifests: []
  },
  {
    id: 'swift',
    extensions: ['swift'],
    manifests: ['package.swift']
  },
  {
    id: 'scala',
    extensions: ['scala', 'sc', 'sbt'],






    manifests: ['build.sbt', 'routes'],
    manifestPatterns: [/^.*\.routes$/]
  },
  {
    id: 'crystal',
    extensions: ['cr'],
    manifests: ['shard.yml']
  },
  {
    id: 'julia',
    extensions: ['jl'],
    manifests: ['project.toml']
  },
  {
    id: 'clojure',
    extensions: ['clj', 'cljs', 'cljc', 'edn'],
    manifests: ['deps.edn', 'project.clj']
  },
  {
    id: 'ocaml',
    extensions: ['ml', 'mli'],
    manifests: ['dune-project', 'dune']
  },
  {
    id: 'apex',
    extensions: ['cls', 'trigger'],
    manifests: ['sfdx-project.json']
  },
  {
    id: 'perl',
    extensions: ['pl', 'pm', 't'],
    manifests: ['cpanfile', 'makefile.pl']
  },
  {



    id: 'elixir',
    extensions: ['ex', 'exs'],
    manifests: ['mix.exs']
  },







  { id: 'c', extensions: ['c', 'h'], manifests: ['cmakelists.txt', 'makefile', 'meson.build'] },
  { id: 'cpp', extensions: ['cpp', 'cc', 'cxx', 'c++', 'hpp', 'hh', 'hxx', 'ipp', 'tpp'], manifests: ['cmakelists.txt', 'makefile', 'meson.build'] },
  { id: 'objc', extensions: ['m', 'mm'], manifests: [] },
  { id: 'cuda', extensions: ['cu', 'cuh'], manifests: [] },
  { id: 'opencl', extensions: ['cl'], manifests: [] },
  { id: 'd', extensions: ['d', 'di'], manifests: ['dub.json', 'dub.sdl'] },
  { id: 'zig', extensions: ['zig'], manifests: ['build.zig', 'build.zig.zon'] },
  { id: 'nim', extensions: ['nim', 'nims', 'nimble'], manifests: [] },
  { id: 'odin', extensions: ['odin'], manifests: [] },
  { id: 'vala', extensions: ['vala', 'vapi'], manifests: [] },
  { id: 'hare', extensions: ['ha'], manifests: [] },
  { id: 'pony', extensions: ['pony'], manifests: [] },
  { id: 'wren', extensions: ['wren'], manifests: [] },
  { id: 'fortran', extensions: ['f90', 'f95', 'f03', 'f08', 'f', 'for', 'f77'], manifests: [] },
  { id: 'cobol', extensions: ['cbl', 'cob', 'cpy', 'ccp'], manifests: [] },
  { id: 'ada', extensions: ['adb', 'ads'], manifests: [] },
  { id: 'pascal', extensions: ['pas', 'pp', 'dpr'], manifests: [] },
  { id: 'haskell', extensions: ['hs', 'lhs'], manifests: ['stack.yaml', 'package.yaml'], manifestExtensions: ['cabal'] },
  { id: 'purescript', extensions: ['purs'], manifests: ['spago.dhall', 'spago.yaml'] },
  { id: 'elm', extensions: ['elm'], manifests: ['elm.json'] },
  { id: 'ocaml_extra', extensions: ['mll', 'mly'], manifests: [] },
  { id: 'fsharp', extensions: ['fs', 'fsi', 'fsx'], manifests: [], manifestExtensions: ['fsproj'] },
  { id: 'reason', extensions: ['re', 'rei'], manifests: [] },
  { id: 'rescript', extensions: ['res', 'resi'], manifests: ['rescript.json', 'bsconfig.json'] },
  { id: 'erlang', extensions: ['erl', 'hrl'], manifests: ['rebar.config'] },
  { id: 'gleam', extensions: ['gleam'], manifests: ['gleam.toml'] },
  { id: 'commonlisp', extensions: ['lisp', 'lsp', 'cl', 'asd'], manifests: [] },
  { id: 'scheme', extensions: ['scm', 'ss', 'sld'], manifests: [] },
  { id: 'racket', extensions: ['rkt', 'rktl'], manifests: ['info.rkt'] },
  { id: 'fennel', extensions: ['fnl'], manifests: [] },
  { id: 'janet', extensions: ['janet'], manifests: [] },
  { id: 'lua', extensions: ['lua'], manifests: ['rockspec'] },
  { id: 'luau', extensions: ['luau'], manifests: [] },
  { id: 'r', extensions: ['r', 'rmd'], manifests: ['description', 'namespace'] },
  { id: 'sml', extensions: ['sml', 'sig', 'fun'], manifests: [] },
  { id: 'tcl', extensions: ['tcl', 'tk'], manifests: [] },
  { id: 'groovy', extensions: ['groovy', 'gvy', 'gradle'], manifests: [] },
  { id: 'hack', extensions: ['hack', 'hck'], manifests: ['.hhconfig'] },
  { id: 'haxe', extensions: ['hx', 'hxsl'], manifests: ['haxelib.json'] },
  { id: 'gdscript', extensions: ['gd'], manifests: ['project.godot'] },
  { id: 'gdshader', extensions: ['gdshader'], manifests: [] },
  { id: 'solidity', extensions: ['sol'], manifests: ['foundry.toml', 'hardhat.config.js', 'hardhat.config.ts', 'truffle-config.js'] },
  { id: 'cairo', extensions: ['cairo'], manifests: ['scarb.toml'] },
  { id: 'move', extensions: ['move'], manifests: ['move.toml'] },
  { id: 'sway', extensions: ['sw'], manifests: ['forc.toml'] },
  { id: 'tact', extensions: ['tact'], manifests: [] },
  { id: 'func', extensions: ['fc', 'func'], manifests: [] },
  { id: 'circom', extensions: ['circom'], manifests: [] },
  { id: 'noir', extensions: ['nr'], manifests: ['nargo.toml'] },
  { id: 'clarity', extensions: ['clar'], manifests: ['clarinet.toml'] },
  { id: 'powershell', extensions: ['ps1', 'psm1', 'psd1'], manifests: [] },














  { id: 'shell', extensions: ['sh', 'bash', 'zsh', 'ksh'], manifests: [] },
  { id: 'installer_scripts', extensions: ['bat', 'cmd', 'nsi', 'iss'], manifests: [] },
  { id: 'awk', extensions: ['awk'], manifests: [] },
  { id: 'fish', extensions: ['fish'], manifests: [] },
  { id: 'vim', extensions: ['vim', 'vimrc'], manifests: [] },
  { id: 'perl_pod', extensions: ['pod'], manifests: [] },
  { id: 'ballerina', extensions: ['bal'], manifests: ['ballerina.toml'] },
  { id: 'gren', extensions: ['gren'], manifests: [] },
  { id: 'grain', extensions: ['gr'], manifests: [] },
  { id: 'wing', extensions: ['w'], manifests: [] },
  { id: 'slang', extensions: ['slang'], manifests: [] },
  { id: 'sourcepawn', extensions: ['sp', 'inc'], manifests: [] },
  { id: 'squirrel', extensions: ['nut'], manifests: [] },
  { id: 'p4', extensions: ['p4'], manifests: [] },
  { id: 'apex_page', extensions: ['apex'], manifests: [] },
  { id: 'smali', extensions: ['smali'], manifests: [] },
  { id: 'agda', extensions: ['agda'], manifests: [] },
  { id: 'verilog', extensions: ['v', 'vh', 'sv', 'svh'], manifests: [] },
  { id: 'systemverilog', extensions: ['sv', 'svh', 'svi'], manifests: [] },
  { id: 'vhdl', extensions: ['vhd', 'vhdl'], manifests: [] },
  { id: 'tlaplus', extensions: ['tla'], manifests: [] },
  { id: 'supercollider', extensions: ['scd'], manifests: [] },

  { id: 'glsl', extensions: ['glsl', 'vert', 'frag', 'geom', 'comp', 'tesc', 'tese'], manifests: [] },
  { id: 'xml', extensions: ['xml', 'xsd', 'xsl', 'xslt', 'csproj', 'fsproj', 'vbproj', 'plist'], manifests: ['pom.xml'] },
  { id: 'hlsl', extensions: ['hlsl', 'fx', 'fxh', 'hlsli'], manifests: [] },
  { id: 'wgsl', extensions: ['wgsl'], manifests: [] },
  { id: 'wat', extensions: ['wat', 'wast'], manifests: [] },
  { id: 'llvm', extensions: ['ll'], manifests: [] },
  { id: 'mlir', extensions: ['mlir'], manifests: [] },
  { id: 'nasm', extensions: ['asm', 's'], manifests: [] },
  { id: 'tablegen', extensions: ['td'], manifests: [] },

  { id: 'proto', extensions: ['proto'], manifests: [] },
  { id: 'configuration', extensions: ['yaml', 'yml', 'conf', 'cfg'], manifests: [] },
  { id: 'soap-contract', extensions: ['wsdl', 'xsd'], manifests: [] },
  { id: 'thrift', extensions: ['thrift'], manifests: [] },
  { id: 'graphql', extensions: ['graphql', 'gql', 'graphqls'], manifests: [] },
  { id: 'smithy', extensions: ['smithy'], manifests: [] },
  { id: 'fidl', extensions: ['fidl'], manifests: [] },
  { id: 'capnp', extensions: ['capnp'], manifests: [] },
  { id: 'ql', extensions: ['ql', 'qll'], manifests: ['qlpack.yml'] },
  { id: 'sparql', extensions: ['rq', 'sparql'], manifests: [] },
  { id: 'sql_more', extensions: ['ddl', 'dml'], manifests: [] },
  { id: 'prql', extensions: ['prql'], manifests: [] },
  { id: 'promql', extensions: ['promql'], manifests: [] },

  { id: 'css', extensions: ['css', 'scss', 'sass', 'less'], manifests: [] },
  { id: 'html', extensions: ['html', 'htm', 'xhtml'], manifests: [] },
  { id: 'twig', extensions: ['twig'], manifests: [] },
  { id: 'liquid', extensions: ['liquid'], manifests: [] },
  { id: 'blade', extensions: ['blade.php'], manifests: [] },
  { id: 'glimmer', extensions: ['hbs', 'handlebars'], manifests: [] },
  { id: 'templ', extensions: ['templ'], manifests: [] },
  { id: 'astro_lang', extensions: ['astro'], manifests: [] },



  { id: 'svelte', extensions: ['svelte'], manifests: [] },
  { id: 'vue', extensions: ['vue'], manifests: [] },





  { id: 'prisma', extensions: ['prisma'], manifests: [] },

  { id: 'cmake', extensions: ['cmake'], manifests: ['cmakelists.txt'] },
  { id: 'make', extensions: ['mk', 'mak'], manifests: ['makefile', 'gnumakefile'] },
  { id: 'meson', extensions: [], manifests: ['meson.build', 'meson_options.txt'] },
  { id: 'bazel', extensions: ['bzl', 'star'], manifests: ['build', 'build.bazel', 'workspace', 'workspace.bazel'] },
  { id: 'dockerfile', extensions: ['dockerfile'], manifests: ['dockerfile', 'containerfile'] },
  { id: 'hcl', extensions: ['hcl', 'nomad'], manifests: [] },
  { id: 'markdown', extensions: ['md', 'markdown', 'mdx'], manifests: [] },
  { id: 'bicep', extensions: ['bicep', 'bicepparam'], manifests: [] },
  { id: 'nix', extensions: ['nix'], manifests: ['flake.nix', 'default.nix', 'shell.nix'] },
  { id: 'puppet', extensions: ['pp'], manifests: [] },
  { id: 'gn', extensions: ['gn', 'gni'], manifests: [] },

  { id: 'dhall', extensions: ['dhall'], manifests: [] },
  { id: 'cue', extensions: ['cue'], manifests: [] },
  { id: 'jsonnet', extensions: ['jsonnet', 'libsonnet'], manifests: [] },
  { id: 'nickel', extensions: ['ncl'], manifests: [] },
  { id: 'pkl', extensions: ['pkl'], manifests: [] },
  { id: 'kdl', extensions: ['kdl'], manifests: [] },
  { id: 'hocon', extensions: ['hocon'], manifests: [] },
  { id: 'starlark', extensions: ['star'], manifests: [] },

  { id: 'julia_more', extensions: ['jmd'], manifests: [] },
  { id: 'latex', extensions: ['tex', 'sty', 'bib', 'ltx'], manifests: [] },
  { id: 'typst', extensions: ['typ'], manifests: [] },
  { id: 'rego', extensions: ['rego'], manifests: [] },
  { id: 'yara', extensions: ['yar', 'yara'], manifests: [] },
  { id: 'devicetree', extensions: ['dts', 'dtsi'], manifests: [] },
  { id: 'kconfig', extensions: ['kconfig'], manifests: [] },
  { id: 'cpon', extensions: ['cpon'], manifests: [] },
  { id: 'ron', extensions: ['ron'], manifests: [] },
  { id: 'pony_ml', extensions: [], manifests: ['corral.json'] }
];

const LANGUAGE_NAMES: Record<string, string> = {
  csharp: 'C#',
  cpp: 'C++',
  fsharp: 'F#',
  javascript: 'JavaScript',
  objc: 'Objective-C',
  opencl: 'OpenCL',
  php: 'PHP',
  powershell: 'PowerShell',
  sql: 'SQL',
  sql_more: 'SQL',
  typescript: 'TypeScript',
};

const LANGUAGE_BY_EXTENSION = buildLanguageByExtension();

function buildLanguageByExtension(): Map<string, string> {
  const languages = new Map<string, string>();
  for (const entry of LANGUAGE_REGISTRY) {
    for (const extension of entry.extensions) {
      const normalized = extension.toLowerCase();
      if (!languages.has(normalized)) {
        languages.set(normalized, languageName(entry.id));
      }
    }
  }
  return languages;
}

export function languageForSourceFile(file: string): string | undefined {
  const basename = path.basename(file).toLowerCase();
  const extension = basename.includes('.') ? basename.slice(basename.lastIndexOf('.') + 1) : basename;
  return LANGUAGE_BY_EXTENSION.get(extension);
}

function languageName(id: string): string {
  const canonical = id.replace(/_(?:more|extra|lang|page)$/, '');
  return LANGUAGE_NAMES[canonical] || canonical
    .split(/[_-]/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

const SOURCE_EXTENSIONS = new Set(LANGUAGE_REGISTRY.flatMap(l => l.extensions));
const MANIFEST_BASENAMES = new Set(LANGUAGE_REGISTRY.flatMap(l => l.manifests));
const MANIFEST_EXTENSIONS = new Set(LANGUAGE_REGISTRY.flatMap(l => l.manifestExtensions ?? []));
const MANIFEST_PATTERNS = LANGUAGE_REGISTRY.flatMap(l => l.manifestPatterns ?? []);

export function getRegisteredSourceExtensions(): string[] {
  return [...SOURCE_EXTENSIONS];
}

function fileExtension(basename: string): string {
  const dot = basename.lastIndexOf('.');
  return dot === -1 ? '' : basename.slice(dot + 1);
}


export function isRegisteredManifest(filePath: string): boolean {
  const basename = path.basename(filePath).toLowerCase();
  if (MANIFEST_BASENAMES.has(basename)) return true;
  if (MANIFEST_PATTERNS.some(pattern => pattern.test(basename))) return true;
  const ext = fileExtension(basename);
  return ext !== '' && MANIFEST_EXTENSIONS.has(ext);
}


export function isRegisteredSourceExtension(filePath: string): boolean {
  const ext = fileExtension(path.basename(filePath).toLowerCase());
  return ext !== '' && SOURCE_EXTENSIONS.has(ext);
}




















const NON_PACKAGE_BOUNDARY_MANIFESTS = new Set(['dockerfile', 'containerfile', 'routes']);








export function isPackageBoundaryManifest(filePath: string): boolean {
  if (!isRegisteredManifest(filePath)) return false;
  const basename = path.basename(filePath).toLowerCase();
  if (NON_PACKAGE_BOUNDARY_MANIFESTS.has(basename)) return false;



  if (/^.*\.routes$/.test(basename)) return false;
  return true;
}
