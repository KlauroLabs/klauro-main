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
});
