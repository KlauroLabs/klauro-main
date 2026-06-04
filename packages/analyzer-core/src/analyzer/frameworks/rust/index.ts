export { ActixAnalyzer } from './actix-analyzer';
export { RocketAnalyzer } from './rocket-analyzer';

// Framework registry for automatic detection
export const RUST_FRAMEWORKS = [
  'actix-analyzer',
  'rocket-analyzer'
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
  }
];