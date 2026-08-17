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
    const nodeIds = new Set(cas.nodes.map(node => node.id));
    assert.ok(cas.exit_points.every(exitPoint => nodeIds.has(exitPoint.source_node)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SoapWsdlAnalyzer.analyze returns nothing for a non-SOAP repo', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soap-wsdl-analyzer-negative-'));
  try {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src/index.ts'), "export const add = (a: number, b: number) => a + b;\n");
    fs.writeFileSync(path.join(dir, 'config.xml'), '<config><setting name="debug" value="true"/></config>\n');

    const analyzer = new SoapWsdlAnalyzer();
    assert.equal(await analyzer.canAnalyze(dir), false);

    const cas = await analyzer.analyze({ projectPath: dir });
    assert.equal(cas.nodes.length, 0);
    assert.equal(cas.exit_points.length, 0);
    assert.equal(cas.entry_points.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SoapWsdlAnalyzer does not infer product consumers from test source', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soap-wsdl-test-source-'));
  try {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'soap-client.test.ts'), [
      "import { SoapClient } from 'soap';",
      "test('calls SOAP', () => new SoapClient('https://example.test/service.wsdl'));",
    ].join('\n'));

    const analyzer = new SoapWsdlAnalyzer();
    assert.equal(await analyzer.canAnalyze(dir), false);
    assert.deepEqual(await analyzer.getRelevantFiles(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function wexCardManagementXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<definitions name="CardManagementWS" targetNamespace="http://com.tch.cards.service"',
    '  xmlns="http://schemas.xmlsoap.org/wsdl/"',
    '  xmlns:tns="http://com.tch.cards.service"',
    '  xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/">',
    '  <portType name="CardManagementEP">',
    '    <operation name="getTransExtLoc"></operation>',
    '  </portType>',
    '  <binding name="CardManagementEPBinding" type="tns:CardManagementEP">',
    '    <soap:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>',
    '    <operation name="getTransExtLoc"><soap:operation soapAction=""/></operation>',
    '  </binding>',
    '  <service name="CardManagementWS">',
    '    <port name="CardManagementEPPort" binding="tns:CardManagementEPBinding">',
    '      <soap:address location="http://ws.efsllc.com:8080/axis2/services/CardManagementWS/"/>',
    '    </port>',
    '  </service>',
    '</definitions>',
    '',
  ].join('\n');
}

function makeWexLikeProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soap-wsdl-php-consumer-test-'));

  // Nested generated-client library: the SoapClient-derived class + its WSDL
  // shipped as a plain `.xml` resource (the real wex-client-php shape).
  fs.mkdirSync(path.join(dir, 'wex-client-php/resources'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'wex-client-php/resources/wex_CardManagement.xml'), wexCardManagementXml());

  fs.mkdirSync(path.join(dir, 'wex-client-php/src/Client/Soap/CardManagement'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'wex-client-php/src/Client/Soap/CardManagement/CardManagementWS.php'),
    [
      '<?php',
      'namespace TruckSpy\\Wex\\Client\\Soap\\CardManagement;',
      '',
      'class CardManagementWS extends \\SoapClient',
      '{',
      '    public function __construct(array $options = array(), ?string $wsdl = null)',
      '    {',
      '        if (null === $wsdl) {',
      "            \$wsdl = __DIR__ . '/../../../../resources/wex_CardManagement.xml';",
      '        }',
      '        parent::__construct($wsdl, $options);',
      '    }',
      '}',
      '',
    ].join('\n')
  );

  // Consumer app: never mentions SoapClient/__soapCall itself — the
  // real-world gap this analyzer closes.
  fs.mkdirSync(path.join(dir, 'app/src/Service'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'app/src/Service/WexTransactionProvider.php'),
    [
      '<?php',
      'namespace App\\Service;',
      '',
      'use TruckSpy\\Wex\\Client\\Soap\\CardManagement\\CardManagementWS;',
      '',
      'class WexTransactionProvider',
      '{',
      '    private CardManagementWS $cardManagementWS;',
      '',
      '    public function __construct()',
      '    {',
      "        \$this->cardManagementWS = new CardManagementWS(['use_proxy' => false]);",
      '    }',
      '',
      '    public function getTransactions()',
      '    {',
      '        return $this->cardManagementWS->getTransExtLoc($this->getAuth());',
      '    }',
      '',
      '    public function login($username, $password)',
      '    {',
      '        return $this->cardManagementWS->login($username, $password);',
      '    }',
      '}',
      '',
    ].join('\n')
  );

  return dir;
}

test('SoapWsdlAnalyzer recognizes a WSDL document shipped as a plain .xml resource', async () => {
  const dir = makeWexLikeProject();
  try {
    const analyzer = new SoapWsdlAnalyzer();
    const cas = await analyzer.analyze({ projectPath: dir });

    const serviceNode = cas.nodes.find(n => n.type === 'soap_service' && n.name === 'CardManagementWS');
    assert.ok(serviceNode, 'CardManagementWS service node parsed from the .xml WSDL resource');

    const operationNode = cas.nodes.find(n => n.type === 'soap_operation' && n.name === 'getTransExtLoc');
    assert.ok(operationNode, 'getTransExtLoc operation node parsed from the .xml WSDL resource');
    assert.equal(operationNode!.metadata?.attributes?.address, 'http://ws.efsllc.com:8080/axis2/services/CardManagementWS/');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SoapWsdlAnalyzer emits sync exit points for a generated SOAP client used via a typed property in another PHP file', async () => {
  const dir = makeWexLikeProject();
  try {
    const analyzer = new SoapWsdlAnalyzer();
    const cas = await analyzer.analyze({ projectPath: dir });

    const phpExits = cas.exit_points.filter(ep => ep.metadata?.protocol === 'soap' && ep.metadata?.library === 'php-generated-soap-client');
    const operations = phpExits.map(ep => ep.operation?.action).sort();
    assert.deepEqual(operations, ['getTransExtLoc', 'login']);

    const transExitLoc = phpExits.find(ep => ep.operation?.action === 'getTransExtLoc')!;
    assert.equal(transExitLoc.operation?.async, false, 'SOAP calls are SYNC (direct call awaiting result)');
    // Service name resolved from the real WSDL <service> element, not a guess.
    assert.equal(transExitLoc.target?.sdk, 'CardManagementWS');
    assert.equal(transExitLoc.target?.resource, 'CardManagementWS');
    assert.equal(transExitLoc.name, 'SOAP call: CardManagementWS::getTransExtLoc');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SoapWsdlAnalyzer does not double-count a PHP file already covered by native SoapClient/__soapCall detection', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soap-wsdl-php-disjoint-test-'));
  try {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'src/RateService.php'),
      [
        '<?php',
        'namespace App\\Service;',
        '',
        'class RateService {',
        '  public function connect() {',
        "    \$client = new \\SoapClient('https://ws.efsllc.com/services?wsdl');",
        "    return \$client->__soapCall('login', ['user', 'pass']);",
        '  }',
        '}',
        '',
      ].join('\n')
    );

    const analyzer = new SoapWsdlAnalyzer();
    const cas = await analyzer.analyze({ projectPath: dir });

    // This file is php-analyzer.ts's own territory (literal SoapClient /
    // __soapCall tokens) — the PHP consumer pass here must stay out of it.
    assert.equal(cas.exit_points.filter(ep => ep.metadata?.library === 'php-generated-soap-client').length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
