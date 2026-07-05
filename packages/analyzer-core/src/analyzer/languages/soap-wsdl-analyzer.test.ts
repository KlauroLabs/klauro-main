import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SoapWsdlAnalyzer } from './soap-wsdl-analyzer';

function makeTempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soap-wsdl-analyzer-test-'));

  const wsdl = [
    '<?xml version="1.0"?>',
    '<definitions xmlns="http://schemas.xmlsoap.org/wsdl/"',
    '  xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"',
    '  xmlns:tns="urn:billing"',
    '  xmlns:xsd="http://www.w3.org/2001/XMLSchema"',
    '  targetNamespace="urn:billing">',
    '  <types>',
    '    <xsd:schema targetNamespace="urn:billing">',
    '      <xsd:element name="GetInvoiceRequest">',
    '        <xsd:complexType>',
    '          <xsd:sequence>',
    '            <xsd:element name="invoiceId" type="xsd:string"/>',
    '          </xsd:sequence>',
    '        </xsd:complexType>',
    '      </xsd:element>',
    '      <xsd:complexType name="Invoice">',
    '        <xsd:sequence>',
    '          <xsd:element name="total" type="xsd:decimal"/>',
    '        </xsd:sequence>',
    '      </xsd:complexType>',
    '    </xsd:schema>',
    '  </types>',
    '  <message name="GetInvoiceInput">',
    '    <part name="parameters" element="tns:GetInvoiceRequest"/>',
    '  </message>',
    '  <message name="GetInvoiceOutput">',
    '    <part name="parameters" type="tns:Invoice"/>',
    '  </message>',
    '  <portType name="BillingPortType">',
    '    <operation name="GetInvoice">',
    '      <input message="tns:GetInvoiceInput"/>',
    '      <output message="tns:GetInvoiceOutput"/>',
    '    </operation>',
    '  </portType>',
    '  <binding name="BillingSoapBinding" type="tns:BillingPortType">',
    '    <soap:binding transport="http://schemas.xmlsoap.org/soap/http" style="document"/>',
    '    <operation name="GetInvoice">',
    '      <soap:operation soapAction="urn:GetInvoice"/>',
    '    </operation>',
    '  </binding>',
    '  <service name="BillingService">',
    '    <port name="BillingSoapPort" binding="tns:BillingSoapBinding">',
    '      <soap:address location="https://billing.example.test/soap"/>',
    '    </port>',
    '  </service>',
    '</definitions>',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'billing.wsdl'), wsdl);

  const xsd = [
    '<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:shared">',
    '  <xsd:complexType name="Money">',
    '    <xsd:sequence>',
    '      <xsd:element name="amount" type="xsd:decimal"/>',
    '      <xsd:element name="currency" type="xsd:string"/>',
    '    </xsd:sequence>',
    '  </xsd:complexType>',
    '</xsd:schema>',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'shared.xsd'), xsd);

  const client = [
    "import { createClientAsync } from 'soap';",
    '',
    'export async function loadInvoice() {',
    "  const client = await createClientAsync('https://billing.example.test/billing.wsdl');",
    "  return client.GetInvoiceAsync({ invoiceId: 'inv_1' });",
    '}',
    '',
  ].join('\n');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/client.ts'), client);

  return dir;
}

test('SoapWsdlAnalyzer.canAnalyze returns true for WSDL contracts and SOAP consumers', async () => {
  const dir = makeTempProject();
  try {
    const analyzer = new SoapWsdlAnalyzer();
    assert.equal(await analyzer.canAnalyze(dir), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SoapWsdlAnalyzer.analyze extracts services, operations, messages, schema types, entry points, and consumer exits', async () => {
  const dir = makeTempProject();
  try {
    const analyzer = new SoapWsdlAnalyzer();
    const cas = await analyzer.analyze({ projectPath: dir });

    const serviceNode = cas.nodes.find(n => n.type === 'soap_service' && n.name === 'BillingService');
    assert.ok(serviceNode, 'BillingService node exists');

    const operationNode = cas.nodes.find(n => n.type === 'soap_operation' && n.name === 'GetInvoice');
    assert.ok(operationNode, 'GetInvoice operation node exists');
    assert.equal(operationNode!.metadata?.attributes?.protocol, 'soap11');
    assert.equal(operationNode!.metadata?.attributes?.soapAction, 'urn:GetInvoice');
    assert.equal(operationNode!.metadata?.attributes?.address, 'https://billing.example.test/soap');

    const messageNames = cas.nodes
      .filter(n => n.type === 'data-entity' && n.metadata?.language === 'wsdl')
      .map(n => n.name)
      .sort();
    assert.deepEqual(messageNames, ['GetInvoiceInput', 'GetInvoiceOutput']);

    const schemaTypeNames = cas.nodes
      .filter(n => n.type === 'data-entity' && n.metadata?.language === 'xsd')
      .map(n => n.name)
      .sort();
    assert.deepEqual(schemaTypeNames, ['GetInvoiceRequest', 'Invoice', 'Money']);

    const inputMessage = cas.nodes.find(n => n.name === 'GetInvoiceInput')!;
    const outputMessage = cas.nodes.find(n => n.name === 'GetInvoiceOutput')!;
    assert.ok(cas.edges.some(e => e.source === operationNode!.id && e.target === inputMessage.id && e.metadata?.role === 'request'));
    assert.ok(cas.edges.some(e => e.source === operationNode!.id && e.target === outputMessage.id && e.metadata?.role === 'response'));

    assert.equal(cas.entry_points.length, 1);
    assert.equal(cas.entry_points[0].type, 'api');
    assert.equal(cas.entry_points[0].metadata?.protocol, 'soap');
    assert.equal(cas.entry_points[0].metadata?.operation, 'GetInvoice');

    assert.equal(cas.exit_points.length, 2);
    assert.ok(cas.exit_points.some(ep => ep.type === 'api' && ep.metadata?.endpoint === 'https://billing.example.test/billing.wsdl'));
    assert.ok(cas.exit_points.some(ep => ep.type === 'api' && ep.metadata?.operation === 'GetInvoice'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
