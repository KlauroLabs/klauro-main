import * as path from 'path';

/**
 * Single source of truth for which files the orchestrator's source-file inventory
 * should pick up, keyed by language.
 *
 * Why this exists: framework detection (`hasAnalyzerSignal`) only fires when the
 * inventory contains files for a language. Historically the extension set and the
 * manifest set lived as a giant inline regex + an `if`-chain inside orchestrator.ts,
 * so adding a language meant editing two hardcoded spots — and every new analyzer
 * (Swift, Scala, Crystal, Julia, Clojure, OCaml, Perl, Apex, …) silently produced an
 * empty inventory until someone remembered to. Adding a language is now one entry here.
 *
 * Matching rules (kept identical to the previous inline behavior):
 *  - `extensions` and `manifestExtensions` are lowercase, no leading dot. They are
 *    compared against the lowercased file extension.
 *  - `manifests` are exact basenames compared against the lowercased basename, so they
 *    must be written lowercase (e.g. `package.swift`, not `Package.swift`).
 *  - `manifestPatterns` match the lowercased basename (e.g. `requirements*.txt`).
 */
export interface LanguageRegistryEntry {
  /** Canonical language id (aligns with FRAMEWORK_ANALYZERS `languages` where applicable). */
  id: string;
  /** Source-file extensions, lowercase, without the leading dot. */
  extensions: string[];
  /** Build/manifest files matched by exact basename (compared lowercase). */
  manifests: string[];
  /** Build/manifest files matched by a basename regex (e.g. `requirements*.txt`). */
  manifestPatterns?: RegExp[];
  /** Extensions whose presence marks the file itself as a manifest (e.g. `csproj`, `sln`). */
  manifestExtensions?: string[];
}

export const LANGUAGE_REGISTRY: LanguageRegistryEntry[] = [
  {
    id: 'javascript',
    extensions: ['js', 'jsx', 'mjs', 'cjs'],
    manifests: ['package.json']
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
    // .NET family: C#/F#/VB sources + XAML, project/solution files are manifests.
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
    manifests: ['package.swift'] // Swift Package Manager / Vapor
  },
  {
    id: 'scala',
    extensions: ['scala', 'sc', 'sbt'],
    manifests: ['build.sbt'] // sbt / Scala (http4s)
  },
  {
    id: 'crystal',
    extensions: ['cr'],
    manifests: ['shard.yml'] // Crystal shards / Kemal
  },
  {
    id: 'julia',
    extensions: ['jl'],
    manifests: ['project.toml'] // Julia (Genie) — content-gated downstream by detectPatterns
  },
  {
    id: 'clojure',
    extensions: ['clj', 'cljs', 'cljc', 'edn'],
    manifests: ['deps.edn', 'project.clj'] // Clojure / Compojure
  },
  {
    id: 'ocaml',
    extensions: ['ml', 'mli'],
    manifests: ['dune-project', 'dune'] // OCaml / Dune (Dream)
  },
  {
    id: 'apex',
    extensions: ['cls', 'trigger'],
    manifests: ['sfdx-project.json'] // Salesforce DX / Apex REST
  },
  {
    id: 'perl',
    extensions: ['pl', 'pm', 't'],
    manifests: ['cpanfile', 'makefile.pl'] // Perl / Mojolicious + ExtUtils::MakeMaker
  },
  {
    // Elixir / Phoenix is detected via its manifest; source extensions are
    // intentionally inventoried elsewhere, so only the manifest is registered here.
    id: 'elixir',
    extensions: [],
    manifests: ['mix.exs']
  },

  // Breadth languages: every grammar shipped in LANGUAGE_SPECS / vendored-grammars,
  // registered with its REAL file extensions so real-repo file inventory
  // (orchestrator.isSourceInventoryCandidate) and the product source snapshot
  // recognize them. Once a file is inventoried it is graphed by the generic
  // tree-sitter walker, and the deterministic + AI layers apply on top — "deep" is
  // universal once a graph exists. Framework facts are an additive, per-framework layer.
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
  // Shaders / GPU
  { id: 'glsl', extensions: ['glsl', 'vert', 'frag', 'geom', 'comp', 'tesc', 'tese', 'vs', 'fs'], manifests: [] },
  { id: 'hlsl', extensions: ['hlsl', 'fx', 'fxh', 'hlsli'], manifests: [] },
  { id: 'wgsl', extensions: ['wgsl'], manifests: [] },
  { id: 'wat', extensions: ['wat', 'wast'], manifests: [] },
  { id: 'llvm', extensions: ['ll'], manifests: [] },
  { id: 'mlir', extensions: ['mlir'], manifests: [] },
  { id: 'nasm', extensions: ['asm', 's'], manifests: [] },
  { id: 'tablegen', extensions: ['td'], manifests: [] },
  // IDL / schema / query
  { id: 'proto', extensions: ['proto'], manifests: [] },
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
  // Web / template / markup-with-logic
  { id: 'css', extensions: ['css', 'scss', 'sass', 'less'], manifests: [] },
  { id: 'html', extensions: ['html', 'htm', 'xhtml'], manifests: [] },
  { id: 'twig', extensions: ['twig'], manifests: [] },
  { id: 'liquid', extensions: ['liquid'], manifests: [] },
  { id: 'blade', extensions: ['blade.php'], manifests: [] },
  { id: 'glimmer', extensions: ['hbs', 'handlebars'], manifests: [] },
  { id: 'templ', extensions: ['templ'], manifests: [] },
  { id: 'astro_lang', extensions: ['astro'], manifests: [] },
  // Build / infra / config-as-code
  { id: 'cmake', extensions: ['cmake'], manifests: ['cmakelists.txt'] },
  { id: 'make', extensions: ['mk', 'mak'], manifests: ['makefile', 'gnumakefile'] },
  { id: 'meson', extensions: [], manifests: ['meson.build', 'meson_options.txt'] },
  { id: 'bazel', extensions: ['bzl', 'star'], manifests: ['build', 'build.bazel', 'workspace', 'workspace.bazel'] },
  { id: 'dockerfile', extensions: ['dockerfile'], manifests: ['dockerfile', 'containerfile'] },
  { id: 'hcl', extensions: ['hcl', 'nomad'], manifests: [] },
  { id: 'bicep', extensions: ['bicep', 'bicepparam'], manifests: [] },
  { id: 'nix', extensions: ['nix'], manifests: ['flake.nix', 'default.nix', 'shell.nix'] },
  { id: 'puppet', extensions: ['pp'], manifests: [] },
  { id: 'gn', extensions: ['gn', 'gni'], manifests: [] },
  // Config / data languages (typed/structured)
  { id: 'dhall', extensions: ['dhall'], manifests: [] },
  { id: 'cue', extensions: ['cue'], manifests: [] },
  { id: 'jsonnet', extensions: ['jsonnet', 'libsonnet'], manifests: [] },
  { id: 'nickel', extensions: ['ncl'], manifests: [] },
  { id: 'pkl', extensions: ['pkl'], manifests: [] },
  { id: 'kdl', extensions: ['kdl'], manifests: [] },
  { id: 'hocon', extensions: ['hocon'], manifests: [] },
  { id: 'starlark', extensions: ['star'], manifests: [] },
  // Notebook / scientific / DSLs
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

const SOURCE_EXTENSIONS = new Set(LANGUAGE_REGISTRY.flatMap(l => l.extensions));
const MANIFEST_BASENAMES = new Set(LANGUAGE_REGISTRY.flatMap(l => l.manifests));
const MANIFEST_EXTENSIONS = new Set(LANGUAGE_REGISTRY.flatMap(l => l.manifestExtensions ?? []));
const MANIFEST_PATTERNS = LANGUAGE_REGISTRY.flatMap(l => l.manifestPatterns ?? []);

function fileExtension(basename: string): string {
  const dot = basename.lastIndexOf('.');
  return dot === -1 ? '' : basename.slice(dot + 1);
}

/** True when `filePath` is a registered build/manifest file for any language. */
export function isRegisteredManifest(filePath: string): boolean {
  const basename = path.basename(filePath).toLowerCase();
  if (MANIFEST_BASENAMES.has(basename)) return true;
  if (MANIFEST_PATTERNS.some(pattern => pattern.test(basename))) return true;
  const ext = fileExtension(basename);
  return ext !== '' && MANIFEST_EXTENSIONS.has(ext);
}

/** True when `filePath` carries a registered source-file extension for any language. */
export function isRegisteredSourceExtension(filePath: string): boolean {
  const ext = fileExtension(path.basename(filePath).toLowerCase());
  return ext !== '' && SOURCE_EXTENSIONS.has(ext);
}
