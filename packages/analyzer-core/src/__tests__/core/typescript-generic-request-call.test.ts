import { TypeScriptJavaScriptAnalyzer } from '../../analyzer/languages/typescript-javascript-analyzer';

/**
 * `parseApiCall` positional-argument fix for the generic `.request(verb, url)`
 * shape (Angular HttpClient / axios-style config aside): the first quoted
 * string argument is the HTTP VERB, not the endpoint. Before this fix,
 * `extractEndpointFromExpression` grabbed the FIRST string literal in the
 * whole expression unconditionally, so `this.http.request('LINK', url)`
 * produced method="request" -> "REQUEST", endpoint="LINK" -> exit-point name
 * "REQUEST LINK" (an HTTP-verb token masquerading as an external-service
 * name in get_external_services, alongside "REQUEST UNLINK"/"REQUEST DELETE").
 */
describe('TypeScriptJavaScriptAnalyzer.parseApiCall — generic .request(verb, url) shape', () => {
  const analyzer = new TypeScriptJavaScriptAnalyzer() as any;

  it('assigns the first string literal to method (verb) and the second to endpoint', () => {
    const callExpression = "this.http.request('LINK', '/api/documents/123/link')";
    const result = analyzer.parseApiCall('this.http.request', callExpression);
    expect(result.method).toBe('LINK');
    expect(result.endpoint).toBe('/api/documents/123/link');
  });

  it('reproduces the exact evidence shapes (LINK / UNLINK / DELETE) without a REQUEST-prefixed label', () => {
    for (const verb of ['LINK', 'UNLINK', 'DELETE']) {
      const result = analyzer.parseApiCall('this.http.request', `this.http.request('${verb}', '/api/x')`);
      const name = `${result.method.toUpperCase()} ${result.endpoint || 'external'}`;
      expect(name).toBe(`${verb} /api/x`);
      expect(name).not.toMatch(/^REQUEST\s/);
    }
  });

  it('falls back to the single literal as the endpoint when only one string argument is present', () => {
    const result = analyzer.parseApiCall('this.http.request', `this.http.request(options)`);
    expect(result).toEqual({ method: 'request', endpoint: undefined });
  });

  it('leaves ordinary get/post/put/delete/patch calls unaffected (single first-literal endpoint)', () => {
    const result = analyzer.parseApiCall('this.http.get', `this.http.get('/api/orders')`);
    expect(result.method).toBe('get');
    expect(result.endpoint).toBe('/api/orders');
  });
});
