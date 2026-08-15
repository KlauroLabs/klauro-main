import { RubyAnalyzer } from '../../../analyzer/languages/ruby-analyzer';
import { buildRubySnapshotAnalysis } from '../../../analyzer/languages/ruby-snapshot-analysis';

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
      internal.emitFileNodes(analysis, 'lib/child.rb', nodes, edges);
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

  describe('call edge extraction', () => {
    const buildEdges = (sources: Array<[string, string]>) => {
      const analyses = sources.map(([path, source]) => analyzer.parseRubySource(source, path));
      const edges: any[] = [];
      analyzer.buildCallEdges(analyses, edges);
      return edges.filter(edge => edge.type === 'calls');
    };

    it('links same-class bare method calls, with and without parentheses', () => {
      const callEdges = buildEdges([[
        'app/models/order.rb',
        [
          'class Order',
          '  def complete!',
          '    finalize_payment(total)',
          '    notify_customer',
          '  end',
          '',
          '  def finalize_payment(amount)',
          '  end',
          '',
          '  def notify_customer',
          '  end',
          'end',
        ].join('\n'),
      ]]);

      expect(callEdges).toHaveLength(2);
      const targets = callEdges.map(edge => edge.metadata.attributes.targetMethod).sort();
      expect(targets).toEqual(['finalize_payment', 'notify_customer']);
      for (const edge of callEdges) {
        expect(edge.metadata.attributes.targetClass).toBe('Order');
        expect(edge.metadata.attributes.callType).toBe('implicit');
      }
    });

    it('links constant-receiver calls to singleton methods of known classes', () => {
      const callEdges = buildEdges([
        [
          'app/models/order.rb',
          [
            'module Spree',
            '  class Order',
            '    def subscribe_customer',
            '      Spree::NewsletterSubscriber.subscribe(email)',
            '    end',
            '  end',
            'end',
          ].join('\n'),
        ],
        [
          'app/models/newsletter_subscriber.rb',
          [
            'module Spree',
            '  class NewsletterSubscriber',
            '    def self.subscribe(email)',
            '    end',
            '  end',
            'end',
          ].join('\n'),
        ],
      ]);

      expect(callEdges).toHaveLength(1);
      expect(callEdges[0].metadata.attributes.callType).toBe('static');
      expect(callEdges[0].metadata.attributes.targetClass).toBe('Spree::NewsletterSubscriber');
      expect(callEdges[0].metadata.attributes.targetMethod).toBe('subscribe');
    });

    it('links instance-variable calls when the assignment traces to a known class', () => {
      const callEdges = buildEdges([
        [
          'app/services/checkout.rb',
          [
            'class Checkout',
            '  def initialize',
            '    @gateway = PaymentGateway.new',
            '  end',
            '',
            '  def pay',
            '    @gateway.charge(total)',
            '  end',
            'end',
          ].join('\n'),
        ],
        [
          'app/services/payment_gateway.rb',
          [
            'class PaymentGateway',
            '  def charge(amount)',
            '  end',
            'end',
          ].join('\n'),
        ],
      ]);

      const chargeEdge = callEdges.find(edge => edge.metadata.attributes.targetMethod === 'charge');
      expect(chargeEdge).toBeDefined();
      expect(chargeEdge.metadata.attributes.callType).toBe('method');
      expect(chargeEdge.metadata.attributes.targetClass).toBe('PaymentGateway');
      expect(chargeEdge.metadata.attributes.receiver).toBe('gateway');
    });

    it('resolves calls against owners restored from a prior CAS snapshot', () => {
      const current = analyzer.parseRubySource([
        'class ShiftTypesController < ApplicationController',
        '  def initialize',
        '    @service = ShiftTypeService.new',
        '  end',
        '',
        '  def create',
        '    @service.bulk_update(params)',
        '  end',
        'end',
      ].join('\n'), 'app/controllers/shift_types_controller.rb');
      const snapshotNodes: any[] = [
        {
          id: 'class_application_controller',
          name: 'ApplicationController',
          type: 'class',
          source: { file: 'app/controllers/application_controller.rb', line: 1 },
          metadata: { framework: 'ruby', attributes: { qualified_name: 'ApplicationController' } },
        },
        {
          id: 'class_shift_type_service',
          name: 'ShiftTypeService',
          type: 'class',
          source: { file: 'app/services/shift_type_service.rb', line: 1 },
          metadata: { framework: 'ruby', attributes: { qualified_name: 'ShiftTypeService' } },
        },
        {
          id: 'method_shift_type_service_bulk_update',
          name: 'bulk_update',
          type: 'method',
          parent: 'class_shift_type_service',
          source: { file: 'app/services/shift_type_service.rb', line: 2 },
          metadata: { framework: 'ruby', attributes: { visibility: 'public', singleton: false } },
          signature: { parameters: [{ name: 'params', type: 'Object' }] },
        },
      ];
      const internal = analyzer as any;
      const snapshot = buildRubySnapshotAnalysis(snapshotNodes, 'app/controllers/shift_types_controller.rb');
      const edges: any[] = [];
      const currentNodes: any[] = [];
      internal.emitFileNodes(current, 'app/controllers/shift_types_controller.rb', currentNodes, edges);
      internal.buildInheritanceEdges([current], [...snapshotNodes, ...currentNodes], edges);

      analyzer.buildCallEdges([current, snapshot], edges);

      expect(edges.some(edge =>
        edge.type === 'calls' &&
        edge.metadata.attributes.targetClass === 'ShiftTypeService' &&
        edge.metadata.attributes.targetMethod === 'bulk_update'
      )).toBe(true);
      expect(edges.some(edge => edge.type === 'extends' && edge.target === 'class_application_controller')).toBe(true);
    });

    it('links bare calls to methods of included modules within scope', () => {
      const callEdges = buildEdges([[
        'app/models/account.rb',
        [
          'module Billing',
          '  def charge_account',
          '  end',
          'end',
          '',
          'class Account',
          '  include Billing',
          '',
          '  def close',
          '    charge_account',
          '  end',
          'end',
        ].join('\n'),
      ]]);

      expect(callEdges).toHaveLength(1);
      expect(callEdges[0].metadata.attributes.callType).toBe('mixin');
      expect(callEdges[0].metadata.attributes.targetClass).toBe('Billing');
    });

    it('prunes mixin-resolved calls when the method name is defined in more than three owners', () => {
      const popularDefinition = (className: string) => [
        `class ${className}`,
        '  def refresh',
        '  end',
        'end',
      ].join('\n');

      const callEdges = buildEdges([
        ['app/models/a.rb', popularDefinition('Alpha')],
        ['app/models/b.rb', popularDefinition('Beta')],
        ['app/models/c.rb', popularDefinition('Gamma')],
        ['app/models/d.rb', popularDefinition('Delta')],
        [
          'app/models/caller.rb',
          [
            'module Refreshable',
            '  def refresh',
            '  end',
            'end',
            '',
            'class Caller',
            '  include Refreshable',
            '',
            '  def run',
            '    refresh',
            '  end',
            'end',
          ].join('\n'),
        ],
      ]);

      expect(callEdges).toHaveLength(0);
    });

    it('keeps same-class calls even when the method name is popular elsewhere', () => {
      const popularDefinition = (className: string) => [
        `class ${className}`,
        '  def refresh',
        '  end',
        'end',
      ].join('\n');

      const callEdges = buildEdges([
        ['app/models/a.rb', popularDefinition('Alpha')],
        ['app/models/b.rb', popularDefinition('Beta')],
        ['app/models/c.rb', popularDefinition('Gamma')],
        ['app/models/d.rb', popularDefinition('Delta')],
        [
          'app/models/caller.rb',
          [
            'class Caller',
            '  def refresh',
            '  end',
            '',
            '  def run',
            '    refresh',
            '  end',
            'end',
          ].join('\n'),
        ],
      ]);

      expect(callEdges).toHaveLength(1);
      expect(callEdges[0].metadata.attributes.targetClass).toBe('Caller');
    });

    it('does not create edges for local variable assignments or unresolved receivers', () => {
      const callEdges = buildEdges([[
        'app/models/order.rb',
        [
          'class Order',
          '  def run',
          '    total = compute_total',
          '    other.update_totals',
          '    UnknownService.perform',
          '  end',
          'end',
        ].join('\n'),
      ]]);

      expect(callEdges).toHaveLength(0);
    });
  });

  describe('state machine extraction', () => {
    it('extracts a checkout-like state_machines DSL block with states, events, and transitions', () => {
      const source = [
        'module Spree',
        '  class Order',
        '    state_machine :state, initial: :cart do',
        '      event :next do',
        '        transition from: :cart, to: :address',
        '      end',
        '',
        '      event :cancel do',
        '        transition to: :canceled, if: :allow_cancel?',
        '      end',
        '',
        '      event :return do',
        '        transition to: :returned,',
        '                   from: [:complete, :awaiting_return, :canceled],',
        '                   if: :all_inventory_units_returned?',
        '      end',
        '',
        '      before_transition to: :complete, do: :ensure_line_items_are_in_stock',
        '',
        '      if states[:payment]',
        '        before_transition to: :payment, do: :set_shipments_cost',
        '      end',
        '',
        '      after_transition from: any - :cart, to: any - [:confirm, :complete] do |order|',
        '        order.update_totals',
        '      end',
        '    end',
        '  end',
        'end',
      ].join('\n');

      const analysis = analyzer.parseRubySource(source, 'app/models/spree/order.rb');
      const order = analysis.classes.find(item => item.name === 'Order');
      expect(order).toBeDefined();
      expect(order!.stateMachines).toHaveLength(1);

      const machine = order!.stateMachines[0];
      expect(machine.dsl).toBe('state_machines');
      expect(machine.attribute).toBe('state');
      expect(machine.initialState).toBe('cart');
      expect(machine.states).toEqual(expect.arrayContaining([
        'cart', 'address', 'canceled', 'returned', 'complete',
        'awaiting_return', 'payment', 'confirm',
      ]));

      const eventNames = machine.transitions.map(transition => transition.event);
      expect(eventNames).toEqual(['next', 'cancel', 'return']);

      const nextTransition = machine.transitions.find(transition => transition.event === 'next');
      expect(nextTransition).toMatchObject({ from: ['cart'], to: 'address', conditional: false });

      const returnTransition = machine.transitions.find(transition => transition.event === 'return');
      expect(returnTransition).toMatchObject({
        from: ['complete', 'awaiting_return', 'canceled'],
        to: 'returned',
        conditional: true,
      });

      const cancelTransition = machine.transitions.find(transition => transition.event === 'cancel');
      expect(cancelTransition).toMatchObject({ from: [], to: 'canceled', conditional: true });
    });

    it('extracts aasm blocks with declared states and transitions', () => {
      const source = [
        'class Shipment',
        '  include AASM',
        '',
        '  aasm column: :status do',
        '    state :pending, initial: true',
        '    state :ready',
        '    state :shipped',
        '',
        '    event :prepare do',
        '      transitions from: :pending, to: :ready',
        '    end',
        '',
        '    event :ship do',
        '      transitions from: :ready, to: :shipped',
        '    end',
        '  end',
        'end',
      ].join('\n');

      const analysis = analyzer.parseRubySource(source, 'app/models/shipment.rb');
      const shipment = analysis.classes[0];
      expect(shipment.stateMachines).toHaveLength(1);

      const machine = shipment.stateMachines[0];
      expect(machine.dsl).toBe('aasm');
      expect(machine.attribute).toBe('status');
      expect(machine.initialState).toBe('pending');
      expect(machine.states).toEqual(['pending', 'ready', 'shipped']);
      expect(machine.transitions).toEqual([
        expect.objectContaining({ event: 'prepare', from: ['pending'], to: 'ready' }),
        expect.objectContaining({ event: 'ship', from: ['ready'], to: 'shipped' }),
      ]);
    });

    it('emits state nodes parented to the owner and event-named transition edges', () => {
      const source = [
        'class Order',
        '  state_machine :state, initial: :cart do',
        '    event :next do',
        '      transition from: :cart, to: :address',
        '    end',
        '',
        '    event :cancel do',
        '      transition to: :canceled',
        '    end',
        '  end',
        'end',
      ].join('\n');

      const internal = analyzer as any;
      const nodes: any[] = [];
      const edges: any[] = [];
      const analysis = analyzer.parseRubySource(source, 'app/models/order.rb');
      internal.emitFileNodes(analysis, 'app/models/order.rb', nodes, edges);

      const orderNode = nodes.find(node => node.type === 'class' && node.name === 'Order');
      expect(orderNode.metadata.attributes.state_machines).toHaveLength(1);
      expect(orderNode.metadata.attributes.state_machines[0].initial_state).toBe('cart');

      const stateNodes = nodes.filter(node => node.type === 'state');
      expect(stateNodes.map(node => node.name).sort()).toEqual(['address', 'canceled', 'cart']);
      for (const stateNode of stateNodes) {
        expect(edges.some(edge =>
          edge.type === 'contains' && edge.source === orderNode.id && edge.target === stateNode.id
        )).toBe(true);
      }

      const cartNode = stateNodes.find(node => node.name === 'cart');
      expect(cartNode.metadata.attributes.initial).toBe(true);

      const transitionEdges = edges.filter(edge => edge.type === 'transitions_to');
      expect(transitionEdges).toHaveLength(2);

      const nextEdge = transitionEdges.find(edge => edge.metadata.attributes.event === 'next');
      const addressNode = stateNodes.find(node => node.name === 'address');
      expect(nextEdge.source).toBe(cartNode.id);
      expect(nextEdge.target).toBe(addressNode.id);

      const cancelEdge = transitionEdges.find(edge => edge.metadata.attributes.event === 'cancel');
      const canceledNode = stateNodes.find(node => node.name === 'canceled');
      expect(cancelEdge.source).toBe(orderNode.id);
      expect(cancelEdge.target).toBe(canceledNode.id);
      expect(cancelEdge.metadata.attributes.from).toEqual(['any']);
    });

    it('does not harvest transition callback symbols as states', () => {
      const source = [
        'class Shipment',
        '  state_machine :state, initial: :pending do',
        '    event :ship do',
        '      transition from: :ready, to: :shipped',
        '    end',
        '',
        '    after_transition to: :shipped, do: [:after_ship, :send_shipment_shipped_webhook, :publish_shipment_shipped_event]',
        '    after_transition to: :canceled, do: :after_cancel',
        '    before_transition from: [:pending, :ready], to: :canceled, do: :ensure_cancelable',
        '  end',
        'end',
      ].join('\n');

      const analysis = analyzer.parseRubySource(source, 'app/models/shipment.rb');
      const machine = analysis.classes[0].stateMachines[0];
      expect([...machine.states].sort()).toEqual(['canceled', 'pending', 'ready', 'shipped']);
    });

    it('builds a linear transition chain from sequential go_to_state calls in a checkout_flow block', () => {
      const source = [
        'module Spree',
        '  class Order',
        '    MONEY_VALIDATION = { presence: true }.freeze',
        '',
        '    POSITIVE_MONEY_VALIDATION = MONEY_VALIDATION.deep_dup.tap do |validation|',
        '      validation.fetch(:numericality)[:greater_than_or_equal_to] = 0',
        '    end.freeze',
        '',
        '    checkout_flow do',
        '      go_to_state :address',
        '      go_to_state :delivery, if: ->(order) { order.delivery_required? }',
        '      go_to_state :payment, if: ->(order) { order.payment_required? }',
        '      go_to_state :confirm, if: ->(order) { order.confirmation_required? }',
        '      go_to_state :complete',
        '    end',
        '',
        '    def self.insert_checkout_step(name, options = {})',
        '      checkout_flow do',
        '        go_to_state(name, options)',
        '      end',
        '    end',
        '  end',
        'end',
      ].join('\n');

      const analysis = analyzer.parseRubySource(source, 'app/models/spree/order.rb');
      const order = analysis.classes.find(item => item.name === 'Order');
      expect(order!.stateMachines).toHaveLength(1);

      const machine = order!.stateMachines[0];
      expect(machine.dsl).toBe('checkout_flow');
      expect(machine.attribute).toBe('state');
      expect(machine.initialState).toBe('cart');
      expect(machine.states).toEqual(['cart', 'address', 'delivery', 'payment', 'confirm', 'complete']);
      expect(machine.transitions).toEqual([
        expect.objectContaining({ event: 'next', from: ['cart'], to: 'address', conditional: false }),
        expect.objectContaining({ event: 'next', from: ['address'], to: 'delivery', conditional: true }),
        expect.objectContaining({ event: 'next', from: ['delivery'], to: 'payment', conditional: true }),
        expect.objectContaining({ event: 'next', from: ['payment'], to: 'confirm', conditional: true }),
        expect.objectContaining({ event: 'next', from: ['confirm'], to: 'complete', conditional: false }),
      ]);
    });

    it('parents state machines to the declaring class, not an inline nested class', () => {
      const source = [
        'module Spree',
        '  class Reimbursement',
        '    class IncompleteReimbursementError < StandardError; end',
        '',
        '    state_machine :reimbursement_status, initial: :pending do',
        '      event :errored do',
        '        transition from: :pending, to: :errored',
        '      end',
        '    end',
        '  end',
        'end',
      ].join('\n');

      const analysis = analyzer.parseRubySource(source, 'app/models/spree/reimbursement.rb');
      const reimbursement = analysis.classes.find(item => item.name === 'Reimbursement');
      const inlineError = analysis.classes.find(item => item.name === 'IncompleteReimbursementError');
      expect(inlineError).toBeDefined();
      expect(inlineError!.stateMachines).toHaveLength(0);
      expect(reimbursement!.stateMachines).toHaveLength(1);
      expect(reimbursement!.stateMachines[0].attribute).toBe('reimbursement_status');
    });
  });
});
