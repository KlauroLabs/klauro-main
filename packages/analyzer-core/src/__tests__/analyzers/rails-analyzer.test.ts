jest.unmock('fs-extra');
jest.unmock('fs');
jest.unmock('glob');

import { RailsAnalyzer } from '../../analyzer/frameworks/web/rails-analyzer';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';

describe('RailsAnalyzer', () => {
  let analyzer: RailsAnalyzer;

  beforeEach(() => {
    analyzer = new RailsAnalyzer();
  });

  describe('extractModel', () => {
    it('extracts ActiveRecord associations, validations, scopes, and callbacks', () => {
      const source = [
        'class WorkOrder < ApplicationRecord',
        '  belongs_to :customer',
        '  has_many :comments, dependent: :destroy',
        '  has_one :invoice, class_name: "Billing::Invoice"',
        '  has_and_belongs_to_many :technicians',
        '',
        '  validates :title, presence: true',
        '  scope :open_orders, -> { where.not(status: "completed") }',
        '  before_save :normalize_title',
        'end',
      ].join('\n');

      const model = analyzer.extractModel(source, 'app/models/work_order.rb');

      expect(model).not.toBeNull();
      expect(model!.name).toBe('WorkOrder');
      expect(model!.tableName).toBe('work_orders');
      expect(model!.associations).toEqual([
        expect.objectContaining({ type: 'belongs_to', name: 'customer', className: 'Customer' }),
        expect.objectContaining({ type: 'has_many', name: 'comments', className: 'Comment' }),
        expect.objectContaining({ type: 'has_one', name: 'invoice', className: 'Invoice' }),
        expect.objectContaining({ type: 'has_and_belongs_to_many', name: 'technicians', className: 'Technician' }),
      ]);
      expect(model!.validations).toBe(1);
      expect(model!.scopes).toEqual(['open_orders']);
      expect(model!.callbacks).toEqual(['before_save']);
    });

    it('returns null for non ActiveRecord classes', () => {
      const source = 'class PlainService\nend\n';
      expect(analyzer.extractModel(source, 'app/services/plain_service.rb')).toBeNull();
    });
  });

  describe('extractModels', () => {
    it('recognizes STI subclasses across files and carries the root table', () => {
      const models = analyzer.extractModels([
        { file: 'app/models/time_off.rb', content: 'class TimeOff < Event\nend\n' },
        { file: 'app/models/event.rb', content: 'class Event < ApplicationRecord\nend\n' },
        { file: 'app/models/paid_time_off.rb', content: 'class PaidTimeOff < TimeOff\nend\n' },
      ]);

      const event = models.find(model => model.name === 'Event');
      const timeOff = models.find(model => model.name === 'TimeOff');
      const paidTimeOff = models.find(model => model.name === 'PaidTimeOff');

      expect(event!.tableName).toBe('events');
      expect(event!.stiParent).toBeUndefined();
      expect(timeOff).toEqual(expect.objectContaining({ tableName: 'events', stiParent: 'Event' }));
      expect(paidTimeOff).toEqual(expect.objectContaining({ tableName: 'events', stiParent: 'TimeOff' }));
    });

    it('respects table_name overrides on subclasses', () => {
      const models = analyzer.extractModels([
        { file: 'app/models/event.rb', content: 'class Event < ApplicationRecord\nend\n' },
        { file: 'app/models/audit_event.rb', content: "class AuditEvent < Event\n  self.table_name = 'audit_events'\nend\n" },
      ]);

      const auditEvent = models.find(model => model.name === 'AuditEvent');
      expect(auditEvent).toEqual(expect.objectContaining({ tableName: 'audit_events', stiParent: 'Event' }));
    });

    it('gives subclasses of abstract base classes their own table without STI parent', () => {
      const models = analyzer.extractModels([
        { file: 'app/models/legacy_record.rb', content: 'class LegacyRecord < ActiveRecord::Base\n  self.abstract_class = true\nend\n' },
        { file: 'app/models/invoice.rb', content: 'class Invoice < LegacyRecord\nend\n' },
      ]);

      const invoice = models.find(model => model.name === 'Invoice');
      expect(invoice!.tableName).toBe('invoices');
      expect(invoice!.stiParent).toBeUndefined();
    });

    it('marks a primary_abstract_class base (Rails 7.1+ ApplicationRecord idiom) as abstract (rung-5 washup: ApplicationRecord surfaced as a domain ENTITY)', () => {
      const models = analyzer.extractModels([
        // The exact generated shape in washup's app/models/application_record.rb.
        { file: 'app/models/application_record.rb', content: 'class ApplicationRecord < ActiveRecord::Base\n  primary_abstract_class\nend\n' },
        { file: 'app/models/user.rb', content: 'class User < ApplicationRecord\nend\n' },
      ]);

      const base = models.find(model => model.name === 'ApplicationRecord');
      const user = models.find(model => model.name === 'User');
      expect(base!.abstract).toBe(true);
      expect(user!.abstract).toBe(false);
      expect(user!.tableName).toBe('users');
    });

    it('does not treat plain service classes as models', () => {
      const models = analyzer.extractModels([
        { file: 'app/models/event.rb', content: 'class Event < ApplicationRecord\nend\n' },
        { file: 'app/models/event_summary.rb', content: 'class EventSummary < BasePresenter\nend\n' },
      ]);

      expect(models.map(model => model.name)).toEqual(['Event']);
    });

    it('resolves a bare Base superclass to the nearest namespace, not a distant AR Base', () => {
      const models = analyzer.extractModels([
        { file: 'core/app/models/spree/base.rb', content: 'class Spree::Base < ApplicationRecord\n  self.abstract_class = true\nend\n' },
        { file: 'core/app/models/spree/order.rb', content: 'module Spree\n  class Order < Spree.base_class\n  end\nend\n' },
        { file: 'core/app/models/spree/permission_sets/base.rb', content: 'module Spree\n  module PermissionSets\n    class Base\n    end\n  end\nend\n' },
        { file: 'core/app/models/spree/permission_sets/product_management.rb', content: 'module Spree\n  module PermissionSets\n    class ProductManagement < Base\n    end\n  end\nend\n' },
      ]);

      const names = models.map(model => model.name).sort();
      expect(names).toEqual(['Base', 'Order']);
      const order = models.find(model => model.name === 'Order');
      expect(order!.tableName).toBe('orders');
      expect(order!.stiParent).toBeUndefined();
    });

    it('does not promote classes whose qualified parent is a plain class with a colliding Base name', () => {
      const models = analyzer.extractModels([
        { file: 'core/app/models/spree/base.rb', content: 'class Spree::Base < ApplicationRecord\n  self.abstract_class = true\nend\n' },
        { file: 'core/app/models/spree/stock/splitter/base.rb', content: 'module Spree\n  module Stock\n    module Splitter\n      class Base\n      end\n    end\n  end\nend\n' },
        { file: 'core/app/models/spree/stock/splitter/backordered.rb', content: 'module Spree\n  module Stock\n    module Splitter\n      class Backordered < Spree::Stock::Splitter::Base\n      end\n    end\n  end\nend\n' },
        { file: 'core/app/models/spree/search_provider/base.rb', content: 'module Spree\n  module SearchProvider\n    class Base\n    end\n  end\nend\n' },
        { file: 'core/app/models/spree/search_provider/database.rb', content: 'module Spree\n  module SearchProvider\n    class Database < Base\n    end\n  end\nend\n' },
      ]);

      expect(models.map(model => model.name)).toEqual(['Base']);
    });

    it('still resolves STI through multiple passes when intermediate parents resolve late', () => {
      const models = analyzer.extractModels([
        { file: 'core/app/models/spree/calculator/flat_rate.rb', content: 'module Spree\n  class Calculator::FlatRate < Calculator\n  end\nend\n' },
        { file: 'core/app/models/spree/calculator.rb', content: 'module Spree\n  class Calculator < Spree.base_class\n  end\nend\n' },
        { file: 'core/app/models/spree/base.rb', content: 'class Spree::Base < ApplicationRecord\n  self.abstract_class = true\nend\n' },
      ]);

      const flatRate = models.find(model => model.name === 'FlatRate');
      expect(flatRate).toBeDefined();
      expect(flatRate!.stiParent).toBe('Calculator');
      expect(flatRate!.tableName).toBe('calculators');
    });
  });

  describe('extractModelAccesses', () => {
    it('classifies class-level creates, updates, deletes, and reads', () => {
      const scope = [
        'def create',
        '  WorkOrder.create!(work_order_params)',
        '  Customer.find_by(email: params[:email])',
        '  Invoice.update(params[:id], status: "paid")',
        '  Comment.destroy_all',
        'end',
      ].join('\n');

      const accesses = analyzer.extractModelAccesses(scope);

      expect(accesses).toContainEqual({ model: 'WorkOrder', access: 'creates' });
      expect(accesses).toContainEqual({ model: 'Customer', access: 'reads' });
      expect(accesses).toContainEqual({ model: 'Invoice', access: 'updates' });
      expect(accesses).toContainEqual({ model: 'Comment', access: 'deletes' });
    });

    it('detects new followed by save as a create in a non-resourceful action', () => {
      const scope = [
        'def create',
        '  work_order = WorkOrder.new(import_params)',
        '  work_order.save!',
        'end',
      ].join('\n');

      const accesses = analyzer.extractModelAccesses(scope);

      expect(accesses).toContainEqual({ model: 'WorkOrder', access: 'creates' });
    });

    it('detects chained scope writes as updates or deletes', () => {
      const scope = [
        'WorkOrder.where(status: "stale").update_all(status: "archived")',
        'Invoice.where(paid: false).delete_all',
      ].join('\n');

      const accesses = analyzer.extractModelAccesses(scope);

      expect(accesses).toContainEqual({ model: 'WorkOrder', access: 'updates' });
      expect(accesses).toContainEqual({ model: 'WorkOrder', access: 'reads' });
      expect(accesses).toContainEqual({ model: 'Invoice', access: 'deletes' });
    });

    it('detects instance writes on fetched records', () => {
      const scope = [
        'def update',
        '  @work_order = WorkOrder.find(params[:id])',
        '  @work_order.update!(work_order_params)',
        'end',
      ].join('\n');

      const accesses = analyzer.extractModelAccesses(scope);

      expect(accesses).toContainEqual({ model: 'WorkOrder', access: 'reads' });
      expect(accesses).toContainEqual({ model: 'WorkOrder', access: 'updates' });
    });

    it('resolves association chain writes to the associated model', () => {
      const scope = 'current_customer.work_orders.create!(work_order_params)';

      const accesses = analyzer.extractModelAccesses(scope);

      expect(accesses).toContainEqual({ model: 'WorkOrder', access: 'creates' });
    });

    it('detects association build followed by save as a create', () => {
      const scope = [
        'def create',
        '  @time_off = current_user.time_offs.new(time_off_params)',
        '  @time_off.status = :approved',
        '  if @time_off.save',
        '  end',
        'end',
      ].join('\n');

      const accesses = analyzer.extractModelAccesses(scope);

      expect(accesses).toContainEqual({ model: 'TimeOff', access: 'creates' });
    });

    it('does not classify non-model PascalCase calls', () => {
      const scope = [
        'def create',
        '  payload = JSON.parse(request.body.read)',
        '  time = Time.zone.now',
        '  uri = URI.parse(params[:url])',
        'end',
      ].join('\n');

      expect(analyzer.extractModelAccesses(scope)).toEqual([]);
    });
  });

  describe('extractController', () => {
    it('extracts public actions and before_action filters', () => {
      const source = [
        'class WorkOrdersController < ApplicationController',
        '  before_action :require_auth',
        '  before_action :set_work_order, only: [:show, :destroy]',
        '',
        '  def index',
        '  end',
        '',
        '  def create',
        '  end',
        '',
        '  private',
        '',
        '  def require_auth',
        '  end',
        '',
        '  def set_work_order',
        '  end',
        'end',
      ].join('\n');

      const controller = analyzer.extractController(source, 'app/controllers/work_orders_controller.rb');

      expect(controller).not.toBeNull();
      expect(controller!.name).toBe('WorkOrdersController');
      expect(controller!.controllerPath).toBe('work_orders');
      expect(controller!.actions.map(action => action.name)).toEqual(['index', 'create']);
      expect(controller!.beforeActions).toEqual([
        expect.objectContaining({ name: 'require_auth', only: [], except: [] }),
        expect.objectContaining({ name: 'set_work_order', only: ['show', 'destroy'] }),
      ]);
    });
  });

  describe('extractRoutes', () => {
    it('expands resources with only restriction into RESTful routes', () => {
      const source = [
        'Rails.application.routes.draw do',
        '  resources :work_orders, only: [:index, :create]',
        'end',
      ].join('\n');

      const routes = analyzer.extractRoutes(source);

      expect(routes).toEqual([
        expect.objectContaining({ method: 'GET', path: '/work_orders', controller: 'work_orders', action: 'index' }),
        expect.objectContaining({ method: 'POST', path: '/work_orders', controller: 'work_orders', action: 'create' }),
      ]);
    });

    it('parses verb routes, root, and namespaces', () => {
      const source = [
        'Rails.application.routes.draw do',
        "  root 'dashboard#show'",
        "  get 'health', to: 'status#health'",
        "  post 'webhooks/stripe' => 'webhooks#stripe'",
        '  namespace :admin do',
        '    resources :users, only: [:index]',
        '  end',
        'end',
      ].join('\n');

      const routes = analyzer.extractRoutes(source);

      expect(routes).toEqual([
        expect.objectContaining({ method: 'GET', path: '/', controller: 'dashboard', action: 'show' }),
        expect.objectContaining({ method: 'GET', path: '/health', controller: 'status', action: 'health' }),
        expect.objectContaining({ method: 'POST', path: '/webhooks/stripe', controller: 'webhooks', action: 'stripe' }),
        expect.objectContaining({ method: 'GET', path: '/admin/users', controller: 'admin/users', action: 'index' }),
      ]);
    });

    it('applies independent scope paths and controller modules', () => {
      const source = [
        'Rails.application.routes.draw do',
        '  scope "rails/conductor/action_mailbox/", module: "rails/conductor/action_mailbox" do',
        '    resources :inbound_emails, only: %i[index new show create]',
        '  end',
        '  scope path: "/api", module: :internal do',
        "    get 'health', to: 'status#show'",
        '  end',
        'end',
      ].join('\n');

      const routes = analyzer.extractRoutes(source);

      expect(routes).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: '/rails/conductor/action_mailbox/inbound_emails', controller: 'rails/conductor/action_mailbox/inbound_emails', action: 'index' }),
        expect.objectContaining({ path: '/rails/conductor/action_mailbox/inbound_emails/new', controller: 'rails/conductor/action_mailbox/inbound_emails', action: 'new' }),
        expect.objectContaining({ path: '/api/health', controller: 'internal/status', action: 'show' }),
      ]));
    });

    it('expands full resources into seven actions plus PUT alias', () => {
      const routes = analyzer.extractRoutes('resources :customers\n');
      expect(routes.map(route => `${route.method} ${route.path}`)).toEqual([
        'GET /customers',
        'POST /customers',
        'GET /customers/new',
        'GET /customers/:id/edit',
        'GET /customers/:id',
        'PATCH /customers/:id',
        'PUT /customers/:id',
        'DELETE /customers/:id',
      ]);
    });
  });

  describe('extractMigration', () => {
    it('extracts created table and columns', () => {
      const source = [
        'class CreateWorkOrders < ActiveRecord::Migration[7.1]',
        '  def change',
        '    create_table :work_orders do |t|',
        '      t.string :title, null: false',
        '      t.string :status',
        '      t.references :customer, null: false, foreign_key: true',
        '      t.timestamps',
        '    end',
        '  end',
        'end',
      ].join('\n');

      const migration = analyzer.extractMigration(source, 'db/migrate/20260101000000_create_work_orders.rb');

      expect(migration).not.toBeNull();
      expect(migration!.name).toBe('CreateWorkOrders');
      expect(migration!.table).toBe('work_orders');
      expect(migration!.action).toBe('create');
      expect(migration!.columns).toEqual([
        { name: 'title', type: 'string' },
        { name: 'status', type: 'string' },
        { name: 'customer_id', type: 'references' },
      ]);
    });
  });

  describe('extractWorker', () => {
    it('extracts ActiveJob jobs with queue', () => {
      const source = [
        'class SyncInvoicesJob < ApplicationJob',
        '  queue_as :billing',
        '',
        '  def perform(invoice_id)',
        '  end',
        'end',
      ].join('\n');

      const worker = analyzer.extractWorker(source, 'app/jobs/sync_invoices_job.rb');

      expect(worker).toEqual(expect.objectContaining({
        name: 'SyncInvoicesJob',
        kind: 'job',
        queue: 'billing',
        methods: ['perform'],
      }));
    });

    it('extracts mailers', () => {
      const source = [
        'class CustomerMailer < ApplicationMailer',
        '  def welcome(customer)',
        '  end',
        'end',
      ].join('\n');

      const worker = analyzer.extractWorker(source, 'app/mailers/customer_mailer.rb');
      expect(worker).toEqual(expect.objectContaining({ name: 'CustomerMailer', kind: 'mailer', methods: ['welcome'] }));
    });
  });

  describe('extractTestSuite', () => {
    it('extracts RSpec suites with subject and example count', () => {
      const source = [
        "require 'rails_helper'",
        '',
        'RSpec.describe WorkOrdersController, type: :controller do',
        "  it 'returns work orders' do",
        '  end',
        '',
        "  it 'creates work orders' do",
        '  end',
        'end',
      ].join('\n');

      const suite = analyzer.extractTestSuite(source, 'spec/work_orders_controller_spec.rb');

      expect(suite).toEqual(expect.objectContaining({
        name: 'WorkOrdersController',
        framework: 'rspec',
        subject: 'WorkOrdersController',
        examples: 2,
      }));
    });

    it('extracts minitest suites', () => {
      const source = [
        'class WorkOrderTest < ActiveSupport::TestCase',
        "  test 'is valid' do",
        '  end',
        'end',
      ].join('\n');

      const suite = analyzer.extractTestSuite(source, 'test/models/work_order_test.rb');
      expect(suite).toEqual(expect.objectContaining({
        name: 'WorkOrderTest',
        framework: 'minitest',
        subject: 'WorkOrder',
        examples: 1,
      }));
    });
  });

  describe('isSensitiveModelField', () => {
    it('flags sensitive column names and digest types', () => {
      expect(analyzer.isSensitiveModelField('email', 'string')).toBe(true);
      expect(analyzer.isSensitiveModelField('phone_number', 'string')).toBe(true);
      expect(analyzer.isSensitiveModelField('encrypted_password', 'string')).toBe(true);
      expect(analyzer.isSensitiveModelField('password', 'digest')).toBe(true);
      expect(analyzer.isSensitiveModelField('title', 'string')).toBe(false);
      expect(analyzer.isSensitiveModelField('status', 'string')).toBe(false);
    });
  });

  describe('analyze code-level model access edges', () => {
    let projectPath: string;

    beforeEach(async () => {
      projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'rails-analyzer-access-test-'));
      await fs.writeFile(path.join(projectPath, 'Gemfile'), "source 'https://rubygems.org'\ngem 'rails', '~> 7.1'\n");
      await fs.ensureDir(path.join(projectPath, 'config'));
      await fs.writeFile(
        path.join(projectPath, 'config', 'routes.rb'),
        [
          'Rails.application.routes.draw do',
          "  post 'bulk_imports' => 'bulk_imports#create'",
          'end',
          '',
        ].join('\n')
      );
      await fs.ensureDir(path.join(projectPath, 'app', 'models'));
      await fs.writeFile(
        path.join(projectPath, 'app', 'models', 'work_order.rb'),
        'class WorkOrder < ApplicationRecord\nend\n'
      );
      await fs.ensureDir(path.join(projectPath, 'app', 'controllers'));
      await fs.writeFile(
        path.join(projectPath, 'app', 'controllers', 'bulk_imports_controller.rb'),
        [
          'class BulkImportsController < ApplicationController',
          '  def create',
          '    payload = JSON.parse(request.body.read)',
          '    work_order = WorkOrder.new(payload)',
          '    work_order.save!',
          '    head :created',
          '  end',
          '',
          '  def index',
          '    @work_orders = WorkOrder.where(imported: true).order(:created_at)',
          '  end',
          'end',
          '',
        ].join('\n')
      );
      await fs.ensureDir(path.join(projectPath, 'app', 'jobs'));
      await fs.writeFile(
        path.join(projectPath, 'app', 'jobs', 'purge_stale_orders_job.rb'),
        [
          'class PurgeStaleOrdersJob < ApplicationJob',
          '  def perform',
          '    WorkOrder.where(status: "stale").delete_all',
          '  end',
          'end',
          '',
        ].join('\n')
      );
    });

    afterEach(async () => {
      await fs.remove(projectPath);
    });

    it('links non-resourceful controller actions and jobs to models with typed access edges', async () => {
      const contribution = await analyzer.analyze({ projectPath } as any);
      const nodes = contribution.nodes || [];
      const edges = contribution.edges || [];

      const model = nodes.find(n => n.type === 'rails_model' && n.name === 'WorkOrder');
      expect(model).toBeDefined();

      const conventionEdge = edges.find(e => e.type === 'uses' && e.target === model!.id);
      expect(conventionEdge).toBeUndefined();

      const createEdge = edges.find(e =>
        e.type === 'creates' && e.source.includes('BulkImportsController_create') && e.target === model!.id
      );
      expect(createEdge).toBeDefined();

      const readEdge = edges.find(e =>
        e.type === 'reads' && e.source.includes('BulkImportsController_index') && e.target === model!.id
      );
      expect(readEdge).toBeDefined();

      const jobNode = nodes.find(n => n.type === 'rails_job' && n.name === 'PurgeStaleOrdersJob');
      expect(jobNode).toBeDefined();
      const deleteEdge = edges.find(e =>
        e.type === 'deletes' && e.source === jobNode!.id && e.target === model!.id
      );
      expect(deleteEdge).toBeDefined();

      const nonModelEdges = edges.filter(e => ['creates', 'reads', 'updates', 'deletes'].includes(e.type) && e.target !== model!.id);
      expect(nonModelEdges).toEqual([]);
    });
  });

  describe('analyze STI subclass models', () => {
    let projectPath: string;

    beforeEach(async () => {
      projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'rails-analyzer-sti-test-'));
      await fs.writeFile(path.join(projectPath, 'Gemfile'), "source 'https://rubygems.org'\ngem 'rails', '~> 7.1'\n");
      await fs.ensureDir(path.join(projectPath, 'config'));
      await fs.writeFile(
        path.join(projectPath, 'config', 'routes.rb'),
        [
          'Rails.application.routes.draw do',
          '  resources :my_time_offs, only: [:create]',
          'end',
          '',
        ].join('\n')
      );
      await fs.ensureDir(path.join(projectPath, 'app', 'models'));
      await fs.writeFile(
        path.join(projectPath, 'app', 'models', 'event.rb'),
        'class Event < ApplicationRecord\nend\n'
      );
      await fs.writeFile(
        path.join(projectPath, 'app', 'models', 'time_off.rb'),
        'class TimeOff < Event\nend\n'
      );
      await fs.writeFile(
        path.join(projectPath, 'app', 'models', 'paid_time_off.rb'),
        'class PaidTimeOff < TimeOff\nend\n'
      );
      await fs.ensureDir(path.join(projectPath, 'app', 'controllers'));
      await fs.writeFile(
        path.join(projectPath, 'app', 'controllers', 'my_time_offs_controller.rb'),
        [
          'class MyTimeOffsController < ApplicationController',
          '  def create',
          '    time_off = TimeOff.new(time_off_params)',
          '    time_off.save!',
          '    head :created',
          '  end',
          'end',
          '',
        ].join('\n')
      );
      await fs.ensureDir(path.join(projectPath, 'db'));
      await fs.writeFile(
        path.join(projectPath, 'db', 'schema.rb'),
        [
          'ActiveRecord::Schema[7.1].define(version: 2026_01_01_000000) do',
          '  create_table "events", force: :cascade do |t|',
          '    t.string "type"',
          '    t.string "employee_email"',
          '    t.date "starts_on"',
          '  end',
          'end',
          '',
        ].join('\n')
      );
    });

    afterEach(async () => {
      await fs.remove(projectPath);
    });

    it('emits model nodes for STI subclasses with the parent table and sti_parent metadata', async () => {
      const contribution = await analyzer.analyze({ projectPath } as any);
      const nodes = contribution.nodes || [];

      const timeOff = nodes.find(n => n.type === 'rails_model' && n.name === 'TimeOff');
      const paidTimeOff = nodes.find(n => n.type === 'rails_model' && n.name === 'PaidTimeOff');
      expect(timeOff).toBeDefined();
      expect(paidTimeOff).toBeDefined();

      const timeOffAttributes = timeOff!.metadata?.attributes as Record<string, unknown>;
      expect(timeOffAttributes.table).toBe('events');
      expect(timeOffAttributes.sti_parent).toBe('Event');

      const paidTimeOffAttributes = paidTimeOff!.metadata?.attributes as Record<string, unknown>;
      expect(paidTimeOffAttributes.table).toBe('events');
      expect(paidTimeOffAttributes.sti_parent).toBe('TimeOff');
    });

    it('links controller writes to the STI subclass model node', async () => {
      const contribution = await analyzer.analyze({ projectPath } as any);
      const nodes = contribution.nodes || [];
      const edges = contribution.edges || [];

      const timeOff = nodes.find(n => n.type === 'rails_model' && n.name === 'TimeOff');
      expect(timeOff).toBeDefined();

      const createEdge = edges.find(e =>
        e.type === 'creates' && e.source.includes('MyTimeOffsController_create') && e.target === timeOff!.id
      );
      expect(createEdge).toBeDefined();
    });

    it('gives STI subclasses field nodes for the shared parent table so sensitive lineage stays reachable through the subclass', async () => {
      const contribution = await analyzer.analyze({ projectPath } as any);
      const nodes = contribution.nodes || [];
      const edges = contribution.edges || [];

      const timeOff = nodes.find(n => n.type === 'rails_model' && n.name === 'TimeOff');
      const timeOffFields = nodes.filter(n => n.type === 'field' && n.parent === timeOff!.id);
      expect(timeOffFields.map(n => n.name).sort()).toEqual(['employee_email', 'starts_on', 'type']);

      const emailField = timeOffFields.find(n => n.name === 'employee_email');
      const emailAttributes = emailField!.metadata?.attributes as Record<string, unknown>;
      expect(emailAttributes.sensitive).toBe(true);
      expect(emailAttributes.table).toBe('events');

      const fieldEdge = edges.find(e =>
        e.type === 'has_field' && e.source === timeOff!.id && e.target === emailField!.id
      );
      expect(fieldEdge).toBeDefined();
    });
  });

  describe('analyze model fields from migrations and schema', () => {
    let projectPath: string;

    beforeEach(async () => {
      projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'rails-analyzer-test-'));
      await fs.writeFile(path.join(projectPath, 'Gemfile'), "source 'https://rubygems.org'\ngem 'rails', '~> 7.1'\n");
      await fs.ensureDir(path.join(projectPath, 'config'));
      await fs.writeFile(
        path.join(projectPath, 'config', 'routes.rb'),
        [
          'Rails.application.routes.draw do',
          '  resources :work_orders, only: [:index, :show, :create, :update, :destroy]',
          'end',
          '',
        ].join('\n')
      );
      await fs.ensureDir(path.join(projectPath, 'app', 'models'));
      await fs.writeFile(
        path.join(projectPath, 'app', 'models', 'work_order.rb'),
        [
          'class WorkOrder < ApplicationRecord',
          '  belongs_to :customer',
          'end',
          '',
        ].join('\n')
      );
      await fs.writeFile(
        path.join(projectPath, 'app', 'models', 'customer.rb'),
        [
          'class Customer < ApplicationRecord',
          '  has_many :work_orders',
          'end',
          '',
        ].join('\n')
      );
      await fs.ensureDir(path.join(projectPath, 'db', 'migrate'));
      await fs.writeFile(
        path.join(projectPath, 'db', 'migrate', '20260101000000_create_work_orders.rb'),
        [
          'class CreateWorkOrders < ActiveRecord::Migration[7.1]',
          '  def change',
          '    create_table :work_orders do |t|',
          '      t.string :title, null: false',
          '      t.string :status, null: false',
          '      t.references :customer, null: false',
          '      t.timestamps',
          '    end',
          '  end',
          'end',
          '',
        ].join('\n')
      );
      await fs.writeFile(
        path.join(projectPath, 'db', 'schema.rb'),
        [
          'ActiveRecord::Schema[7.1].define(version: 2026_01_01_000000) do',
          '  create_table "customers", force: :cascade do |t|',
          '    t.string "name", null: false',
          '    t.string "email", null: false',
          '    t.string "phone"',
          '    t.index ["email"], name: "index_customers_on_email", unique: true',
          '  end',
          'end',
          '',
        ].join('\n')
      );
    });

    afterEach(async () => {
      await fs.remove(projectPath);
    });

    it('emits field nodes with sensitivity flags and has_field edges for models', async () => {
      const contribution = await analyzer.analyze({ projectPath } as any);
      const nodes = contribution.nodes || [];
      const edges = contribution.edges || [];

      const workOrder = nodes.find(n => n.type === 'rails_model' && n.name === 'WorkOrder');
      const customer = nodes.find(n => n.type === 'rails_model' && n.name === 'Customer');
      expect(workOrder).toBeDefined();
      expect(customer).toBeDefined();

      const workOrderFields = nodes.filter(n => n.type === 'field' && n.parent === workOrder!.id);
      expect(workOrderFields.map(n => n.name).sort()).toEqual(['customer_id', 'status', 'title']);

      const customerFields = nodes.filter(n => n.type === 'field' && n.parent === customer!.id);
      expect(customerFields.map(n => n.name).sort()).toEqual(['email', 'name', 'phone']);

      const sensitiveByName = new Map(
        customerFields.map(n => [n.name, (n.metadata?.attributes as Record<string, unknown>)?.sensitive])
      );
      expect(sensitiveByName.get('email')).toBe(true);
      expect(sensitiveByName.get('phone')).toBe(true);
      expect(sensitiveByName.get('name')).toBe(false);

      const fieldEdges = edges.filter(e => e.type === 'has_field' && e.source === customer!.id);
      expect(fieldEdges).toHaveLength(3);

      const association = edges.find(e =>
        e.type === 'relates_to' && e.source === workOrder!.id && e.target === customer!.id
      );
      expect(association).toBeDefined();
    });
  });

  describe('analyze engine monorepo with multiple Rails roots', () => {
    let projectPath: string;

    beforeEach(async () => {
      projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'rails-analyzer-engines-test-'));
      await fs.writeFile(path.join(projectPath, 'Gemfile'), "source 'https://rubygems.org'\ngemspec\n");

      await fs.ensureDir(path.join(projectPath, 'catalog', 'config'));
      await fs.writeFile(path.join(projectPath, 'catalog', 'catalog.gemspec'), "Gem::Specification.new do |s|\n  s.name = 'catalog'\nend\n");
      await fs.writeFile(
        path.join(projectPath, 'catalog', 'config', 'routes.rb'),
        [
          'Catalog::Engine.routes.draw do',
          '  resources :products, only: [:index, :show]',
          'end',
          '',
        ].join('\n')
      );
      await fs.ensureDir(path.join(projectPath, 'catalog', 'app', 'models', 'catalog'));
      await fs.writeFile(
        path.join(projectPath, 'catalog', 'app', 'models', 'catalog', 'base.rb'),
        [
          'class Catalog::Base < ApplicationRecord',
          '  self.abstract_class = true',
          'end',
          '',
        ].join('\n')
      );
      await fs.writeFile(
        path.join(projectPath, 'catalog', 'app', 'models', 'catalog', 'product.rb'),
        [
          'module Catalog',
          '  class Product < Catalog.base_class',
          '    has_many :invoices',
          '  end',
          'end',
          '',
        ].join('\n')
      );
      await fs.ensureDir(path.join(projectPath, 'catalog', 'app', 'controllers', 'catalog'));
      await fs.writeFile(
        path.join(projectPath, 'catalog', 'app', 'controllers', 'catalog', 'products_controller.rb'),
        [
          'module Catalog',
          '  class ProductsController < ApplicationController',
          '    def index',
          '      @products = Product.all',
          '    end',
          '',
          '    def show',
          '      @product = Product.find(params[:id])',
          '    end',
          '  end',
          'end',
          '',
        ].join('\n')
      );

      await fs.ensureDir(path.join(projectPath, 'billing', 'config'));
      await fs.writeFile(path.join(projectPath, 'billing', 'billing.gemspec'), "Gem::Specification.new do |s|\n  s.name = 'billing'\nend\n");
      await fs.writeFile(
        path.join(projectPath, 'billing', 'config', 'routes.rb'),
        [
          'Billing::Engine.routes.draw do',
          "  post 'invoices' => 'invoices#create'",
          'end',
          '',
        ].join('\n')
      );
      await fs.ensureDir(path.join(projectPath, 'billing', 'app', 'models', 'billing'));
      await fs.writeFile(
        path.join(projectPath, 'billing', 'app', 'models', 'billing', 'invoice.rb'),
        [
          'module Billing',
          '  class Invoice < ApplicationRecord',
          '    belongs_to :product',
          '  end',
          'end',
          '',
        ].join('\n')
      );
      await fs.ensureDir(path.join(projectPath, 'billing', 'app', 'controllers', 'billing'));
      await fs.writeFile(
        path.join(projectPath, 'billing', 'app', 'controllers', 'billing', 'invoices_controller.rb'),
        [
          'module Billing',
          '  class InvoicesController < ApplicationController',
          '    def create',
          '      invoice = Invoice.new(invoice_params)',
          '      invoice.save!',
          '    end',
          '  end',
          'end',
          '',
        ].join('\n')
      );
    });

    afterEach(async () => {
      await fs.remove(projectPath);
    });

    it('discovers every Rails root in the repo', async () => {
      const roots = await analyzer.discoverRailsRoots(projectPath);
      expect(roots).toEqual(['billing', 'catalog']);
      expect(await analyzer.canAnalyze(projectPath)).toBe(true);
    });

    it('surfaces models from all engines as entity-tagged rails_model nodes without id collisions', async () => {
      const contribution = await analyzer.analyze({ projectPath } as any);
      const nodes = contribution.nodes || [];

      const product = nodes.find(n => n.type === 'rails_model' && n.name === 'Product');
      const invoice = nodes.find(n => n.type === 'rails_model' && n.name === 'Invoice');
      expect(product).toBeDefined();
      expect(invoice).toBeDefined();
      expect(product!.subcategories).toContain('entity');
      expect(invoice!.subcategories).toContain('entity');
      expect(product!.source?.file).toContain(path.join('catalog', 'app', 'models'));
      expect(invoice!.source?.file).toContain(path.join('billing', 'app', 'models'));

      const ids = nodes.map(n => n.id);
      expect(new Set(ids).size).toBe(ids.length);

      const apps = nodes.filter(n => n.type === 'rails_app').map(n => n.name).sort();
      expect(apps).toEqual(['billing', 'catalog']);
    });

    it('turns routes from every engine routes file into HTTP entry points', async () => {
      const contribution = await analyzer.analyze({ projectPath } as any);
      const entryPoints = contribution.entry_points || [];
      const httpEntries = entryPoints.filter(e => e.type === 'http');

      const paths = httpEntries.map(e => `${e.trigger?.method} ${e.trigger?.path}`).sort();
      expect(paths).toEqual(['GET /products', 'GET /products/:id', 'POST /invoices']);

      const invoiceEntry = httpEntries.find(e => e.trigger?.path === '/invoices');
      expect(invoiceEntry!.handler?.file).toBe('billing/app/controllers/billing/invoices_controller.rb');
    });

    it('links cross-engine associations and code-level model access', async () => {
      const contribution = await analyzer.analyze({ projectPath } as any);
      const nodes = contribution.nodes || [];
      const edges = contribution.edges || [];

      const product = nodes.find(n => n.type === 'rails_model' && n.name === 'Product');
      const invoice = nodes.find(n => n.type === 'rails_model' && n.name === 'Invoice');

      const crossEngineAssociation = edges.find(e =>
        e.type === 'relates_to' && e.source === invoice!.id && e.target === product!.id
      );
      expect(crossEngineAssociation).toBeDefined();

      const createEdge = edges.find(e =>
        e.type === 'creates' && e.source.includes('InvoicesController_create') && e.target === invoice!.id
      );
      expect(createEdge).toBeDefined();
    });

    it('maps namespace-prefixed multi-table migrations to engine model fields', async () => {
      await fs.ensureDir(path.join(projectPath, 'catalog', 'db', 'migrate'));
      await fs.writeFile(
        path.join(projectPath, 'catalog', 'db', 'migrate', '20260101000000_catalog_schema.rb'),
        [
          'class CatalogSchema < ActiveRecord::Migration[7.1]',
          '  def change',
          '    create_table "catalog_products", force: :cascade do |t|',
          '      t.string :name',
          '      t.decimal :price',
          '    end',
          '    create_table "catalog_settings" do |t|',
          '      t.string :key',
          '    end',
          '    add_column :catalog_products, :sku, :string',
          '  end',
          'end',
          '',
        ].join('\n')
      );

      const contribution = await analyzer.analyze({ projectPath } as any);
      const nodes = contribution.nodes || [];
      const product = nodes.find(n => n.type === 'rails_model' && n.name === 'Product');
      const fields = nodes.filter(n => n.type === 'field' && n.parent === product!.id);
      expect(fields.map(n => n.name).sort()).toEqual(['name', 'price', 'sku']);
    });

    it('keeps the single-app layout working with one implicit root', async () => {
      const singleAppPath = await fs.mkdtemp(path.join(os.tmpdir(), 'rails-analyzer-single-test-'));
      try {
        await fs.writeFile(path.join(singleAppPath, 'Gemfile'), "source 'https://rubygems.org'\ngem 'rails', '~> 7.1'\n");
        await fs.ensureDir(path.join(singleAppPath, 'config'));
        await fs.writeFile(
          path.join(singleAppPath, 'config', 'routes.rb'),
          'Rails.application.routes.draw do\n  resources :widgets, only: [:index]\nend\n'
        );
        await fs.ensureDir(path.join(singleAppPath, 'app', 'models'));
        await fs.writeFile(path.join(singleAppPath, 'app', 'models', 'widget.rb'), 'class Widget < ApplicationRecord\nend\n');

        const roots = await analyzer.discoverRailsRoots(singleAppPath);
        expect(roots).toEqual(['']);

        const contribution = await analyzer.analyze({ projectPath: singleAppPath } as any);
        const nodes = contribution.nodes || [];
        expect(nodes.find(n => n.type === 'rails_model' && n.name === 'Widget')).toBeDefined();
        expect((contribution.entry_points || []).filter(e => e.type === 'http')).toHaveLength(1);
        const app = nodes.find(n => n.type === 'rails_app');
        expect(app!.name).toBe(path.basename(singleAppPath));
      } finally {
        await fs.remove(singleAppPath);
      }
    });
  });
});
