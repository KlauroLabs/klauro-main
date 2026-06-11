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

  describe('extractSerializerWrites', () => {
    it('classifies serializer save on new data as creates', () => {
      const scope = [
        'def post(self, request):',
        '    serializer = CustomerSerializer(data=request.data)',
        '    serializer.is_valid(raise_exception=True)',
        '    serializer.save()',
      ].join('\n');

      const writes = analyzer.extractSerializerWrites(scope);

      expect(writes).toEqual([{ serializer: 'CustomerSerializer', access: 'creates' }]);
    });

    it('classifies serializer save on an existing instance as updates', () => {
      const scope = [
        'def put(self, request, pk):',
        '    customer = self.get_object()',
        '    serializer = CustomerSerializer(customer, data=request.data, partial=True)',
        '    serializer.is_valid(raise_exception=True)',
        '    serializer.save()',
      ].join('\n');

      const writes = analyzer.extractSerializerWrites(scope);

      expect(writes).toEqual([{ serializer: 'CustomerSerializer', access: 'updates' }]);
    });

    it('classifies instance keyword argument as updates', () => {
      const scope = 'serializer = CustomerSerializer(instance=customer, data=request.data)\nserializer.save()';

      const writes = analyzer.extractSerializerWrites(scope);

      expect(writes).toEqual([{ serializer: 'CustomerSerializer', access: 'updates' }]);
    });

    it('ignores serializer instantiation without a save call', () => {
      const scope = 'serializer = CustomerSerializer(data=request.data)\nreturn Response(serializer.errors)';

      expect(analyzer.extractSerializerWrites(scope)).toEqual([]);
    });

    it('infers creates and updates from ModelViewSet serializer_class', () => {
      const writes = analyzer.extractSerializerWrites('serializer_class = CustomerSerializer', 'viewsets.ModelViewSet', 'CustomerSerializer');

      expect(writes).toContainEqual({ serializer: 'CustomerSerializer', access: 'creates' });
      expect(writes).toContainEqual({ serializer: 'CustomerSerializer', access: 'updates' });
    });

    it('infers only creates from CreateAPIView and only updates from UpdateAPIView', () => {
      expect(analyzer.extractSerializerWrites('', 'generics.CreateAPIView', 'CustomerSerializer'))
        .toEqual([{ serializer: 'CustomerSerializer', access: 'creates' }]);
      expect(analyzer.extractSerializerWrites('', 'generics.UpdateAPIView', 'CustomerSerializer'))
        .toEqual([{ serializer: 'CustomerSerializer', access: 'updates' }]);
    });

    it('does not infer persistence from ReadOnlyModelViewSet', () => {
      expect(analyzer.extractSerializerWrites('serializer_class = CustomerSerializer', 'viewsets.ReadOnlyModelViewSet', 'CustomerSerializer'))
        .toEqual([]);
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

  describe('analyze serializer-mediated writes', () => {
    let projectPath: string;

    beforeEach(async () => {
      projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'django-analyzer-drf-test-'));
      await fs.writeFile(path.join(projectPath, 'requirements.txt'), 'Django==4.2\ndjangorestframework==3.14\n');
      await fs.writeFile(path.join(projectPath, 'manage.py'), '');
      await fs.ensureDir(path.join(projectPath, 'myproj'));
      await fs.writeFile(
        path.join(projectPath, 'myproj', 'settings.py'),
        "INSTALLED_APPS = [\n    'django.contrib.auth',\n    'accounts',\n    'api',\n]\nDEBUG = True\n"
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
          '',
        ].join('\n')
      );
      await fs.ensureDir(path.join(projectPath, 'api'));
      await fs.writeFile(path.join(projectPath, 'api', '__init__.py'), '');
      await fs.writeFile(
        path.join(projectPath, 'api', 'serializers.py'),
        [
          'from rest_framework import serializers',
          'from accounts.models import Customer',
          '',
          'class CustomerSerializer(serializers.ModelSerializer):',
          '    class Meta:',
          '        model = Customer',
          '        fields = "__all__"',
          '',
          'class PingSerializer(serializers.Serializer):',
          '    message = serializers.CharField()',
          '',
        ].join('\n')
      );
      await fs.writeFile(
        path.join(projectPath, 'api', 'views.py'),
        [
          'from rest_framework import viewsets',
          'from rest_framework.views import APIView',
          'from api.serializers import CustomerSerializer, PingSerializer',
          '',
          'class CustomerCreateView(APIView):',
          '    def post(self, request):',
          '        serializer = CustomerSerializer(data=request.data)',
          '        serializer.is_valid(raise_exception=True)',
          '        serializer.save()',
          '        return None',
          '',
          'class CustomerUpdateView(APIView):',
          '    def put(self, request, pk):',
          '        customer = self.get_object()',
          '        serializer = CustomerSerializer(customer, data=request.data, partial=True)',
          '        serializer.is_valid(raise_exception=True)',
          '        serializer.save()',
          '        return None',
          '',
          'class CustomerViewSet(viewsets.ModelViewSet):',
          '    serializer_class = CustomerSerializer',
          '',
          'class PingView(APIView):',
          '    def post(self, request):',
          '        serializer = PingSerializer(data=request.data)',
          '        serializer.is_valid()',
          '        serializer.save()',
          '        return None',
          '',
        ].join('\n')
      );
    });

    afterEach(async () => {
      await fs.remove(projectPath);
    });

    it('emits typed write edges from views through serializers to models across apps', async () => {
      const contribution = await analyzer.analyze({ projectPath });
      const edges = contribution.edges || [];
      const nodes = contribution.nodes || [];

      const modelNode = nodes.find(n => n.type === 'model' && n.name === 'Customer');
      expect(modelNode).toBeDefined();

      const createEdge = edges.find(e =>
        e.type === 'creates' && e.source.includes('CustomerCreateView') && e.target === modelNode!.id
      );
      expect(createEdge).toBeDefined();
      expect(createEdge!.metadata?.attributes?.serializer ?? (createEdge!.metadata as any)?.serializer).toBeDefined();

      const updateEdge = edges.find(e =>
        e.type === 'updates' && e.source.includes('CustomerUpdateView') && e.target === modelNode!.id
      );
      expect(updateEdge).toBeDefined();

      const viewSetCreate = edges.find(e =>
        e.type === 'creates' && e.source.includes('CustomerViewSet') && e.target === modelNode!.id
      );
      const viewSetUpdate = edges.find(e =>
        e.type === 'updates' && e.source.includes('CustomerViewSet') && e.target === modelNode!.id
      );
      expect(viewSetCreate).toBeDefined();
      expect(viewSetUpdate).toBeDefined();

      const pingWrites = edges.filter(e =>
        (e.type === 'creates' || e.type === 'updates') && e.source.includes('PingView')
      );
      expect(pingWrites).toEqual([]);
    });
  });

  describe('app discovery', () => {
    let projectPath: string;

    const writeProject = async (files: Record<string, string>) => {
      for (const [relativePath, content] of Object.entries(files)) {
        const fullPath = path.join(projectPath, relativePath);
        await fs.ensureDir(path.dirname(fullPath));
        await fs.writeFile(fullPath, content);
      }
    };

    const modelsSource = (modelName: string) => [
      'from django.db import models',
      '',
      `class ${modelName}(models.Model):`,
      '    name = models.CharField(max_length=100)',
      '',
    ].join('\n');

    const viewSource = (viewName: string, modelImport: string, modelName: string) => [
      modelImport,
      'from django.views import View',
      '',
      `class ${viewName}(View):`,
      `    def handle(self, request):`,
      `        return ${modelName}.objects.all()`,
      '',
    ].join('\n');

    beforeEach(async () => {
      projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'django-analyzer-apps-test-'));
      await fs.writeFile(path.join(projectPath, 'requirements.txt'), 'Django==4.2\n');
      await fs.writeFile(path.join(projectPath, 'manage.py'), '');
      await fs.ensureDir(path.join(projectPath, 'myproj'));
      await fs.writeFile(
        path.join(projectPath, 'myproj', 'settings.py'),
        "INSTALLED_APPS = [\n    'django.contrib.auth',\n]\nDEBUG = True\n"
      );
    });

    afterEach(async () => {
      await fs.remove(projectPath);
    });

    it('does not register a parent package that merely contains apps, and assigns each file to exactly one app', async () => {
      await writeProject({
        'modules/__init__.py': '',
        'modules/api/__init__.py': '',
        'modules/api/apps.py': 'from django.apps import AppConfig\n\nclass ApiConfig(AppConfig):\n    name = "modules.api"\n',
        'modules/api/models.py': modelsSource('FleetOrder'),
        'modules/api/views.py': viewSource('FleetOrderAPI', 'from modules.api.models import FleetOrder', 'FleetOrder'),
        'modules/billing/__init__.py': '',
        'modules/billing/apps.py': 'from django.apps import AppConfig\n\nclass BillingConfig(AppConfig):\n    name = "modules.billing"\n',
        'modules/billing/models.py': modelsSource('Invoice'),
      });

      const contribution = await analyzer.analyze({ projectPath });
      const nodes = contribution.nodes || [];

      const appNodes = nodes.filter(n => n.id.startsWith('app_'));
      expect(appNodes.map(n => n.name).sort()).toEqual(['api', 'billing']);
      expect(appNodes.find(n => n.name === 'modules')).toBeUndefined();

      const fleetViews = nodes.filter(n => n.name === 'FleetOrderAPI');
      expect(fleetViews).toHaveLength(1);
      expect(fleetViews[0].id).toBe('view_app_api_FleetOrderAPI');

      const fleetModels = nodes.filter(n => n.type === 'model' && n.name === 'FleetOrder');
      expect(fleetModels).toHaveLength(1);
      const invoiceModels = nodes.filter(n => n.type === 'model' && n.name === 'Invoice');
      expect(invoiceModels).toHaveLength(1);

      const idCounts = new Map<string, number>();
      for (const node of nodes) idCounts.set(node.id, (idCounts.get(node.id) || 0) + 1);
      const duplicateIds = [...idCounts.entries()].filter(([, count]) => count > 1);
      expect(duplicateIds).toEqual([]);
    });

    it('rolls marker-less subpackages up into the nearest app', async () => {
      await writeProject({
        'accounts/__init__.py': '',
        'accounts/apps.py': 'from django.apps import AppConfig\n\nclass AccountsConfig(AppConfig):\n    name = "accounts"\n',
        'accounts/models.py': modelsSource('Customer'),
        'accounts/services/__init__.py': '',
        'accounts/services/helpers.py': 'def helper():\n    return None\n',
      });

      const contribution = await analyzer.analyze({ projectPath });
      const nodes = contribution.nodes || [];

      const appNodes = nodes.filter(n => n.id.startsWith('app_'));
      expect(appNodes.map(n => n.name)).toEqual(['accounts']);
    });

    it('preserves legitimate nested apps and splits file ownership at the nested app boundary', async () => {
      await writeProject({
        'shop/__init__.py': '',
        'shop/apps.py': 'from django.apps import AppConfig\n\nclass ShopConfig(AppConfig):\n    name = "shop"\n',
        'shop/models.py': modelsSource('Product'),
        'shop/views.py': viewSource('ProductView', 'from shop.models import Product', 'Product'),
        'shop/payments/__init__.py': '',
        'shop/payments/apps.py': 'from django.apps import AppConfig\n\nclass PaymentsConfig(AppConfig):\n    name = "shop.payments"\n',
        'shop/payments/models.py': modelsSource('Payment'),
        'shop/payments/views.py': viewSource('PaymentView', 'from shop.payments.models import Payment', 'Payment'),
      });

      const contribution = await analyzer.analyze({ projectPath });
      const nodes = contribution.nodes || [];

      const appNodes = nodes.filter(n => n.id.startsWith('app_'));
      expect(appNodes.map(n => n.name).sort()).toEqual(['payments', 'shop']);

      const productViews = nodes.filter(n => n.name === 'ProductView');
      expect(productViews).toHaveLength(1);
      expect(productViews[0].id).toBe('view_app_shop_ProductView');

      const paymentViews = nodes.filter(n => n.name === 'PaymentView');
      expect(paymentViews).toHaveLength(1);
      expect(paymentViews[0].id).toBe('view_app_payments_PaymentView');

      const paymentModels = nodes.filter(n => n.type === 'model' && n.name === 'Payment');
      expect(paymentModels).toHaveLength(1);
      expect(paymentModels[0].id).toBe('model_app_payments_Payment');

      const productModels = nodes.filter(n => n.type === 'model' && n.name === 'Product');
      expect(productModels).toHaveLength(1);
      expect(productModels[0].id).toBe('model_app_shop_Product');
    });

    it('disambiguates app node ids when two app directories share a basename', async () => {
      await writeProject({
        'modules/__init__.py': '',
        'modules/fleet/__init__.py': '',
        'modules/fleet/models.py': modelsSource('Vehicle'),
        'legacy_sync/__init__.py': '',
        'legacy_sync/fleet/__init__.py': '',
        'legacy_sync/fleet/models.py': modelsSource('LegacyVehicle'),
      });

      const contribution = await analyzer.analyze({ projectPath });
      const nodes = contribution.nodes || [];

      const fleetApps = nodes.filter(n => n.id.startsWith('app_') && n.name === 'fleet');
      expect(fleetApps).toHaveLength(2);
      expect(new Set(fleetApps.map(n => n.id)).size).toBe(2);

      const vehicleModels = nodes.filter(n => n.type === 'model' && (n.name === 'Vehicle' || n.name === 'LegacyVehicle'));
      expect(vehicleModels).toHaveLength(2);
      expect(new Set(vehicleModels.map(n => n.id)).size).toBe(2);
    });
  });
});
