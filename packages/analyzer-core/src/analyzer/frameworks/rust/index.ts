export { ActixAnalyzer } from './actix-analyzer';
export { RocketAnalyzer } from './rocket-analyzer';
export { AxumAnalyzer } from './axum-analyzer';
export { WarpAnalyzer } from './warp-analyzer';
export { TonicAnalyzer } from './tonic-analyzer';


export const RUST_FRAMEWORKS = [
  'actix-analyzer',
  'rocket-analyzer',
  'axum-analyzer',
  'warp-analyzer',
  'tonic-analyzer'
];

export const FRAMEWORK_DETECTORS = [
  {
    id: 'actix-web',
    analyzerClass: 'ActixAnalyzer',
    dependencies: ['actix-web', 'actix_web', 'actix'],
    patterns: [
      /actix_web::/,
      /#\[get\("/,
      /#\[post\("/,
      /HttpServer::/,
      /HttpResponse::/
    ]
  },
  {
    id: 'rocket',
    analyzerClass: 'RocketAnalyzer',
    dependencies: ['rocket', 'rocket_dyn_templates', 'rocket_sync'],
    patterns: [
      /rocket::/,
      /#\[get\("/,
      /#\[post\("/,
      /State</,
      /Template::render/,
      /rocket::build/
    ]
  },
  {
    id: 'warp',
    analyzerClass: 'WarpAnalyzer',
    dependencies: ['warp'],
    patterns: [
      /warp::path\s*[!(]/,
      /warp::(get|post|put|patch|delete)\s*\(\s*\)/,
      /\.and_then\s*\(/
    ]
  },
  {
    id: 'tonic',
    analyzerClass: 'TonicAnalyzer',
    dependencies: ['tonic'],
    patterns: [
      /tonic::async_trait/,
      /tonic::(Request|Response)/,
      /impl\s+\w+\s+for\s+\w+/
    ]
  }
];