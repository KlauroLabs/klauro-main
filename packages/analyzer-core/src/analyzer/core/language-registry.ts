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
    // `.sql` was claimed by NO language and read by NOTHING before 2026-08-11:
    // a repo whose schema lives in DDL had its entities invisible, and the
    // comprehension tiers above them collapsed as a result.
    id: 'sql',
    extensions: ['sql', 'ddl'],
    // No build manifest: SQL is declared IN source files, never via a manifest.
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
    // build.sbt: sbt / Scala (http4s). `routes`: Play Framework's router file
    // (conf/routes) — the route source of truth has no extension, so without
    // this entry it is invisible to the orchestrator's inventory and
    // PlayAnalyzer's canAnalyze() is never even reached (hasAnalyzerSignal
    // fails first). manifestPatterns covers Play's `conf/*.routes` sub-router
    // includes (e.g. api.routes).
    manifests: ['build.sbt', 'routes'],
    manifestPatterns: [/^.*\.routes$/]
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
    // Elixir / Phoenix. The source extensions must be registered so the product
    // source snapshot (isRegisteredSourceExtension) carries .ex/.exs files to the
    // ElixirAnalyzer; without them the snapshot silently drops all Elixir source.
    id: 'elixir',
    extensions: ['ex', 'exs'],
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
  // Shell/batch/installer scripts. These are also picked up by the dedicated
  // ShellAnalyzer (shell-analyzer.ts, which globs .sh/.bash/.zsh/.ksh directly),
  // but that glob is independent of the orchestrator's source inventory AND of
  // the product source snapshot (apps/mcp-server/src/remote-source.ts) sent to
  // the remote analyzer server. Without registering these extensions here,
  // installer/build scripts (.sh/.bat/.nsi/.iss — e.g. build-mac-installer.sh,
  // build-windows-installer.bat, an Inno Setup .iss, an NSIS .nsi) never enter
  // that snapshot, so the deployable-evidence installer provider
  // (deployable-evidence/providers/installer.ts, which globs the analyzer
  // server's materialized project directory) finds nothing to read even though
  // its own parsing logic is correct. `.bat`/`.nsi`/`.iss` are intentionally a
  // separate `installer_scripts` entry (not folded into `shell`) so a repo full
  // of Windows/NSIS installer scripts cannot register as extra "shell" source
  // for any consumer that keys off this registry's `id`.
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
  // Single-file component formats handled by dedicated framework analyzers
  // (Svelte/Vue). Registered so the product source snapshot carries the files;
  // no breadth spec, so the generic analyzer leaves them to the framework layer.
  { id: 'svelte', extensions: ['svelte'], manifests: [] },
  { id: 'vue', extensions: ['vue'], manifests: [] },
  // Prisma schema — read by the Prisma library analyzer for ORM entity relations.
  // The `.prisma` extension carries the file into the source snapshot; schema.prisma
  // is deliberately NOT a manifest (that would make `prisma/` a phantom project root
  // and scope the PrismaAnalyzer out of it). Detection fires via the analyzer's
  // detectPatterns.files (`prisma/schema.prisma`) + the `@prisma/client` dependency.
  { id: 'prisma', extensions: ['prisma'], manifests: [] },
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

/**
 * Manifest basenames that are deploy/build TOOLING, not a package/dependency
 * boundary. `isRegisteredManifest` intentionally includes these (they mark a
 * file as "manifest-shaped" for source-inventory purposes across many
 * consumers), but a directory containing only one of these is NOT a separate
 * package — e.g. every app in an Nx/Turborepo monorepo typically ships its own
 * `Dockerfile` without a nested `package.json`. Treating that directory as a
 * distinct "project root" (see orchestrator.ts `discoverProjectRoots`) caused a
 * real bug: `getAnalyzerScopeFilters` then excludes the whole directory from
 * the framework analyzer's scope on the assumption a dedicated pass will cover
 * it, silently dropping every NestJS controller under `apps/*` on monorepos
 * where Nest deps are hoisted to the root package.json.
 */
// 'routes': Play Framework's conf/routes is a router config file, not a
// package/dependency boundary — a directory containing only conf/routes (e.g.
// the fixture's conf/ directory) is not its own package and must not be
// promoted to a nested project root, or getAnalyzerScopeFilters walls off the
// rest of the tree (app/controllers/*.scala) from PlayAnalyzer's scope,
// leaving handler resolution with nothing to read.
const NON_PACKAGE_BOUNDARY_MANIFESTS = new Set(['dockerfile', 'containerfile', 'routes']);

/**
 * True when `filePath` is a registered manifest that also marks a genuine
 * package/dependency boundary (the file a nested-project discovery pass should
 * treat as its own root) — i.e. `isRegisteredManifest` minus deploy/build
 * tooling files like Dockerfile that commonly live inside a directory with no
 * independent package identity of its own.
 */
export function isPackageBoundaryManifest(filePath: string): boolean {
  if (!isRegisteredManifest(filePath)) return false;
  const basename = path.basename(filePath).toLowerCase();
  if (NON_PACKAGE_BOUNDARY_MANIFESTS.has(basename)) return false;
  // Play sub-router includes (conf/api.routes, conf/admin.routes, ...) match
  // the scala entry's manifestPatterns, not the exact 'routes' basename above —
  // same non-package-boundary reasoning applies to every one of them.
  if (/^.*\.routes$/.test(basename)) return false;
  return true;
}
