jest.unmock('fs-extra');
jest.unmock('fs');
jest.unmock('glob');

import { GoAnalyzer } from '../../analyzer/languages/go-analyzer';

describe('GoAnalyzer HTTP route extraction', () => {
  let analyzer: GoAnalyzer;

  beforeEach(() => {
    analyzer = new GoAnalyzer();
  });

  function extractRoutes(content: string): any[] {
    const entryPoints: any[] = [];
    (analyzer as any).extractGoHttpRoutes(content, 'file_test', 'routes.go', entryPoints);
    return entryPoints;
  }

  it('composes a Gorilla mux Subrouter PathPrefix into the full route path', () => {
    const content = [
      `package main`,
      `import "github.com/gorilla/mux"`,
      `func register(r *mux.Router) {`,
      `  sr := r.PathPrefix("/v1").Subrouter()`,
      `  sr.HandleFunc("/entries", handler.getEntries).Methods("GET")`,
      `}`,
    ].join('\n');

    const routes = extractRoutes(content);

    expect(routes.map(r => r.name)).toContain('GET /v1/entries');
  });

  it('resolves Methods() verbs given as http.MethodX constants, not just string literals', () => {
    const content = [
      `package main`,
      `import ("net/http"; "github.com/gorilla/mux")`,
      `func register(r *mux.Router) {`,
      `  sr := r.PathPrefix("/v1").Subrouter()`,
      `  sr.HandleFunc("/entries", handler.getEntries).Methods(http.MethodGet)`,
      `  sr.HandleFunc("/entries", handler.createEntry).Methods(http.MethodPost)`,
      `}`,
    ].join('\n');

    const routes = extractRoutes(content);

    expect(routes.map(r => r.name)).toContain('GET /v1/entries');
    expect(routes.map(r => r.name)).toContain('POST /v1/entries');
  });

  it('keeps working when a .Name() chain follows .Methods()', () => {
    const content = [
      `package main`,
      `import "github.com/gorilla/mux"`,
      `func register(r *mux.Router) {`,
      `  r.HandleFunc("/unread", handler.showUnreadPage).Methods("GET").Name("unread")`,
      `}`,
    ].join('\n');

    const routes = extractRoutes(content);

    expect(routes.map(r => r.name)).toContain('GET /unread');
  });

  it('extracts Go 1.22+ stdlib ServeMux enhanced patterns with struct-method handlers', () => {
    // Real shape used by miniflux's internal/api/api.go and internal/ui/ui.go:
    // the verb is embedded in the pattern string, not a builder call or a
    // .Methods() chain, and the handler is a struct-method value.
    const content = [
      `package api`,
      `import "net/http"`,
      `func NewHandler() http.Handler {`,
      `  mux := http.NewServeMux()`,
      `  mux.HandleFunc("POST /v1/users", handler.createUserHandler)`,
      `  mux.HandleFunc("GET /v1/users/{identifier}", handler.dispatchUserLookupHandler)`,
      `  mux.HandleFunc("PUT /v1/categories/{categoryID}/mark-all-as-read", handler.markCategoryAsReadHandler)`,
      `  return mux`,
      `}`,
    ].join('\n');

    const routes = extractRoutes(content);
    const names = routes.map(r => r.name);

    expect(names).toContain('POST /v1/users');
    expect(names).toContain('GET /v1/users/:identifier');
    expect(names).toContain('PUT /v1/categories/:categoryID/mark-all-as-read');
  });

  it('extracts Go 1.22+ stdlib ServeMux patterns with an inline func literal handler', () => {
    const content = [
      `package ui`,
      `import "net/http"`,
      `func Serve() http.Handler {`,
      `  mux := http.NewServeMux()`,
      `  mux.HandleFunc("GET /robots.txt", func(w http.ResponseWriter, r *http.Request) {`,
      `    w.Write([]byte("ok"))`,
      `  })`,
      `  return mux`,
      `}`,
    ].join('\n');

    const routes = extractRoutes(content);

    expect(routes.map(r => r.name)).toContain('GET /robots.txt');
  });

  it('marks every stdlib ServeMux route authenticated when the whole handler is middleware-wrapped', () => {
    // Real shape used by miniflux's internal/api/api.go: no per-route .Use(),
    // the entire mux is wrapped by auth middleware in the return statement.
    const content = [
      `package api`,
      `import "net/http"`,
      `func NewHandler() http.Handler {`,
      `  mux := http.NewServeMux()`,
      `  mux.HandleFunc("GET /v1/version", handler.versionHandler)`,
      `  return middleware.withCORSHeaders(middleware.validateAPIKeyAuth(middleware.validateBasicAuth(mux)))`,
      `}`,
    ].join('\n');

    const routes = extractRoutes(content);
    const versionRoute = routes.find(r => r.name === 'GET /v1/version');

    expect(versionRoute).toBeDefined();
    expect(versionRoute.security.authenticated).toBe(true);
  });

  it('does not mark stdlib ServeMux routes authenticated when the wrap has no auth middleware', () => {
    const content = [
      `package ui`,
      `import "net/http"`,
      `func Serve() http.Handler {`,
      `  mux := http.NewServeMux()`,
      `  mux.HandleFunc("GET /favicon.ico", handler.showFavicon)`,
      `  return corsOnlyMiddleware.handle(mux)`,
      `}`,
    ].join('\n');

    const routes = extractRoutes(content);
    const faviconRoute = routes.find(r => r.name === 'GET /favicon.ico');

    expect(faviconRoute).toBeDefined();
    expect(faviconRoute.security.authenticated).toBe(false);
  });

  it('ignores a commented-out HandleFunc registration (negative control)', () => {
    const content = [
      `package api`,
      `import "net/http"`,
      `func NewHandler() http.Handler {`,
      `  mux := http.NewServeMux()`,
      `  // mux.HandleFunc("DELETE /v1/debug/reset", handler.debugResetHandler)`,
      `  mux.HandleFunc("GET /v1/version", handler.versionHandler)`,
      `  return mux`,
      `}`,
    ].join('\n');

    const routes = extractRoutes(content);
    const names = routes.map(r => r.name);

    expect(names).not.toContain('DELETE /v1/debug/reset');
    expect(names).toContain('GET /v1/version');
  });

  it('ignores a block-commented-out HandleFunc registration', () => {
    const content = [
      `package api`,
      `import "net/http"`,
      `func NewHandler() http.Handler {`,
      `  mux := http.NewServeMux()`,
      `  /* mux.HandleFunc("DELETE /v1/debug/reset", handler.debugResetHandler) */`,
      `  mux.HandleFunc("GET /v1/version", handler.versionHandler)`,
      `  return mux`,
      `}`,
    ].join('\n');

    const routes = extractRoutes(content);
    const names = routes.map(r => r.name);

    expect(names).not.toContain('DELETE /v1/debug/reset');
    expect(names).toContain('GET /v1/version');
  });

  it('does not confuse a Gorilla .Methods() route with the stdlib pattern-in-string route in the same file', () => {
    const content = [
      `package main`,
      `import ("net/http"; "github.com/gorilla/mux")`,
      `func register(r *mux.Router) {`,
      `  r.HandleFunc("/users", handler.listUsers).Methods("GET")`,
      `}`,
      `func registerStdlib() {`,
      `  mux2 := http.NewServeMux()`,
      `  mux2.HandleFunc("GET /health", handler.health)`,
      `}`,
    ].join('\n');

    const routes = extractRoutes(content);
    const names = routes.map(r => r.name);

    expect(names).toContain('GET /users');
    expect(names).toContain('GET /health');
    // exactly one entry per route — no double-count across the two regexes
    expect(names.filter(n => n === 'GET /users')).toHaveLength(1);
    expect(names.filter(n => n === 'GET /health')).toHaveLength(1);
  });

  it('extracts a real Gin builder route with an explicit handler argument', () => {
    const content = [
      `package main`,
      `import "github.com/gin-gonic/gin"`,
      `func register(r *gin.Engine) {`,
      `  r.GET("/v1/feeds", getFeeds)`,
      `  r.POST("/accounts/ClientLogin", clientLoginHandler)`,
      `}`,
    ].join('\n');

    const routes = extractRoutes(content);
    const names = routes.map(r => r.name);

    expect(names).toContain('GET /v1/feeds');
    expect(names).toContain('POST /accounts/ClientLogin');
  });

  it('does not treat r.Form.Get / r.Header.Get form-and-header accessor reads as route registrations', () => {
    // Real shape observed on a live production repo: these accessor calls
    // share the .GET/.Get method-name shape with Gin/Echo/Fiber route
    // builders, but read a value and bind nothing — no handler argument.
    const content = [
      `package accounts`,
      `import "github.com/gin-gonic/gin"`,
      `func clientLoginHandler(w http.ResponseWriter, r *http.Request) {`,
      `  r.ParseForm()`,
      `  email := r.Form.Get("Email")`,
      `  passwd := r.Form.Get("Passwd")`,
      `  output := r.Form.Get("output")`,
      `  proto := r.Header.Get("X-Forwarded-Proto")`,
      `  q := r.URL.Query().Get("output")`,
      `  _ = email`,
      `  _ = passwd`,
      `  _ = output`,
      `  _ = proto`,
      `  _ = q`,
      `}`,
    ].join('\n');

    const routes = extractRoutes(content);
    const names = routes.map(r => r.name);

    expect(names).not.toContain('GET Email');
    expect(names).not.toContain('GET Passwd');
    expect(names).not.toContain('GET output');
    expect(names).not.toContain('GET X-Forwarded-Proto');
    expect(routes).toHaveLength(0);
  });

  it('does not treat a single-argument accessor call as a route even when a real router is present in the same file', () => {
    // The web-framework gate (gin-gonic/gin present) alone must not be
    // sufficient — the call itself still needs a handler argument and a
    // path-shaped first argument.
    const content = [
      `package main`,
      `import "github.com/gin-gonic/gin"`,
      `func register(r *gin.Engine) {`,
      `  r.GET("/v1/feeds", getFeeds)`,
      `}`,
      `func handler(r *http.Request) {`,
      `  session := r.Header.Get("Authorization")`,
      `  _ = session`,
      `}`,
    ].join('\n');

    const routes = extractRoutes(content);
    const names = routes.map(r => r.name);

    expect(names).toContain('GET /v1/feeds');
    expect(names).not.toContain('GET Authorization');
    expect(routes).toHaveLength(1);
  });

  it('keeps one handler bound to multiple genuinely distinct paths as separate routes', () => {
    const content = [
      `package main`,
      `import "github.com/gin-gonic/gin"`,
      `func register(r *gin.Engine) {`,
      `  r.GET("/v1/feeds", listResource)`,
      `  r.GET("/v1/categories", listResource)`,
      `  r.GET("/v1/entries", listResource)`,
      `}`,
    ].join('\n');

    const routes = extractRoutes(content);
    const names = routes.map(r => r.name);

    expect(names).toContain('GET /v1/feeds');
    expect(names).toContain('GET /v1/categories');
    expect(names).toContain('GET /v1/entries');
    expect(routes).toHaveLength(3);
    expect(routes.every(r => r.handler?.method_name === 'listResource')).toBe(true);
  });

  it('rejects a builder-shaped call whose path argument does not look like a path (no leading slash)', () => {
    const content = [
      `package main`,
      `import "github.com/gin-gonic/gin"`,
      `func register(r *gin.Engine) {`,
      `  cfg.GET("timeout", someHandler)`,
      `}`,
    ].join('\n');

    const routes = extractRoutes(content);

    expect(routes).toHaveLength(0);
  });

  it('distinguishes imported package calls from same-process receiver calls', () => {
    const classify = (target: string, method: string | undefined, imports: string[]) =>
      (analyzer as any).isExternalLibraryCall(target, method, 'ui', new Set(imports));

    expect(classify('errors', 'New', ['errors'])).toBe(true);
    expect(classify('stripe', 'NewClient', ['stripe'])).toBe(true);
    expect(classify('h.store', 'GetNavMetadata', ['errors', 'http'])).toBe(false);
    expect(classify('c.request', 'Get', ['errors', 'http'])).toBe(false);
    expect(classify('this', 'Render', ['errors'])).toBe(false);
  });

  it('uses Go import aliases as the package identity and ignores side-effect imports', () => {
    const imports = (analyzer as any).importedGoPackageNames([
      { path: 'errors' },
      { path: 'github.com/acme/payments', alias: 'pay' },
      { path: 'github.com/acme/driver', alias: '_' },
      { path: 'github.com/acme/dot', alias: '.' },
    ]);

    expect([...imports]).toEqual(['errors', 'pay']);
  });
});
