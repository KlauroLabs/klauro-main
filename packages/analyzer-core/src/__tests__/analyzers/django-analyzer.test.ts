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

  describe('analyze class-based view method node identity', () => {
    let projectPath: string;

    beforeEach(async () => {
      projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'django-analyzer-cbv-test-'));
      await fs.writeFile(path.join(projectPath, 'requirements.txt'), 'Django==4.2\ndjangorestframework==3.14\n');
      await fs.writeFile(path.join(projectPath, 'manage.py'), '');
      await fs.ensureDir(path.join(projectPath, 'myproj'));
      await fs.writeFile(
        path.join(projectPath, 'myproj', 'settings.py'),
        "INSTALLED_APPS = [\n    'django.contrib.auth',\n    'api',\n]\nDEBUG = True\n"
      );
      await fs.ensureDir(path.join(projectPath, 'api'));
      await fs.writeFile(path.join(projectPath, 'api', '__init__.py'), '');
      await fs.writeFile(
        path.join(projectPath, 'api', 'views.py'),
        [
          'from rest_framework.views import APIView',
          '',
          'class AlphaView(APIView):',
          '    def get(self, request):',
          '        return None',
          '',
          '    def post(self, request):',
          '        return None',
          '',
          'class BetaView(APIView):',
          '    def get(self, request):',
          '        return None',
          '',
          '    def post(self, request):',
          '        return None',
          '',
        ].join('\n')
      );
      await fs.writeFile(
        path.join(projectPath, 'api', 'urls.py'),
        [
          'from django.urls import path',
          'from api.views import AlphaView, BetaView',
          '',
          'urlpatterns = [',
          "    path('alpha/', AlphaView.as_view(), name='alpha'),",
          "    path('beta/', BetaView.as_view(), name='beta'),",
          ']',
          '',
        ].join('\n')
      );
    });

    afterEach(async () => {
      await fs.remove(projectPath);
    });

    it('emits distinct class-qualified node ids for same-named methods across classes', async () => {
      const contribution = await analyzer.analyze({ projectPath });
      const nodes = contribution.nodes || [];

      const viewNodes = nodes.filter(n => n.id.startsWith('view_'));
      const viewIds = viewNodes.map(n => n.id);
      expect(new Set(viewIds).size).toBe(viewIds.length);

      const methodNodeIds = [
        'view_app_api_AlphaView_get',
        'view_app_api_AlphaView_post',
        'view_app_api_BetaView_get',
        'view_app_api_BetaView_post',
      ];
      for (const id of methodNodeIds) {
        expect(viewIds).toContain(id);
      }
      expect(viewIds).not.toContain('view_app_api_get');
      expect(viewIds).not.toContain('view_app_api_post');

      const alphaGet = viewNodes.find(n => n.id === 'view_app_api_AlphaView_get');
      expect(alphaGet!.name).toBe('AlphaView.get');
      expect((alphaGet!.metadata?.attributes as Record<string, unknown>).owningClass).toBe('AlphaView');

      const betaPost = viewNodes.find(n => n.id === 'view_app_api_BetaView_post');
      expect(betaPost!.name).toBe('BetaView.post');
      expect((betaPost!.metadata?.attributes as Record<string, unknown>).owningClass).toBe('BetaView');

      expect(viewIds).toContain('view_app_api_AlphaView');
      expect(viewIds).toContain('view_app_api_BetaView');
    });

    it('keeps url binding resolved to the owning class view with the right handler', async () => {
      const contribution = await analyzer.analyze({ projectPath });
      const entryPoints = contribution.entry_points || [];

      const alphaEntries = entryPoints.filter(e => e.name.endsWith('/alpha/'));
      expect(alphaEntries.map(e => e.metadata?.handler).sort()).toEqual(['get', 'post']);
      for (const entry of alphaEntries) {
        expect(entry.source_node).toBe('view_app_api_AlphaView');
        expect(entry.metadata?.controller).toBe('AlphaView');
      }

      const betaEntries = entryPoints.filter(e => e.name.endsWith('/beta/'));
      expect(betaEntries.map(e => e.metadata?.handler).sort()).toEqual(['get', 'post']);
      for (const entry of betaEntries) {
        expect(entry.source_node).toBe('view_app_api_BetaView');
        expect(entry.metadata?.controller).toBe('BetaView');
      }
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
  describe('multi-root monorepo discovery', () => {
    let projectPath: string;

    const write = async (files: Record<string, string>) => {
      for (const [relativePath, content] of Object.entries(files)) {
        const fullPath = path.join(projectPath, relativePath);
        await fs.ensureDir(path.dirname(fullPath));
        await fs.writeFile(fullPath, content);
      }
    };

    beforeEach(async () => {
      projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'django-analyzer-monorepo-test-'));
      await write({
        'requirements.txt': 'Django==4.2\n',
        'conftest.py': 'import pytest\n',

        'backend/manage.py': 'from django.core.management import execute_from_command_line\n',
        'backend/config/__init__.py': '',
        'backend/config/settings.py': "INSTALLED_APPS = [\n    'shop',\n    'blog',\n]\nDEBUG = True\nROOT_URLCONF = 'config.urls'\n",
        'backend/config/urls.py': [
          'from django.contrib import admin',
          'from django.urls import include, path',
          'from rest_framework.routers import DefaultRouter',
          'from shop.views import ProductViewSet',
          '',
          'router = DefaultRouter()',
          'router.register(r"products", ProductViewSet, basename="product")',
          '',
          'urlpatterns = [',
          '    path("admin/", admin.site.urls),',
          '    path("shop/", include("shop.urls")),',
          '    path("blog/", include("blog.urls", namespace="blog")),',
          '    path("api/", include(router.urls)),',
          ']',
          '',
        ].join('\n'),
        'backend/shop/__init__.py': '',
        'backend/shop/apps.py': 'from django.apps import AppConfig\n\nclass ShopConfig(AppConfig):\n    name = "shop"\n',
        'backend/shop/models.py': [
          'from django.db import models',
          '',
          'class TimestampedModel(models.Model):',
          '    created_at = models.DateTimeField(auto_now_add=True)',
          '',
          '    class Meta:',
          '        abstract = True',
          '',
          'class Product(TimestampedModel):',
          '    name = models.CharField(max_length=100)',
          '',
          'class Sku(Product):',
          '    code = models.CharField(max_length=32)',
          '',
        ].join('\n'),
        'backend/shop/views.py': [
          'from rest_framework.viewsets import ModelViewSet',
          'from shop.models import Product',
          '',
          'class ProductViewSet(ModelViewSet):',
          '    queryset = Product.objects.all()',
          '',
          'def product_list(request):',
          '    return Product.objects.all()',
          '',
        ].join('\n'),
        'backend/shop/urls.py': [
          'from django.urls import path',
          'from . import views',
          '',
          'urlpatterns = [',
          '    path("", views.product_list, name="product-list"),',
          ']',
          '',
        ].join('\n'),
        'backend/blog/__init__.py': '',
        'backend/blog/apps.py': 'from django.apps import AppConfig\n\nclass BlogConfig(AppConfig):\n    name = "blog"\n',
        'backend/blog/models.py': 'from django.db import models\n\nclass Post(models.Model):\n    title = models.CharField(max_length=100)\n',
        'backend/blog/views.py': 'def post_detail(request, slug):\n    return None\n',
        'backend/blog/urls.py': [
          'from django.urls import re_path',
          'from . import views',
          '',
          'app_name = "blog"',
          'urlpatterns = [',
          '    re_path(r"^posts/(?P<slug>[\\w-]+)/$", views.post_detail, name="post-detail"),',
          ']',
          '',
        ].join('\n'),

        'service2/manage.py': 'from django.core.management import execute_from_command_line\n',
        'service2/conf/__init__.py': '',
        'service2/conf/settings.py': "INSTALLED_APPS = ['billing']\nDEBUG = False\n",
        'service2/conf/urls.py': [
          'from django.urls import include, path',
          '',
          'urlpatterns = [',
          '    path("billing/", include("billing.urls")),',
          ']',
          '',
        ].join('\n'),
        'service2/billing/__init__.py': '',
        'service2/billing/apps.py': 'from django.apps import AppConfig\n\nclass BillingConfig(AppConfig):\n    name = "billing"\n',
        'service2/billing/models.py': 'from django.db import models\n\nclass Invoice(models.Model):\n    total = models.DecimalField(max_digits=8, decimal_places=2)\n',
        'service2/billing/views.py': 'def invoice_list(request):\n    return None\n',
        'service2/billing/urls.py': [
          'from django.urls import path',
          'from . import views',
          '',
          'urlpatterns = [',
          '    path("invoices/", views.invoice_list, name="invoice-list"),',
          ']',
          '',
        ].join('\n'),

        'project_template/manage.py-tpl': 'from django.core.management import execute_from_command_line\n',
        'project_template/project_name/__init__.py': '',
        'project_template/project_name/settings.py': "INSTALLED_APPS = ['sample']\n",
        'project_template/project_name/urls.py': 'from django.urls import path\n\nurlpatterns = []\n',
        'project_template/sample/__init__.py': '',
        'project_template/sample/apps.py': 'from django.apps import AppConfig\n\nclass SampleConfig(AppConfig):\n    name = "sample"\n',
        'project_template/sample/models.py': 'from django.db import models\n\nclass ScaffoldModel(models.Model):\n    name = models.CharField(max_length=10)\n',
        'project_template/sample/urls.py': 'from django.urls import path\n\nurlpatterns = [\n    path("scaffold/", None),\n]\n',

        '{{cookiecutter.project_slug}}/app/__init__.py': '',
        '{{cookiecutter.project_slug}}/app/apps.py': 'from django.apps import AppConfig\n\nclass AppConfig2(AppConfig):\n    name = "app"\n',
        '{{cookiecutter.project_slug}}/app/models.py': 'from django.db import models\n\nclass CookieModel(models.Model):\n    name = models.CharField(max_length=10)\n',
      });
    });

    afterEach(async () => {
      await fs.remove(projectPath);
    });

    it('discovers every Django root and excludes scaffold trees from root candidacy', async () => {
      const roots = await analyzer.discoverDjangoRoots(projectPath);
      expect(roots).toEqual(['backend', 'service2']);
    });

    it('treats a flat single-root project as a single root', async () => {
      const flatPath = await fs.mkdtemp(path.join(os.tmpdir(), 'django-analyzer-flat-test-'));
      try {
        await fs.writeFile(path.join(flatPath, 'manage.py'), 'from django.core.management import execute_from_command_line\n');
        await fs.ensureDir(path.join(flatPath, 'shop'));
        await fs.writeFile(path.join(flatPath, 'shop', '__init__.py'), '');
        await fs.writeFile(path.join(flatPath, 'shop', 'models.py'), 'from django.db import models\n\nclass Product(models.Model):\n    name = models.CharField(max_length=10)\n');

        const roots = await analyzer.discoverDjangoRoots(flatPath);
        expect(roots).toEqual(['']);
      } finally {
        await fs.remove(flatPath);
      }
    });

    it('treats a package root with apps.py and a models package as the owning app', async () => {
      const packagePath = await fs.mkdtemp(path.join(os.tmpdir(), 'django-analyzer-package-test-'));
      try {
        const writeAll = async (files: Record<string, string>) => {
          for (const [relativePath, content] of Object.entries(files)) {
            const fullPath = path.join(packagePath, relativePath);
            await fs.ensureDir(path.dirname(fullPath));
            await fs.writeFile(fullPath, content);
          }
        };
        await writeAll({
          '__init__.py': '',
          'apps.py': 'from django.apps import AppConfig\n\nclass CoreConfig(AppConfig):\n    name = "core"\n',
          'models/__init__.py': 'from django.db import models\n\nclass Page(models.Model):\n    title = models.CharField(max_length=255)\n\nclass Homepage(Page):\n    tagline = models.CharField(max_length=255)\n',
          'admin/__init__.py': '',
          'admin/apps.py': 'from django.apps import AppConfig\n\nclass AdminConfig(AppConfig):\n    name = "core.admin"\n',
          'admin/urls/__init__.py': [
            'from django.urls import include, path',
            'from core.admin.urls import pages as pages_urls',
            '',
            'urlpatterns = [',
            '    path("pages/", include(pages_urls)),',
            ']',
            '',
          ].join('\n'),
          'admin/urls/pages.py': [
            'from django.urls import path',
            'from core.admin import views',
            '',
            'urlpatterns = [',
            '    path("<int:page_id>/edit/", views.edit, name="edit"),',
            ']',
            '',
          ].join('\n'),
          'admin/views.py': 'def edit(request, page_id):\n    return None\n',
        });

        const contribution = await analyzer.analyze({ projectPath: packagePath } as any);
        const nodes = contribution.nodes || [];
        const appNames = nodes.filter(n => n.id.startsWith('app_')).map(n => n.name).sort();
        expect(appNames).toContain('admin');
        expect(appNames).not.toContain('models');

        const modelNames = nodes.filter(n => n.type === 'model').map(n => n.name).sort();
        expect(modelNames).toEqual(['Homepage', 'Page']);

        const entryPaths = (contribution.entry_points || []).map(e => e.trigger?.path);
        expect(entryPaths).toContain('/pages/<int:page_id>/edit/');
      } finally {
        await fs.remove(packagePath);
      }
    });

    it('analyzes apps, models, and routes from all roots while ignoring scaffolding', async () => {
      const contribution = await analyzer.analyze({ projectPath } as any);
      const nodes = contribution.nodes || [];
      const entryPoints = contribution.entry_points || [];

      const appNames = nodes.filter(n => n.id.startsWith('app_')).map(n => n.name).sort();
      expect(appNames).toContain('shop');
      expect(appNames).toContain('blog');
      expect(appNames).toContain('billing');
      expect(appNames).not.toContain('sample');
      expect(appNames).not.toContain('app');
      expect(appNames).not.toContain('project_name');

      const modelNames = nodes.filter(n => n.type === 'model').map(n => n.name);
      expect(modelNames).toContain('Product');
      expect(modelNames).toContain('Sku');
      expect(modelNames).toContain('Post');
      expect(modelNames).toContain('Invoice');
      expect(modelNames).not.toContain('ScaffoldModel');
      expect(modelNames).not.toContain('CookieModel');

      const timestamped = nodes.find(n => n.type === 'model' && n.name === 'TimestampedModel');
      expect(timestamped).toBeDefined();
      expect(timestamped!.subcategories).toContain('abstract');
      expect(timestamped!.subcategories).not.toContain('entity');

      const sku = nodes.find(n => n.type === 'model' && n.name === 'Sku');
      expect(sku!.subcategories).toContain('entity');
      expect(sku!.metadata?.attributes?.parent_model).toBe('Product');
      const skuFieldNames = nodes
        .filter(n => n.type === 'field' && n.parent === sku!.id)
        .map(n => n.name)
        .sort();
      expect(skuFieldNames).toEqual(['code', 'created_at', 'name']);

      const invoiceFields = nodes.filter(n => n.type === 'field' && n.name === 'total');
      expect(invoiceFields.length).toBeGreaterThanOrEqual(1);

      const entryPaths = entryPoints.map(e => e.trigger?.path);
      expect(entryPaths).toContain('/shop/');
      expect(entryPaths).toContain('/blog/posts/<slug>/');
      expect(entryPaths).toContain('/billing/invoices/');
      expect(entryPaths).toContain('/api/products/');
      expect(entryPaths).toContain('/api/products/<pk>/');
      expect(entryPaths).toContain('/admin/');
      expect(entryPaths.some(p => p && p.includes('scaffold'))).toBe(false);

      const adminEntries = entryPoints.filter(e => e.trigger?.path === '/admin/');
      expect(adminEntries.length).toBeGreaterThanOrEqual(1);
      for (const adminEntry of adminEntries) {
        expect(adminEntry.security?.authenticated).toBe(true);
      }

      const detailEntry = entryPoints.find(e => e.trigger?.path === '/api/products/<pk>/' && e.trigger?.method === 'DELETE');
      expect(detailEntry).toBeDefined();

      const metadata = contribution.analyzer_metadata as Record<string, any>;
      expect(metadata.djangoRoots).toEqual(['backend', 'service2']);
    });
  });

  describe('canAnalyze', () => {
    let root: string;

    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'django-analyzer-canAnalyze-'));
    });

    afterEach(() => {
      fs.removeSync(root);
    });

    it('rejects a pyproject.toml [project.optional-dependencies] extras group named "django" (self-detection defect: Klauro\'s own packages/klauro-sdk-py/pyproject.toml lists django as an instrumentation-target extra with an empty real dependencies array)', async () => {
      fs.writeFileSync(
        path.join(root, 'pyproject.toml'),
        [
          '[project]',
          'name = "klauro-telemetry"',
          'dependencies = []',
          '',
          '[project.optional-dependencies]',
          'django = ["django>=3.2"]',
        ].join('\n')
      );

      expect(await analyzer.canAnalyze(root)).toBe(false);
    });

    it('detects a real PEP 621 top-level dependencies array entry', async () => {
      fs.writeFileSync(
        path.join(root, 'pyproject.toml'),
        [
          '[project]',
          'name = "real-django-app"',
          'dependencies = [',
          '    "django>=4.0",',
          ']',
        ].join('\n')
      );

      expect(await analyzer.canAnalyze(root)).toBe(true);
    });
  });
});
