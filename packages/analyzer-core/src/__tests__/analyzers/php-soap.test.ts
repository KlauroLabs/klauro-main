jest.unmock('fs-extra');
jest.unmock('fs');
jest.unmock('glob');

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { PHPAnalyzer } from '../../analyzer/languages/php-analyzer';

describe('PHP analyzer SOAP exit points', () => {
  let analyzer: PHPAnalyzer;
  let projectPath: string;

  beforeEach(async () => {
    analyzer = new PHPAnalyzer();
    projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'php-soap-test-'));
  });

  afterEach(async () => {
    await fs.remove(projectPath);
  });

  const writeFile = async (relative: string, content: string) => {
    const fullPath = path.join(projectPath, relative);
    await fs.ensureDir(path.dirname(fullPath));
    await fs.writeFile(fullPath, content);
  };

  const analyze = () => analyzer.analyze({ projectPath } as any);

  const soapExits = (contribution: any) =>
    contribution.exit_points.filter((exit: any) => exit.metadata?.protocol === 'soap');

  it('emits an api exit point with the WSDL host for SoapClient construction with a literal WSDL', async () => {
    await writeFile('src/Service/RateService.php', [
      '<?php',
      'namespace App\\Service;',
      '',
      'class RateService {',
      '  public function connect() {',
      "    $client = new \\SoapClient('https://ws.efsllc.com/richapp/Wsdl.action?wsdl=/axis2/services/CardManagementWS');",
      '    return $client;',
      '  }',
      '}',
    ].join('\n'));

    const contribution = await analyze();
    const exits = soapExits(contribution);

    expect(exits).toHaveLength(1);
    expect(exits[0].type).toBe('api');
    expect(exits[0].target.resource).toBe('ws.efsllc.com');
    expect(exits[0].target.endpoint).toContain('https://ws.efsllc.com');
    expect(exits[0].operation.action).toBe('connect');
    expect(exits[0].source_node).toContain('connect');
  });

  it('emits an operation-named exit point for __soapCall on a SoapClient variable', async () => {
    await writeFile('src/Service/LoginService.php', [
      '<?php',
      'namespace App\\Service;',
      '',
      'class LoginService {',
      '  public function login() {',
      "    $client = new \\SoapClient('https://ws.efsllc.com/services?wsdl');",
      "    $session = $client->__soapCall('login', ['user', 'pass']);",
      '    return $session;',
      '  }',
      '}',
    ].join('\n'));

    const contribution = await analyze();
    const exits = soapExits(contribution);
    const loginExit = exits.find((exit: any) => exit.operation?.action === 'login');

    expect(loginExit).toBeDefined();
    expect(loginExit.type).toBe('api');
    expect(loginExit.name).toBe('SOAP call: ws.efsllc.com::login');
    expect(loginExit.target.resource).toBe('ws.efsllc.com');
  });

  it('emits operation exit points for __soapCall inside a class extending SoapClient', async () => {
    await writeFile('src/Client/CardManagementWS.php', [
      '<?php',
      'namespace App\\Client;',
      '',
      'class CardManagementWS extends \\SoapClient {',
      '  public function __construct(array $options = array(), ?string $wsdl = null) {',
      '    if (null === $wsdl) {',
      "      $wsdl = __DIR__ . '/../../resources/wex_CardManagement.xml';",
      '    }',
      '    parent::__construct($wsdl, $options);',
      '  }',
      '',
      '  public function getCarrierInfo($clientId) {',
      "    return $this->__soapCall('getCarrierInfo', array($clientId));",
      '  }',
      '',
      '  public function getCard($clientId, $cardNumber) {',
      "    return $this->__soapCall('getCard', array($clientId, $cardNumber));",
      '  }',
      '}',
    ].join('\n'));

    const contribution = await analyze();
    const exits = soapExits(contribution);
    const operations = exits.map((exit: any) => exit.operation?.action).sort();

    expect(operations).toEqual(['getCard', 'getCarrierInfo']);
    const carrierExit = exits.find((exit: any) => exit.operation?.action === 'getCarrierInfo');
    expect(carrierExit.target.resource).toBe('wex_CardManagement.xml');
    expect(carrierExit.target.sdk).toBe('CardManagementWS');
    expect(carrierExit.source_node).toContain('getCarrierInfo');
  });

  it('emits an operation exit point for a soap method call on a SoapClient-typed property', async () => {
    await writeFile('src/Service/WeatherService.php', [
      '<?php',
      'namespace App\\Service;',
      '',
      'class WeatherService {',
      '  private \\SoapClient $client;',
      '',
      '  public function __construct() {',
      "    $this->client = new \\SoapClient('https://weather.example.com/service.wsdl');",
      '  }',
      '',
      '  public function forecast($city) {',
      '    return $this->client->GetWeather($city);',
      '  }',
      '}',
    ].join('\n'));

    const contribution = await analyze();
    const exits = soapExits(contribution);
    const weatherExit = exits.find((exit: any) => exit.operation?.action === 'GetWeather');

    expect(weatherExit).toBeDefined();
    expect(weatherExit.type).toBe('api');
    expect(weatherExit.target.resource).toBe('weather.example.com');
    expect(weatherExit.source_node).toContain('forecast');
  });

  it('does not emit soap exit points for a non-Soap class with the same method names', async () => {
    await writeFile('src/Service/MockWeatherService.php', [
      '<?php',
      'namespace App\\Service;',
      '',
      '// Stand-in for SoapClient in tests; must not be treated as SoapClient.',
      'class FakeClient {',
      '  public function GetWeather($city) {',
      "    return 'sunny';",
      '  }',
      '}',
      '',
      'class MockWeatherService {',
      '  public function forecast($city) {',
      '    $client = new FakeClient();',
      '    return $client->GetWeather($city);',
      '  }',
      '}',
    ].join('\n'));

    const contribution = await analyze();

    expect(soapExits(contribution)).toHaveLength(0);
  });
});
