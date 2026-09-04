import { TreeSitterTSExtractor } from '../../analyzer/core/tree-sitter-ts-extractor';

describe('TreeSitterTSExtractor CommonJS export marking', () => {
  const extractor = new TreeSitterTSExtractor();

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
