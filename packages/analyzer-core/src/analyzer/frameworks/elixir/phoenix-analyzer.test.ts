import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PhoenixAnalyzer } from './phoenix-analyzer';

function makeProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phoenix-analyzer-test-'));

  fs.writeFileSync(
    path.join(dir, 'mix.exs'),
    [
      'defmodule App.MixProject do',
      '  use Mix.Project',
      '  defp deps do',
      '    [{:phoenix, "~> 1.7"}, {:ecto_sql, "~> 3.10"}]',
      '  end',
      'end',
      '',
    ].join('\n')
  );

  fs.mkdirSync(path.join(dir, 'lib', 'app_web'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'lib', 'app_web', 'router.ex'),
    [
      'defmodule AppWeb.Router do',
      '  use Phoenix.Router',
      '',
      '  pipeline :browser do',
      '    plug :fetch_session',
      '  end',
      '',
      '  scope "/", AppWeb do',
      '    pipe_through :browser',
      '',
      '    get "/users", UserController, :index',
      '    live "/dash", DashLive',
      '  end',
      'end',
      '',
    ].join('\n')
  );

  fs.mkdirSync(path.join(dir, 'lib', 'app_web', 'controllers'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'lib', 'app_web', 'controllers', 'user_controller.ex'),
    [
      'defmodule AppWeb.UserController do',
      '  use AppWeb, :controller',
      '',
      '  def index(conn, _params) do',
      '    users = App.Accounts.list_users()',
      '    render(conn, :index, users: users)',
      '  end',
      'end',
      '',
    ].join('\n')
  );

  fs.mkdirSync(path.join(dir, 'lib', 'app_web', 'live'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'lib', 'app_web', 'live', 'dash_live.ex'),
    [
      'defmodule AppWeb.DashLive do',
      '  use AppWeb, :live_view',
      '',
      '  def mount(_params, _session, socket), do: {:ok, socket}',
      '  def handle_event("refresh", _params, socket), do: {:noreply, socket}',
      'end',
      '',
    ].join('\n')
  );

  fs.mkdirSync(path.join(dir, 'lib', 'app', 'accounts'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'lib', 'app', 'accounts', 'user.ex'),
    [
      'defmodule App.Accounts.User do',
      '  use Ecto.Schema',
      '',
      '  schema "users" do',
      '    field :email, :string',
      '    has_many :posts, Post',
      '  end',
      'end',
      '',
    ].join('\n')
  );

  fs.writeFileSync(
    path.join(dir, 'lib', 'app', 'accounts.ex'),
    [
      'defmodule App.Accounts do',
      '  alias App.Accounts.User',
      '',
      '  def list_users, do: []',
      'end',
      '',
    ].join('\n')
  );

  return dir;
}

test('PhoenixAnalyzer.canAnalyze returns true for a phoenix project', async () => {
  const dir = makeProject();
  try {
    const analyzer = new PhoenixAnalyzer();
    assert.equal(await analyzer.canAnalyze(dir), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PhoenixAnalyzer.analyze extracts routes, controllers, liveviews, and ecto schemas', async () => {
  const dir = makeProject();
  try {
    const analyzer = new PhoenixAnalyzer();
    const cas = await analyzer.analyze({ projectPath: dir });

    // Router node present.
    const router = cas.nodes!.find(n => n.type === 'phoenix_router');
    assert.ok(router, 'should have a phoenix_router node');

    // Route GET /users -> UserController#index, scope-prefixed correctly.
    const routes = cas.nodes!.filter(n => n.type === 'phoenix_route');
    const getUsers = routes.find(n =>
      n.metadata?.attributes?.method === 'GET' && n.metadata?.attributes?.path === '/users');
    assert.ok(getUsers, 'should have GET /users route');
    assert.equal(getUsers!.metadata?.attributes?.controller, 'UserController');
    assert.equal(getUsers!.metadata?.attributes?.action, 'index');

    // GET /users is an http entry point.
    const getUsersEntry = cas.entry_points!.find(e =>
      e.type === 'http' && e.trigger?.method === 'GET' && e.trigger?.path === '/users');
    assert.ok(getUsersEntry, 'GET /users should be an http entry point');

    // The live route /dash -> DashLive.
    const liveRoute = routes.find(n => n.metadata?.attributes?.method === 'LIVE');
    assert.ok(liveRoute, 'should have a live route');
    assert.equal(liveRoute!.metadata?.attributes?.path, '/dash');
    assert.equal(liveRoute!.metadata?.attributes?.controller, 'DashLive');
    const liveEntry = cas.entry_points!.find(e => e.type === 'page' && e.trigger?.path === '/dash');
    assert.ok(liveEntry, 'live route should be a page entry point');

    // Controller UserController with index action.
    const controller = cas.nodes!.find(n =>
      n.type === 'phoenix_controller' && n.name === 'UserController');
    assert.ok(controller, 'should have UserController node');
    assert.ok(
      (controller!.metadata?.attributes?.actions as string[]).includes('index'),
      'UserController should have index action'
    );

    // LiveView DashLive present.
    const liveview = cas.nodes!.find(n => n.type === 'phoenix_liveview' && n.name === 'DashLive');
    assert.ok(liveview, 'should have DashLive liveview node');

    // Ecto schema User (entity) with email field + has_many posts association.
    const schema = cas.nodes!.find(n => n.type === 'ecto_schema' && n.name === 'User');
    assert.ok(schema, 'should have User ecto_schema node');
    assert.equal(schema!.metadata?.attributes?.table, 'users');
    const fields = schema!.metadata?.attributes?.fields as Array<{ name: string; type: string }>;
    assert.ok(fields.some(f => f.name === 'email'), 'User should have email field');
    const assocs = schema!.metadata?.attributes?.associations as Array<{ type: string; name: string }>;
    assert.ok(
      assocs.some(a => a.type === 'has_many' && a.name === 'posts'),
      'User should have has_many :posts association'
    );

    // email field node exists.
    const emailField = cas.nodes!.find(n => n.type === 'field' && n.name === 'email');
    assert.ok(emailField, 'should have email field node');

    // Context detected and linked.
    const context = cas.nodes!.find(n => n.type === 'phoenix_context' && n.name === 'Accounts');
    assert.ok(context, 'should detect App.Accounts context');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
