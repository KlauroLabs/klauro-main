jest.unmock('fs');
jest.unmock('fs-extra');
jest.unmock('glob');

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { OutboundHttpClientAnalyzer } from '../../analyzer/libraries/http/outbound-http-client-analyzer';
import { CASContribution } from '../../types/cas.types';

describe('OutboundHttpClientAnalyzer', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-http-clients-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function analyze(files: Record<string, string>): Promise<CASContribution> {
    for (const [relativePath, content] of Object.entries(files)) {
      const fullPath = path.join(tempDir, relativePath);
      await fs.ensureDir(path.dirname(fullPath));
      await fs.writeFile(fullPath, content);
    }
    const analyzer = new OutboundHttpClientAnalyzer();
    return analyzer.analyze({ projectPath: tempDir } as any);
  }

  function exits(contribution: CASContribution) {
    return contribution.exit_points || [];
  }

  it('extracts TS/JS axios, got, ky, fetch, Apollo, and urql outbound API calls', async () => {
    const contribution = await analyze({
      'package.json': JSON.stringify({
        dependencies: {
          axios: '^1.0.0',
          got: '^14.0.0',
          ky: '^1.0.0',
          'node-fetch': '^3.0.0',
          '@apollo/client': '^3.0.0',
          urql: '^4.0.0',
        },
      }),
      'src/http.ts': [
        "import axios from 'axios';",
        "import got from 'got';",
        "import ky from 'ky';",
        "import fetch from 'node-fetch';",
        "import { ApolloClient } from '@apollo/client';",
        "import { createClient } from 'urql';",
        "const catalog = axios.create({ baseURL: 'https://catalog.example.com/api' });",
        "const inventoryKy = ky.create({ prefixUrl: 'https://inventory.example.com' });",
        "axios.post('https://billing.example.com/payments', {});",
        "got.get('https://audit.example.com/events');",
        "catalog.get('/items');",
        "inventoryKy.post('stock');",
        "fetch('https://search.example.com/query', { method: 'POST' });",
        "new ApolloClient({ uri: 'https://graph.example.com/graphql' });",
        "createClient({ url: 'https://urql.example.com/graphql' });",
      ].join('\n'),
    });

    const endpoints = exits(contribution).map(exit => `${exit.operation?.method} ${exit.target?.endpoint}`);
    expect(endpoints).toEqual(expect.arrayContaining([
      'POST https://billing.example.com/payments',
      'GET https://audit.example.com/events',
      'GET https://catalog.example.com/api/items',
      'POST https://inventory.example.com/stock',
      'POST https://search.example.com/query',
      'POST https://graph.example.com/graphql',
      'POST https://urql.example.com/graphql',
    ]));
    expect(exits(contribution).every(exit => exit.type === 'api')).toBe(true);
  });

  it('extracts Python requests, httpx, and aiohttp outbound API calls', async () => {
    const contribution = await analyze({
      'requirements.txt': ['requests==2.32.0', 'httpx==0.27.0', 'aiohttp==3.9.0'].join('\n'),
      'src/client.py': [
        'import requests',
        'import httpx',
        'import aiohttp',
        "requests.get('https://profiles.example.com/users')",
        "httpx.post('https://events.example.com/ingest', json={})",
        "client = httpx.Client(base_url='https://ledger.example.com')",
        "client.delete('/entries/old')",
        "async with aiohttp.ClientSession(base_url='https://stream.example.com') as session:",
        "    await session.post('/messages')",
      ].join('\n'),
    });

    const endpoints = exits(contribution).map(exit => `${exit.operation?.method} ${exit.target?.endpoint}`);
    expect(endpoints).toEqual(expect.arrayContaining([
      'GET https://profiles.example.com/users',
      'POST https://events.example.com/ingest',
      'DELETE https://ledger.example.com/entries/old',
      'POST https://stream.example.com/messages',
    ]));
  });

  it('extracts Java RestTemplate, WebClient, OkHttp, and Feign outbound API calls', async () => {
    const contribution = await analyze({
      'pom.xml': [
        '<project><dependencies>',
        '<dependency><groupId>org.springframework</groupId><artifactId>spring-web</artifactId></dependency>',
        '<dependency><groupId>org.springframework.cloud</groupId><artifactId>spring-cloud-starter-openfeign</artifactId></dependency>',
        '<dependency><groupId>com.squareup.okhttp3</groupId><artifactId>okhttp</artifactId></dependency>',
        '</dependencies></project>',
      ].join('\n'),
      'src/main/java/example/Clients.java': [
        'import org.springframework.cloud.openfeign.FeignClient;',
        'import org.springframework.web.bind.annotation.GetMapping;',
        'import org.springframework.web.bind.annotation.PostMapping;',
        'import org.springframework.web.client.RestTemplate;',
        'import org.springframework.web.reactive.function.client.WebClient;',
        'import okhttp3.Request;',
        'class Clients {',
        '  void call(RestTemplate restTemplate) {',
        '    restTemplate.getForObject("https://orders.example.com/orders", String.class);',
        '    WebClient webClient = WebClient.builder().baseUrl("https://fulfillment.example.com").build();',
        '    webClient.post().uri("/shipments").retrieve();',
        '    new Request.Builder().url("https://risk.example.com/check").method("POST", null).build();',
        '  }',
        '}',
        '@FeignClient(name = "billing-service", url = "https://billing.example.com", path = "/api")',
        'interface BillingClient {',
        '  @GetMapping("/invoices")',
        '  String invoices();',
        '  @PostMapping("/refunds")',
        '  String refund();',
        '}',
      ].join('\n'),
    });

    const endpoints = exits(contribution).map(exit => `${exit.operation?.method} ${exit.target?.endpoint}`);
    expect(endpoints).toEqual(expect.arrayContaining([
      'GET https://orders.example.com/orders',
      'POST https://fulfillment.example.com/shipments',
      'POST https://risk.example.com/check',
      'GET https://billing.example.com/api/invoices',
      'POST https://billing.example.com/api/refunds',
    ]));
  });

  it('extracts Go net/http and resty outbound API calls', async () => {
    const contribution = await analyze({
      'go.mod': [
        'module example.com/service',
        'require github.com/go-resty/resty/v2 v2.12.0',
      ].join('\n'),
      'client.go': [
        'package client',
        'import (',
        '  "net/http"',
        '  resty "github.com/go-resty/resty/v2"',
        ')',
        'func call() {',
        '  http.Get("https://directory.example.com/users")',
        '  http.NewRequest("POST", "https://tasks.example.com/jobs", nil)',
        '  resty.New().SetBaseURL("https://notify.example.com").R().Post("/messages")',
        '}',
      ].join('\n'),
    });

    const endpoints = exits(contribution).map(exit => `${exit.operation?.method} ${exit.target?.endpoint}`);
    expect(endpoints).toEqual(expect.arrayContaining([
      'GET https://directory.example.com/users',
      'POST https://tasks.example.com/jobs',
      'POST https://notify.example.com/messages',
    ]));
  });

  it('does not fabricate URLs from non-literal or unrelated symbols', async () => {
    const contribution = await analyze({
      'package.json': JSON.stringify({ dependencies: { axios: '^1.0.0' } }),
      'src/no-url.ts': [
        "import axios from 'axios';",
        'const endpoint = process.env.PAYMENTS_URL;',
        'axios.post(endpoint, {});',
        'const local = { get(path: string) { return path; } };',
        "local.get('/internal-only');",
      ].join('\n'),
    });

    expect(exits(contribution)).toHaveLength(0);
  });
});
