import { extractRailsRoutes } from '../../analyzer/frameworks/web/rails-route-parser';

describe('extractRailsRoutes', () => {
  test('preserves a parent resource path for nested singular resources', () => {
    const routes = extractRailsRoutes([
      'resources :imports, only: %i[index new show create destroy] do',
      '  resource :upload, only: %i[show update], module: :import',
      'end',
    ].join('\n'));

    expect(routes).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'GET', path: '/imports/:import_id/upload', controller: 'import/uploads', action: 'show' }),
      expect.objectContaining({ method: 'PATCH', path: '/imports/:import_id/upload', controller: 'import/uploads', action: 'update' }),
    ]));
    expect(routes).not.toEqual(expect.arrayContaining([expect.objectContaining({ path: '/upload' })]));
  });

  test('retains namespace and every parent path for nested plural resources', () => {
    const routes = extractRailsRoutes([
      'namespace :admin do',
      '  resources :companies, only: :show do',
      '    resources :policies, only: %i[index create]',
      '  end',
      'end',
    ].join('\n'));

    expect(routes).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'GET', path: '/admin/companies/:company_id/policies', controller: 'admin/policies', action: 'index' }),
      expect.objectContaining({ method: 'POST', path: '/admin/companies/:company_id/policies', controller: 'admin/policies', action: 'create' }),
    ]));
  });

  test('uses a custom route path without changing the nested parameter name', () => {
    const routes = extractRailsRoutes([
      'resources :companies, path: "members", only: :show do',
      '  resource :profile, only: :show',
      'end',
    ].join('\n'));

    expect(routes).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/members/:company_id/profile' }),
    ]));
  });
  test('extracts custom member and collection actions at their Rails paths', () => {
    const routes = extractRailsRoutes([
      'resources :imports do',
      '  member do',
      '    post :publish',
      '    put :revert',
      '  end',
      '  put :apply_template, on: :member',
      '  collection do',
      '    get :archived',
      '  end',
      'end',
    ].join('\n'));

    expect(routes).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'POST', path: '/imports/:id/publish', controller: 'imports', action: 'publish' }),
      expect.objectContaining({ method: 'PUT', path: '/imports/:id/revert', controller: 'imports', action: 'revert' }),
      expect.objectContaining({ method: 'PUT', path: '/imports/:id/apply_template', controller: 'imports', action: 'apply_template' }),
      expect.objectContaining({ method: 'GET', path: '/imports/archived', controller: 'imports', action: 'archived' }),
    ]));
  });

  test('extracts custom member and collection actions at their Rails paths', () => {
    const routes = extractRailsRoutes([
      'resources :imports do',
      '  member do',
      '    post :publish',
      '    put :revert',
      '  end',
      '  put :apply_template, on: :member',
      '  collection do',
      '    get :archived',
      '  end',
      'end',
    ].join('\n'));

    expect(routes).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'POST', path: '/imports/:id/publish', controller: 'imports', action: 'publish' }),
      expect.objectContaining({ method: 'PUT', path: '/imports/:id/revert', controller: 'imports', action: 'revert' }),
      expect.objectContaining({ method: 'PUT', path: '/imports/:id/apply_template', controller: 'imports', action: 'apply_template' }),
      expect.objectContaining({ method: 'GET', path: '/imports/archived', controller: 'imports', action: 'archived' }),
    ]));
  });

});
