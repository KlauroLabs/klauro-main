import { serviceNameFromConfigurationExpression, serviceNameFromEndpoint } from '../core/service-identity';

export interface PythonSoapConsumer {
  relativePath: string;
  fullPath: string;
  line: number;
  library: string;
  operation?: string;
  service?: string;
  endpoint?: string;
  evidence: string;
}

interface PythonSoapClient {
  receiver: string;
  endpoint?: string;
  service?: string;
}

export function extractPythonSoapConsumers(
  relativePath: string,
  fullPath: string,
  content: string,
): PythonSoapConsumer[] {
  const consumers: PythonSoapConsumer[] = [];
  const clients = new Map<string, PythonSoapClient>();
  const assignmentRegex = /\b((?:self\.)?[A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(?:zeep\.)?Client\s*\(([^)\n]*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = assignmentRegex.exec(content)) !== null) {
    const binding = pythonSoapClient(match[1], match[2], relativePath);
    clients.set(binding.receiver, binding);
    consumers.push(consumer(
      relativePath,
      fullPath,
      content,
      match.index,
      undefined,
      binding.endpoint,
      `${binding.receiver} Client`,
      binding.service,
    ));
  }
  const clientRegex = /\b(?:Client|zeep\.Client)\s*\(\s*['"]([^'"]+)['"]/g;
  while ((match = clientRegex.exec(content)) !== null) {
    if ([...clients.values()].some(client => client.endpoint === match![1])) continue;
    consumers.push(consumer(relativePath, fullPath, content, match.index, undefined, match[1], 'Client'));
  }
  const operationRegex = /\b((?:self\.)?[A-Za-z_][A-Za-z0-9_.]*)\.service\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  while ((match = operationRegex.exec(content)) !== null) {
    const binding = clients.get(match[1]);
    consumers.push(consumer(
      relativePath,
      fullPath,
      content,
      match.index,
      match[2],
      binding?.endpoint,
      `${match[1]}.service operation call`,
      binding?.service,
    ));
  }
  return consumers;
}

function pythonSoapClient(receiver: string, argumentsText: string, relativePath: string): PythonSoapClient {
  const argument = argumentsText.match(/\bwsdl\s*=\s*([^,]+)/)?.[1] || argumentsText.split(',')[0];
  const expression = argument?.trim();
  const literal = expression?.match(/^(['"])(.*?)\1$/)?.[2];
  return {
    receiver,
    endpoint: literal,
    service: literal ? serviceNameFromEndpoint(literal) : serviceNameFromConfigurationExpression(expression, relativePath),
  };
}

function consumer(
  relativePath: string,
  fullPath: string,
  content: string,
  index: number,
  operation: string | undefined,
  endpoint: string | undefined,
  evidence: string,
  service?: string,
): PythonSoapConsumer {
  return {
    relativePath,
    fullPath,
    line: content.slice(0, index).split('\n').length,
    library: 'zeep/suds',
    operation,
    service,
    endpoint,
    evidence,
  };
}
