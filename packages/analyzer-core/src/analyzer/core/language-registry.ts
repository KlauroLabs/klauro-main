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
  }
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
