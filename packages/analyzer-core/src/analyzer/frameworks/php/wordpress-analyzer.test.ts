import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { WordPressAnalyzer } from './wordpress-analyzer';

const PLUGIN = `<?php
/*
 * Plugin Name: Demo
 * Version: 1.2.3
 * Description: A demo plugin.
 * Author: Tester
 */

add_action('init', 'demo_init');
add_filter('the_content', 'demo_filter_content', 20);

function demo_init() {
  register_post_type('book', [
    'public' => true,
    'label' => 'Books',
  ]);
  register_taxonomy('genre', 'book', ['hierarchical' => true]);
}

add_shortcode('hello', 'demo_hello');

add_action('rest_api_init', function () {
  register_rest_route('demo/v1', '/items', [
    'methods'  => 'GET',
    'callback' => 'demo_items',
  ]);
});

add_action('wp_ajax_demo_save', 'demo_save');
add_action('wp_ajax_nopriv_demo_save', 'demo_save');

add_action('wp_enqueue_scripts', 'demo_assets');
function demo_assets() {
  wp_enqueue_script('demo-script', 'js/demo.js');
  wp_enqueue_style('demo-style', 'css/demo.css');
}

function demo_filter_content($content) { return $content; }
function demo_hello() { return 'hi'; }
function demo_items() { return []; }
function demo_save() {}
`;

async function makeProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wp-analyzer-test-'));
  await fs.writeFile(path.join(dir, 'demo-plugin.php'), PLUGIN);
  return dir;
}

test('canAnalyze detects a WordPress plugin via the Plugin Name header', async () => {
  const dir = await makeProject();
  try {
    const analyzer = new WordPressAnalyzer();
    assert.equal(await analyzer.canAnalyze(dir), true);
  } finally {
    await fs.remove(dir);
  }
});

test('supports incremental analysis', () => {
  const analyzer = new WordPressAnalyzer();
  assert.equal(analyzer.supportsIncrementalAnalysis(), true);
});

test('extracts plugin node, hook->callback edge, post type, shortcode, REST route', async () => {
  const dir = await makeProject();
  try {
    const analyzer = new WordPressAnalyzer();
    const result = await analyzer.analyze({ projectPath: dir } as any);

    // Plugin metadata node.
    const plugin = result.nodes.find(n => n.type === 'wordpress_plugin');
    assert.ok(plugin, 'expected a wordpress_plugin node');
    assert.equal(plugin!.name, 'Demo');

    // init action hook node.
    const initHook = result.nodes.find(n => n.type === 'wordpress_action' && n.name === 'init');
    assert.ok(initHook, 'expected an init action hook node');

    // init hook -> demo_init callback edge.
    const callbackTargetId = (analyzer as any).generateId('function', '', 'demo_init');
    const hookEdge = result.edges.find(e => e.source === initHook!.id && e.target === callbackTargetId);
    assert.ok(hookEdge, 'expected an edge from the init hook to demo_init');

    // priority captured on the filter hook.
    const filterHook = result.nodes.find(n => n.type === 'wordpress_filter' && n.name === 'the_content');
    assert.ok(filterHook, 'expected the_content filter hook');
    assert.equal(filterHook!.metadata?.attributes?.priority, 20);

    // post type 'book'.
    const book = result.nodes.find(n => n.type === 'wordpress_post_type' && n.name === 'book');
    assert.ok(book, "expected the 'book' post type");

    // taxonomy 'genre'.
    const genre = result.nodes.find(n => n.type === 'wordpress_taxonomy' && n.name === 'genre');
    assert.ok(genre, "expected the 'genre' taxonomy");

    // shortcode 'hello'.
    const shortcode = result.nodes.find(n => n.type === 'wordpress_shortcode' && n.name === 'hello');
    assert.ok(shortcode, "expected the 'hello' shortcode");

    // REST route GET demo/v1/items as an entry point.
    const restNode = result.nodes.find(n => n.type === 'wordpress_rest_route');
    assert.ok(restNode, 'expected a wordpress_rest_route node');
    assert.equal(restNode!.metadata?.attributes?.full_path, '/demo/v1/items');
    const restEntry = result.entry_points.find(
      e => e.type === 'http' && e.trigger?.method === 'GET' && e.trigger?.path === '/demo/v1/items'
    );
    assert.ok(restEntry, 'expected a GET /demo/v1/items entry point');

    // AJAX endpoints (priv + nopriv).
    const ajaxEntries = result.entry_points.filter(e => e.name.startsWith('AJAX '));
    assert.equal(ajaxEntries.length, 2, 'expected 2 AJAX entry points');
  } finally {
    await fs.remove(dir);
  }
});

test('analyzeFileSingle returns the same plugin + hook semantics', async () => {
  const dir = await makeProject();
  try {
    const analyzer = new WordPressAnalyzer();
    const filePath = path.join(dir, 'demo-plugin.php');
    const result = await analyzer.analyzeFileSingle({
      projectPath: dir,
      filePath,
      relativePath: 'demo-plugin.php',
    } as any);
    assert.ok(result.nodes.find(n => n.type === 'wordpress_plugin'));
    assert.ok(result.nodes.find(n => n.type === 'wordpress_action' && n.name === 'init'));
    assert.ok(result.nodes.find(n => n.type === 'wordpress_post_type' && n.name === 'book'));
  } finally {
    await fs.remove(dir);
  }
});
