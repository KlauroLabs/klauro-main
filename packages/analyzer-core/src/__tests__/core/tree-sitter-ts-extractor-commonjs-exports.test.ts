import { TreeSitterTSExtractor } from '../../analyzer/core/tree-sitter-ts-extractor';

describe('TreeSitterTSExtractor CommonJS export marking', () => {
  const extractor = new TreeSitterTSExtractor();

  it('attaches documentation through assignment, declaration and export wrappers', () => {
    const documented = extractor.extractFromSource(`
      /** Return request headers to the caller. */
      exports.get = exports.header = function header(name) { return name; };
      /** Negotiate the response format. */
      export const negotiate = (type) => type;
      /** Construct a documented client. */
      export default function client() {}
    `, 'api.ts');
    expect(documented.functions.find(fn => fn.name === 'header')?.documentation).toContain('Return request headers');
    expect(documented.functions.find(fn => fn.name === 'negotiate')?.documentation).toContain('Negotiate the response format');
    expect(documented.functions.find(fn => fn.name === 'client')?.documentation).toContain('Construct a documented client');
  });

  it('does not inherit documentation from an unrelated statement or an enclosing callback call', () => {
    const extraction = extractor.extractFromSource(`
      /** Configure the client. */
      configure();
      exports.send = function send(value) { return value; };
      /** Schedule a callback, not its implementation. */
      schedule(function callback() {});
      /** Describe the outer function, not the nested one. */
      exports.outer = function outer() {
        return function inner() {};
      };
    `, 'api.js');
    for (const name of ['send', 'callback', 'inner']) {
      expect(extraction.functions.find(fn => fn.name === name)?.documentation).toBeUndefined();
    }
    expect(extraction.functions.find(fn => fn.name === 'outer')?.documentation).toContain('Describe the outer function');
  });

  it('marks exports.name = fn, module.exports = ident, and members of an export root object', () => {
    const source = `
      var app = exports = module.exports = {};
      app.use = function use(fn) { return fn; };
      app.listen = function listen() {};
      function helper() {}
      exports.json = function json() {};
      function createApplication() {}
      module.exports.create = createApplication;
    `;
    const extraction = extractor.extractFromSource(source, 'lib/application.js');
    const byName = new Map(extraction.functions.map(fn => [fn.name, fn.isExported]));
    expect(byName.get('use')).toBe(true);
    expect(byName.get('listen')).toBe(true);
    expect(byName.get('json')).toBe(true);
    expect(byName.get('createApplication')).toBe(true);
    expect(byName.get('helper')).toBe(false);
  });

  it('marks a declared identifier assigned to module.exports and records require re-exports', () => {
    const source = `
      var res = Object.create(http.ServerResponse.prototype);
      res.send = function send(body) { return body; };
      module.exports = res;
      exports.Router = require('./router');
      exports.static = require('serve-static');
    `;
    const extraction = extractor.extractFromSource(source, 'lib/response.js');
    expect(extraction.variables.find(v => v.name === 'res')?.isExported).toBe(true);
    expect(extraction.functions.find(fn => fn.name === 'send')?.isExported).toBe(true);
    expect(extraction.commonJsReexports).toEqual(['./router', 'serve-static']);
    const viaBinding = extractor.extractFromSource("var proto = require('./application');\nexports.application = proto;", 'lib/express.js');
    expect(viaBinding.commonJsReexports).toEqual(['./application']);
  });

  it('records a whole-module re-export and leaves ESM files untouched', () => {
    expect(extractor.extractFromSource("module.exports = require('./lib/express');", 'index.js').commonJsReexports).toEqual(['./lib/express']);
    const esm = extractor.extractFromSource('export function add() {} function internal() {}', 'index.ts');
    expect(esm.functions.find(fn => fn.name === 'add')?.isExported).toBe(true);
    expect(esm.functions.find(fn => fn.name === 'internal')?.isExported).toBe(false);
    expect(esm.commonJsReexports).toBeUndefined();
  });
});
