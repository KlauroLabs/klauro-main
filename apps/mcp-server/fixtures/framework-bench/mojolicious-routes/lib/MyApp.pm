package MyApp;
use Mojolicious::Lite;

# --- Mojolicious::Lite form: VERB '/path' => sub { ... } ---

# GET / — health/landing
get '/' => sub {
  my $c = shift;
  $c->render(text => 'ok');
};

# POST /users — create a user
post '/users' => sub {
  my $c = shift;
  $c->render(json => { created => 1 });
};

# GET /users/:id — show one user (Mojo :id placeholder kept verbatim)
get '/users/:id' => sub {
  my $c = shift;
  $c->render(json => { id => $c->param('id') });
};

# DELETE /users/:id — Mojo spells DELETE as `del`
del '/users/:id' => sub {
  my $c = shift;
  $c->render(json => { deleted => 1 });
};

# --- Full router form: $r->verb('/path')->to('controller#action') ---

my $r = app->routes;

# GET /api/items
$r->get('/api/items')->to('items#index');

# POST /login
$r->post('/login')->to('auth#login');

app->start;

1;
