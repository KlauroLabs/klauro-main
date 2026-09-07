import { LANGUAGE_REGISTRY } from './language-registry';
import { LANGUAGE_SPECS } from './language-spec';

export const LanguageAnalyzers = {
  python: "PythonAnalyzer",
  javascript: "TypeScriptJavaScriptAnalyzer",
  typescript: "TypeScriptJavaScriptAnalyzer",
  java: "JavaAnalyzer",
  csharp: "CSharpAnalyzer",
  vb: "CSharpAnalyzer",
  go: "GoAnalyzer",
  rust: "RustAnalyzer",
  php: "PHPAnalyzer",
  ruby: "RubyAnalyzer",
  dart: "DartAnalyzer",
  terraform: "TerraformAnalyzer",
  cloudformation: "CloudFormationAnalyzer",
  sql: "SqlSchemaAnalyzer",
  c: "CCppAnalyzer",
  cpp: "CCppAnalyzer",
  kotlin: "KotlinAnalyzer",
  swift: "SwiftAnalyzer",
  solidity: "SolidityAnalyzer",
  elixir: "ElixirAnalyzer",
  shell: "ShellAnalyzer",
  bash: "ShellAnalyzer",
  protobuf: "ProtobufAnalyzer",
  proto: "ProtobufAnalyzer",
  wsdl: "SoapWsdlAnalyzer",
  xsd: "SoapWsdlAnalyzer",
} as const;

export function breadthLanguageExtensions(): ReadonlyMap<string, string> {
  const deepLanguages = new Set<string>(Object.keys(LanguageAnalyzers));
  const extensions = new Map<string, string>();
  for (const entry of LANGUAGE_REGISTRY) {
    if (deepLanguages.has(entry.id) || !LANGUAGE_SPECS[entry.id]) continue;
    for (const extension of entry.extensions) {
      extensions.set(`.${extension.toLowerCase()}`, entry.id);
    }
  }
  return extensions;
}
