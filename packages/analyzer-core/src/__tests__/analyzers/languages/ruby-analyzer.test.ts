import { RubyAnalyzer } from '../../../analyzer/languages/ruby-analyzer';

describe('RubyAnalyzer', () => {
  let analyzer: RubyAnalyzer;

  beforeEach(() => {
    analyzer = new RubyAnalyzer();
  });

  describe('parseRubySource', () => {
    it('extracts classes with superclass, methods, and visibility', () => {
      const source = [
        'class Invoice < Document',
        '  def total',
        '    line_items.sum(&:amount)',
        '  end',
        '',
        '  def self.recent',
        '    order(created_at: :desc)',
        '  end',
        '',
        '  private',
        '',
        '  def round(value)',
        '    value.round(2)',
        '  end',
        'end',
      ].join('\n');

      const analysis = analyzer.parseRubySource(source, 'app/models/invoice.rb');

      expect(analysis.classes).toHaveLength(1);
      const invoice = analysis.classes[0];
      expect(invoice.name).toBe('Invoice');
      expect(invoice.superclass).toBe('Document');
      expect(invoice.methods.map(method => method.name)).toEqual(['total', 'recent', 'round']);
      expect(invoice.methods.find(method => method.name === 'recent')?.isSingleton).toBe(true);
      expect(invoice.methods.find(method => method.name === 'round')?.visibility).toBe('private');
      expect(invoice.methods.find(method => method.name === 'round')?.parameters).toEqual(['value']);
    });

    it('extracts modules, constants, attributes, and mixins', () => {
      const source = [
        'module Billing',
        '  TAX_RATE = 0.21',
        '',
        '  def charge',
        '  end',
        'end',
        '',
        'class Account',
        '  include Billing',
        '  extend Enumerable',
        '  attr_accessor :name, :balance',
        '  attr_reader :id',
        '',
        '  CURRENCY = "USD"',
        'end',
      ].join('\n');

      const analysis = analyzer.parseRubySource(source, 'lib/account.rb');

      expect(analysis.modules.map(item => item.name)).toEqual(['Billing']);
      expect(analysis.modules[0].constants.map(item => item.name)).toEqual(['TAX_RATE']);
      expect(analysis.modules[0].methods.map(item => item.name)).toEqual(['charge']);

      const account = analysis.classes[0];
      expect(account.includedModules).toEqual(['Billing']);
      expect(account.extendedModules).toEqual(['Enumerable']);
      expect(account.attributes.map(item => item.name)).toEqual(['name', 'balance', 'id']);
      expect(account.constants.map(item => item.name)).toEqual(['CURRENCY']);
    });

    it('extracts requires, top-level methods, and top-level constants', () => {
      const source = [
        "require 'json'",
        "require_relative '../lib/helper'",
        '',
        'VERSION = "1.0.0"',
        '',
        'def main',
        '  LOCAL_LOOKING = "not top level"',
        '  puts VERSION',
        'end',
      ].join('\n');

      const analysis = analyzer.parseRubySource(source, 'bin/run.rb');

      expect(analysis.requires.map(item => item.target)).toEqual(['json', '../lib/helper']);
      expect(analysis.requires[1].relative).toBe(true);
      expect(analysis.topLevelMethods.map(item => item.name)).toEqual(['main']);
      expect(analysis.topLevelConstants.map(item => item.name)).toEqual(['VERSION']);
    });

    it('does not treat nested blocks or comments as scope owners', () => {
      const source = [
        '# class FakeComment',
        'class Worker',
        '  def run',
        '    items.each do |item|',
        '      process(item)',
        '    end',
        '    if ready?',
        '      finish',
        '    end',
        '  end',
        '',
        '  def done?',
        '    true',
        '  end',
        'end',
      ].join('\n');

      const analysis = analyzer.parseRubySource(source, 'app/worker.rb');

      expect(analysis.classes).toHaveLength(1);
      expect(analysis.classes[0].methods.map(item => item.name)).toEqual(['run', 'done?']);
      expect(analysis.classes[0].lineEnd).toBe(15);
    });
  });

  describe('analyze contribution shape', () => {
    it('builds class, method, and inheritance graph elements from parsed source', () => {
      const source = [
        'class Base',
        'end',
        '',
        'class Child < Base',
        '  def call',
        '  end',
        'end',
      ].join('\n');

      const internal = analyzer as any;
      const nodes: any[] = [];
      const edges: any[] = [];
      const analysis = analyzer.parseRubySource(source, 'lib/child.rb');
      internal.emitFileNodes(analysis, 'lib/child.rb', '/project/lib/child.rb', nodes, edges);
      internal.buildInheritanceEdges([analysis], nodes, edges);

      const classNodes = nodes.filter(node => node.type === 'class');
      expect(classNodes.map(node => node.name)).toEqual(['Base', 'Child']);
      expect(nodes.some(node => node.type === 'method' && node.name === 'call')).toBe(true);
      expect(edges.some(edge => edge.type === 'contains')).toBe(true);

      const extendsEdge = edges.find(edge => edge.type === 'extends');
      expect(extendsEdge).toBeDefined();
      const child = classNodes.find(node => node.name === 'Child');
      const base = classNodes.find(node => node.name === 'Base');
      expect(extendsEdge.source).toBe(child.id);
      expect(extendsEdge.target).toBe(base.id);
    });
  });
});
