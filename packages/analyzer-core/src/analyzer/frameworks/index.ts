// NOT a registration path. The single source of truth for which analyzers run
// against a real repo is createOrchestrator() in apps/mcp-server/src/analyzer.ts
// — that is the only list wired into the deployed product
// (analyzer-server / remote-analyzer-service.ts) and into analyzeForBench.
// FRAMEWORK_ANALYZERS below is consumed only as benchmark-grid metadata by
// apps/mcp-server/src/gauntlet/full-grid.ts (which frameworks exist, for
// coverage-matrix reporting) — it never drives real analysis. getFrameworkAnalyzer
// and detectFrameworkFromFiles have no callers anywhere in the codebase; they
// are dead helper code left over from an earlier detection design. Adding a new
// analyzer here does NOT make it run in production — register it in
// apps/mcp-server/src/analyzer.ts instead. See scripts/verify-live-analyzer-registration.ts
// for the guard that enforces this.
export * from './web';
export * from './testing';
export * from './mobile';
export * from './swift';
export * from './dart';
export * from './scala';
export * from './crystal';
export * from './julia';
export * from './clojure';
export * from './ocaml';
export * from './apex';
export * from './perl';
export * from './go';
export * from './dataml';

import { VaporAnalyzer } from './swift';
import { GoRouterAnalyzer, ShelfAnalyzer } from './dart';
import { Http4sAnalyzer } from './scala';
import { KemalAnalyzer } from './crystal';
import { GenieAnalyzer } from './julia';
import { CompojureAnalyzer, ReititAnalyzer } from './clojure';
import { DreamAnalyzer } from './ocaml';
import { ApexRestAnalyzer } from './apex';
import { MojoliciousAnalyzer } from './perl';
import { GinAnalyzer, EchoAnalyzer, FiberAnalyzer, ChiAnalyzer } from './go';

import {
  NestJSAnalyzer,
  SpringBootAnalyzer,
  DjangoAnalyzer,
  FlaskAnalyzer,
  FastAPIAnalyzer,
  AiohttpAnalyzer,
  SanicAnalyzer,
  TornadoAnalyzer,
  StarletteAnalyzer,
  ExpressAnalyzer,
  ReactAnalyzer,
  VueAnalyzer,
  AngularAnalyzer,
  LaravelAnalyzer,
  SinatraAnalyzer,
  SlimAnalyzer
} from './web';

import { JestAnalyzer, CypressAnalyzer, TestFrameworkAnalyzer } from './testing';
import {
  AirflowAnalyzer,
  DagsterAnalyzer,
  PrefectAnalyzer,
  LuigiAnalyzer,
  JupyterNotebookAnalyzer,
  MLTrainingAnalyzer
} from './dataml';

export interface FrameworkAnalyzerInfo {
  name: string;
  analyzer: any;
  category: 'web' | 'mobile' | 'testing' | 'library' | 'data';
  languages: string[];
  frameworks: string[];
  priority: number;
}

export const FRAMEWORK_ANALYZERS: FrameworkAnalyzerInfo[] = [
  {
    name: 'NestJS',
    analyzer: NestJSAnalyzer,
    category: 'web',
    languages: ['typescript', 'javascript'],
    frameworks: ['nestjs', '@nestjs/core', '@nestjs/common'],
    priority: 120
  },
  {
    name: 'Spring Boot',
    analyzer: SpringBootAnalyzer,
    category: 'web',
    languages: ['java'],
    frameworks: ['spring-boot', 'org.springframework.boot'],
    priority: 115
  },
  {
    name: 'Django',
    analyzer: DjangoAnalyzer,
    category: 'web',
    languages: ['python'],
    frameworks: ['django'],
    priority: 110
  },
  {
    name: 'Flask',
    analyzer: FlaskAnalyzer,
    category: 'web',
    languages: ['python'],
    frameworks: ['flask'],
    priority: 105
  },
  {
    name: 'FastAPI',
    analyzer: FastAPIAnalyzer,
    category: 'web',
    languages: ['python'],
    frameworks: ['fastapi'],
    priority: 108
  },
  {
    name: 'aiohttp',
    analyzer: AiohttpAnalyzer,
    category: 'web',
    languages: ['python'],
    frameworks: ['aiohttp'],
    priority: 104
  },
  {
    name: 'Sanic',
    analyzer: SanicAnalyzer,
    category: 'web',
    languages: ['python'],
    frameworks: ['sanic'],
    priority: 104
  },
  {
    name: 'Tornado',
    analyzer: TornadoAnalyzer,
    category: 'web',
    languages: ['python'],
    frameworks: ['tornado'],
    priority: 103
  },
  {
    name: 'Starlette',
    analyzer: StarletteAnalyzer,
    category: 'web',
    languages: ['python'],
    frameworks: ['starlette'],
    priority: 103
  },
  {
    name: 'Express.js',
    analyzer: ExpressAnalyzer,
    category: 'web',
    languages: ['javascript', 'typescript'],
    frameworks: ['express'],
    priority: 100
  },
  {
    name: 'React',
    analyzer: ReactAnalyzer,
    category: 'web',
    languages: ['javascript', 'typescript'],
    frameworks: ['react', 'react-dom'],
    priority: 95
  },
  {
    name: 'Vue.js',
    analyzer: VueAnalyzer,
    category: 'web',
    languages: ['javascript', 'typescript'],
    frameworks: ['vue', '@vue/cli', 'nuxt'],
    priority: 93
  },
  {
    name: 'Angular',
    analyzer: AngularAnalyzer,
    category: 'web',
    languages: ['typescript'],
    frameworks: ['@angular/core', '@angular/cli'],
    priority: 90
  },
  {
    name: 'Laravel',
    analyzer: LaravelAnalyzer,
    category: 'web',
    languages: ['php'],
    frameworks: ['laravel/framework', 'laravel/laravel'],
    priority: 85
  },
  {
    name: 'Vapor',
    analyzer: VaporAnalyzer,
    category: 'web',
    languages: ['swift'],
    frameworks: ['vapor'],
    priority: 112
  },
  {
    name: 'Mojolicious',
    analyzer: MojoliciousAnalyzer,
    category: 'web',
    languages: ['perl'],
    frameworks: ['mojolicious', 'Mojolicious::Lite'],
    priority: 112
  },
  {
    name: 'GoRouter',
    analyzer: GoRouterAnalyzer,
    category: 'web',
    languages: ['dart'],
    frameworks: ['go_router', 'gorouter'],
    priority: 112
  },
  {
    name: 'Shelf',
    analyzer: ShelfAnalyzer,
    category: 'web',
    languages: ['dart'],
    frameworks: ['shelf', 'shelf_router'],
    priority: 112
  },
  {
    name: 'Gin',
    analyzer: GinAnalyzer,
    category: 'web',
    languages: ['go'],
    frameworks: ['gin', 'github.com/gin-gonic/gin'],
    priority: 112
  },
  {
    name: 'Echo',
    analyzer: EchoAnalyzer,
    category: 'web',
    languages: ['go'],
    frameworks: ['echo', 'github.com/labstack/echo'],
    priority: 112
  },
  {
    name: 'Fiber',
    analyzer: FiberAnalyzer,
    category: 'web',
    languages: ['go'],
    frameworks: ['fiber', 'github.com/gofiber/fiber'],
    priority: 112
  },
  {
    name: 'Chi',
    analyzer: ChiAnalyzer,
    category: 'web',
    languages: ['go'],
    frameworks: ['chi', 'github.com/go-chi/chi'],
    priority: 112
  },
  {
    name: 'http4s',
    analyzer: Http4sAnalyzer,
    category: 'web',
    languages: ['scala'],
    frameworks: ['http4s', 'http4s-dsl'],
    priority: 112
  },
  {
    name: 'kemal',
    analyzer: KemalAnalyzer,
    category: 'web',
    languages: ['crystal'],
    frameworks: ['kemal'],
    priority: 112
  },
  {
    name: 'Genie',
    analyzer: GenieAnalyzer,
    category: 'web',
    languages: ['julia'],
    frameworks: ['Genie'],
    priority: 112
  },
  {
    name: 'Compojure',
    analyzer: CompojureAnalyzer,
    category: 'web',
    languages: ['clojure'],
    frameworks: ['compojure'],
    priority: 112
  },
  {
    name: 'Reitit',
    analyzer: ReititAnalyzer,
    category: 'web',
    languages: ['clojure'],
    frameworks: ['reitit', 'ring'],
    priority: 111
  },
  {
    name: 'Sinatra',
    analyzer: SinatraAnalyzer,
    category: 'web',
    languages: ['ruby'],
    frameworks: ['sinatra'],
    priority: 84
  },
  {
    name: 'Slim',
    analyzer: SlimAnalyzer,
    category: 'web',
    languages: ['php'],
    frameworks: ['slim/slim', 'codeigniter4/framework'],
    priority: 83
  },
  {
    name: 'dream',
    analyzer: DreamAnalyzer,
    category: 'web',
    languages: ['ocaml'],
    frameworks: ['dream'],
    priority: 112
  },
  {
    name: 'ApexREST',
    analyzer: ApexRestAnalyzer,
    category: 'web',
    languages: ['apex'],
    frameworks: ['apex-rest'],
    priority: 112
  },
  {
    name: 'Jest',
    analyzer: JestAnalyzer,
    category: 'testing',
    languages: ['javascript', 'typescript'],
    frameworks: ['jest', '@jest/core'],
    priority: 50
  },
  {
    name: 'Cypress',
    analyzer: CypressAnalyzer,
    category: 'testing',
    languages: ['javascript', 'typescript'],
    frameworks: ['cypress'],
    priority: 55
  },
  {
    name: 'Test Frameworks',
    analyzer: TestFrameworkAnalyzer,
    category: 'testing',
    languages: ['javascript', 'typescript', 'python', 'go', 'rust', 'java', 'csharp', 'ruby', 'php'],
    frameworks: ['vitest', 'mocha', 'jasmine', 'node:test', 'pytest', 'unittest', 'junit', 'testng', 'xunit', 'nunit', 'rspec', 'minitest', 'phpunit', 'playwright', 'selenium'],
    priority: 45
  },
  {
    name: 'Airflow',
    analyzer: AirflowAnalyzer,
    category: 'data',
    languages: ['python'],
    frameworks: ['apache-airflow', 'airflow'],
    priority: 105
  },
  {
    name: 'Dagster',
    analyzer: DagsterAnalyzer,
    category: 'data',
    languages: ['python'],
    frameworks: ['dagster'],
    priority: 105
  },
  {
    name: 'Prefect',
    analyzer: PrefectAnalyzer,
    category: 'data',
    languages: ['python'],
    frameworks: ['prefect'],
    priority: 105
  },
  {
    name: 'Luigi',
    analyzer: LuigiAnalyzer,
    category: 'data',
    languages: ['python'],
    frameworks: ['luigi'],
    priority: 100
  },
  {
    name: 'Jupyter Notebook',
    analyzer: JupyterNotebookAnalyzer,
    category: 'data',
    languages: ['python'],
    frameworks: ['jupyter', 'ipynb'],
    priority: 90
  },
  {
    name: 'ML Training (PyTorch/Keras/TensorFlow)',
    analyzer: MLTrainingAnalyzer,
    category: 'data',
    languages: ['python'],
    frameworks: ['torch', 'tensorflow', 'keras'],
    priority: 95
  }
];

// getFrameworkAnalyzer() and detectFrameworkFromFiles() were removed here —
// dead code with zero callers anywhere in the codebase (a duplicate,
// never-invoked detection path from an earlier design; real detection is
// AnalyzerOrchestrator.detectPatterns-based, driven by the live registration
// list in apps/mcp-server/src/analyzer.ts). BaseAnalyzer import removed with
// them.