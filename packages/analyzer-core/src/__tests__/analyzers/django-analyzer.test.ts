jest.unmock('fs-extra');
jest.unmock('fs');
jest.unmock('glob');

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { DjangoAnalyzer } from '../../analyzer/frameworks/web/django-analyzer';

describe('DjangoAnalyzer', () => {
  let analyzer: DjangoAnalyzer;

  beforeEach(() => {
    analyzer = new DjangoAnalyzer();
  });

  describe('extractModelAccesses', () => {
    const imports = 'from accounts.models import Customer, Invoice, Payment\n';

    it('classifies manager reads and writes', () => {
      const scope = [
        'def handler(request):',
        '    customers = Customer.objects.filter(active=True)',
        '    invoice = Invoice.objects.create(total=10)',
        '    return customers, invoice',
      ].join('\n');

      const accesses = analyzer.extractModelAccesses(scope, imports + scope);

      expect(accesses).toContainEqual({ model: 'Customer', access: 'reads' });
      expect(accesses).toContainEqual({ model: 'Invoice', access: 'creates' });
    });

    it('detects chained queryset writes', () => {
      const scope = 'Payment.objects.filter(status="open").update(status="paid")';

      const accesses = analyzer.extractModelAccesses(scope, imports + scope);

      expect(accesses).toContainEqual({ model: 'Payment', access: 'updates' });
    });

    it('detects model construction followed by save', () => {
      const scope = [
        'def handler(request):',
        '    customer = Customer(name="a")',
        '    customer.save()',
      ].join('\n');

      const accesses = analyzer.extractModelAccesses(scope, imports + scope);

      expect(accesses).toContainEqual({ model: 'Customer', access: 'creates' });
    });

    it('resolves models defined in the same file without imports', () => {
      const full = [
        'from django.db import models',
        '',
        'class Order(models.Model):',
        '    total = models.DecimalField()',
        '',
        'def handler(request):',
        '    return Order.objects.all()',
      ].join('\n');
      const scope = 'def handler(request):\n    return Order.objects.all()';

      const accesses = analyzer.extractModelAccesses(scope, full);

      expect(accesses).toContainEqual({ model: 'Order', access: 'reads' });
    });

    it('ignores save calls on classes that are not models', () => {
      const full = 'from rest_framework import serializers\n\nserializer = CustomerSerializer(data={})\nserializer.save()';

      const accesses = analyzer.extractModelAccesses(full, full);

      expect(accesses).toEqual([]);
    });
  });

  describe('isSensitiveModelField', () => {
    it('flags sensitive field names', () => {
      expect(analyzer.isSensitiveModelField('password_hash', 'CharField')).toBe(true);
      expect(analyzer.isSensitiveModelField('email', 'CharField')).toBe(true);
      expect(analyzer.isSensitiveModelField('phone_number', 'CharField')).toBe(true);
      expect(analyzer.isSensitiveModelField('ssn', 'CharField')).toBe(true);
      expect(analyzer.isSensitiveModelField('date_of_birth', 'DateField')).toBe(true);
      expect(analyzer.isSensitiveModelField('card_number', 'CharField')).toBe(true);
      expect(analyzer.isSensitiveModelField('api_token', 'CharField')).toBe(true);
    });

    it('flags sensitive field types', () => {
      expect(analyzer.isSensitiveModelField('contact', 'EmailField')).toBe(true);
    });

    it('does not flag ordinary fields', () => {
      expect(analyzer.isSensitiveModelField('title', 'CharField')).toBe(false);
      expect(analyzer.isSensitiveModelField('created_at', 'DateTimeField')).toBe(false);
      expect(analyzer.isSensitiveModelField('cardinality', 'IntegerField')).toBe(false);
    });
  });

  describe('analyze entity access and sensitivity', () => {
    let projectPath: string;

    beforeEach(async () => {
      projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'django-analyzer-test-'));
      await fs.writeFile(path.join(projectPath, 'requirements.txt'), 'Django==4.2\n');
      await fs.writeFile(path.join(projectPath, 'manage.py'), '');
      await fs.ensureDir(path.join(projectPath, 'myproj'));
      await fs.writeFile(
        path.join(projectPath, 'myproj', 'settings.py'),
        "INSTALLED_APPS = [\n    'django.contrib.auth',\n    'accounts',\n]\nDEBUG = True\n"
      );
      await fs.ensureDir(path.join(projectPath, 'accounts'));
      await fs.writeFile(path.join(projectPath, 'accounts', '__init__.py'), '');
      await fs.writeFile(
        path.join(projectPath, 'accounts', 'models.py'),
        [
          'from django.db import models',
          '',
          'class Customer(models.Model):',
          '    name = models.CharField(max_length=100)',
          '    email = models.EmailField()',
          '    password_hash = models.CharField(max_length=128)',
          '',
        ].join('\n')
      );
      await fs.writeFile(
        path.join(projectPath, 'accounts', 'views.py'),
        [
          'from accounts.models import Customer',
          '',
          'def create_customer(request):',
          '    customer = Customer.objects.create(name=request.POST["name"])',
          '    return customer',
          '',
          'def list_customers(request):',
          '    return Customer.objects.filter(name__icontains="a")',
          '',
        ].join('\n')
      );
    });

    afterEach(async () => {
      await fs.remove(projectPath);
    });

    it('emits field nodes with sensitive flags and typed entity access edges', async () => {
      const contribution = await analyzer.analyze({ projectPath });
      const nodes = contribution.nodes || [];
      const edges = contribution.edges || [];

      const modelNode = nodes.find(n => n.type === 'model' && n.name === 'Customer');
      expect(modelNode).toBeDefined();

      const fieldNodes = nodes.filter(n => n.type === 'field' && n.parent === modelNode!.id);
      expect(fieldNodes.map(n => n.name).sort()).toEqual(['email', 'name', 'password_hash']);

      const sensitiveByName = new Map(
        fieldNodes.map(n => [n.name, (n.metadata?.attributes as Record<string, unknown>)?.sensitive])
      );
      expect(sensitiveByName.get('email')).toBe(true);
      expect(sensitiveByName.get('password_hash')).toBe(true);
      expect(sensitiveByName.get('name')).toBe(false);

      const writeEdge = edges.find(e =>
        e.type === 'creates' && e.source.includes('create_customer') && e.target === modelNode!.id
      );
      expect(writeEdge).toBeDefined();

      const readEdge = edges.find(e =>
        e.type === 'reads' && e.source.includes('list_customers') && e.target === modelNode!.id
      );
      expect(readEdge).toBeDefined();
    });
  });
});
