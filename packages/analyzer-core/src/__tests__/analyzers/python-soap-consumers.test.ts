jest.unmock('glob');
jest.unmock('fs');
jest.unmock('fs-extra');

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { SoapWsdlAnalyzer } from '../../analyzer/languages/soap-wsdl-analyzer';

describe('Python SOAP consumers', () => {
  let projectPath: string;

  beforeEach(async () => {
    projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'python-soap-'));
  });

  afterEach(async () => {
    await fs.remove(projectPath);
  });

  async function analyze(source: string, relativePath = 'gateway.py') {
    const filePath = path.join(projectPath, relativePath);
    await fs.ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, source, 'utf8');
    return new SoapWsdlAnalyzer().analyzeFileSingle({
      projectPath,
      filePath,
      relativePath,
    });
  }

  it('associates configured clients with their operation calls', async () => {
    const result = await analyze([
      'import zeep',
      'from configuration import env',
      '',
      'class Gateway:',
      '    def __init__(self):',
      '        self.client = zeep.Client(wsdl=env.PAYMENT_PROCESSOR_WSDL_URL)',
      '',
      '    def charge(self, request):',
      '        return self.client.service.CreatePayment(request)',
      '',
    ].join('\n'));

    const operation = result.exitPoints.find(exitPoint => exitPoint.operation?.action === 'CreatePayment');
    expect(operation?.name).toBe('SOAP call: Payment Processor::CreatePayment');
    expect(operation?.target?.service_id).toBe('Payment Processor');
    expect(operation?.target?.sdk).toBe('Payment Processor');
    expect(operation?.metadata?.library).toBe('zeep/suds');
  });

  it('uses matching module-path words to separate compressed configuration names', async () => {
    const result = await analyze([
      'import zeep',
      'from configuration import env',
      '',
      'client = zeep.Client(wsdl=env.PAYMENTVISION_WSDL_URL)',
      'client.service.Authorize()',
      '',
    ].join('\n'), 'modules/integrations/payment_vision/controller.py');

    const operation = result.exitPoints.find(exitPoint => exitPoint.operation?.action === 'Authorize');
    expect(operation?.target?.service_id).toBe('Payment Vision');
  });

  it('preserves literal WSDL endpoints', async () => {
    const result = await analyze([
      'from zeep import Client',
      '',
      'client = Client("https://billing.example.test/service?wsdl")',
      'client.service.GetInvoice("123")',
      '',
    ].join('\n'));

    const operation = result.exitPoints.find(exitPoint => exitPoint.operation?.action === 'GetInvoice');
    expect(operation?.target?.endpoint).toBe('https://billing.example.test/service?wsdl');
    expect(operation?.metadata?.endpoint).toBe('https://billing.example.test/service?wsdl');
  });

  it('does not fabricate a service name from transport-only configuration', async () => {
    const result = await analyze([
      'import zeep',
      'from configuration import settings',
      '',
      'client = zeep.Client(wsdl=settings.WSDL_URL)',
      'client.service.Ping()',
      '',
    ].join('\n'));

    const operation = result.exitPoints.find(exitPoint => exitPoint.operation?.action === 'Ping');
    expect(operation?.target?.service_id).toBe('soap_service');
    expect(operation?.target?.sdk).toBe('zeep/suds');
  });
});
