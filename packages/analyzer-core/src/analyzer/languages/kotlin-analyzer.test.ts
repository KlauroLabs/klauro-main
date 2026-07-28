import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { KotlinAnalyzer } from './kotlin-analyzer';

function writeFile(dir: string, relPath: string, content: string): void {
  const fullPath = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

function makeTempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kotlin-analyzer-test-'));

  // App.kt: package, interface, a class extending it (supertype form), a
  // Composable function, and a top-level main.
  const app = [
    'package demo',
    '',
    'import androidx.compose.runtime.Composable',
    '',
    'interface Repo',
    '',
    'class UserService : Repo {',
    '    fun load() {',
    '        fetch()',
    '    }',
    '',
    '    private fun fetch() {}',
    '}',
    '',
    '@Composable',
    'fun Screen() {}',
    '',
    'fun main() {',
    '}',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'App.kt'), app);

  return dir;
}

test('KotlinAnalyzer.canAnalyze returns true for a kotlin project', async () => {
  const dir = makeTempProject();
  try {
    const analyzer = new KotlinAnalyzer();
    assert.equal(await analyzer.canAnalyze(dir), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('KotlinAnalyzer.analyze extracts types, functions, inheritance, compose, calls, entry points', async () => {
  const dir = makeTempProject();
  try {
    const analyzer = new KotlinAnalyzer();
    const cas = await analyzer.analyze({ projectPath: dir });

    // Type nodes: Repo (interface) + UserService (class).
    const repo = cas.nodes.find(n => n.name === 'Repo');
    const userService = cas.nodes.find(n => n.name === 'UserService');
    assert.ok(repo, 'Repo type node exists');
    assert.ok(userService, 'UserService type node exists');
    assert.equal(repo!.type, 'interface', 'Repo is an interface node');
    assert.equal(userService!.type, 'class', 'UserService is a class node');

    // Function/method nodes: load, fetch, Screen, main.
    const fnNodes = cas.nodes.filter(n => n.type === 'function' || n.type === 'method');
    const fnNames = fnNodes.map(n => n.name).sort();
    assert.deepEqual(fnNames, ['Screen', 'fetch', 'load', 'main'], 'extracts all functions');

    const load = fnNodes.find(n => n.name === 'load')!;
    const fetch = fnNodes.find(n => n.name === 'fetch')!;
    const screen = fnNodes.find(n => n.name === 'Screen')!;
    const main = fnNodes.find(n => n.name === 'main')!;
    assert.ok(load.source?.file && load.source?.line, 'load has source file+line');
    assert.equal(fetch.metadata?.attributes?.visibility, 'private', 'fetch is private');

    // Inheritance edge UserService -> Repo (implements, since Repo is an interface).
    const inheritEdge = cas.edges.find(e =>
      e.source === userService!.id && e.target === repo!.id &&
      (e.type === 'implements' || e.type === 'extends')
    );
    assert.ok(inheritEdge, 'inheritance edge UserService -> Repo exists');

    // Screen tagged compose-fn.
    assert.ok(screen.tags?.includes('compose-fn'), 'Screen tagged compose-fn');

    // calls edge load -> fetch.
    const callEdge = cas.edges.find(e =>
      e.type === 'calls' && e.source === load.id && e.target === fetch.id
    );
    assert.ok(callEdge, 'calls edge load -> fetch exists');

    // main is an entry point.
    const mainEntry = (cas.entry_points || []).find(ep => ep.source_node === main.id);
    assert.ok(mainEntry, 'main is registered as an entry point');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P0 gap-fix regression coverage: Android component families, WorkManager
// Workers, Compose Navigation destinations, and manifest/structural dedup.
// ---------------------------------------------------------------------------

test('AndroidManifest.xml declaring 3 activities yields exactly 3 activity entry points', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kotlin-analyzer-test-'));
  try {
    writeFile(dir, 'app/src/main/java/com/example/MainActivity.kt', [
      'package com.example',
      '',
      'import android.app.Activity',
      '',
      'class MainActivity : Activity() {',
      '}',
      '',
    ].join('\n'));
    writeFile(dir, 'app/src/main/java/com/example/SettingsActivity.kt', [
      'package com.example',
      '',
      'import androidx.appcompat.app.AppCompatActivity',
      '',
      'class SettingsActivity : AppCompatActivity() {',
      '}',
      '',
    ].join('\n'));
    writeFile(dir, 'app/src/main/java/com/example/DetailActivity.kt', [
      'package com.example',
      '',
      'import androidx.activity.ComponentActivity',
      '',
      'class DetailActivity : ComponentActivity() {',
      '}',
      '',
    ].join('\n'));
    writeFile(dir, 'app/src/main/AndroidManifest.xml', [
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example">',
      '  <application>',
      '    <activity android:name=".MainActivity">',
      '      <intent-filter>',
      '        <action android:name="android.intent.action.MAIN" />',
      '        <category android:name="android.intent.category.LAUNCHER" />',
      '      </intent-filter>',
      '    </activity>',
      '    <activity android:name=".SettingsActivity" />',
      '    <activity android:name=".DetailActivity" />',
      '  </application>',
      '</manifest>',
      '',
    ].join('\n'));

    const analyzer = new KotlinAnalyzer();
    const cas = await analyzer.analyze({ projectPath: dir });
    const activityEntries = (cas.entry_points || []).filter(ep =>
      ep.metadata?.component === 'activity' || (ep.type === 'page' && /Activity/.test(ep.name))
    );
    assert.equal(activityEntries.length, 3, 'exactly 3 activity entry points, not more/fewer');

    const launcher = activityEntries.find(ep => ep.metadata?.is_launcher === true);
    assert.ok(launcher, 'the MAIN/LAUNCHER activity is flagged is_launcher');
    assert.equal(launcher!.name, 'Android Activity: MainActivity');
    assert.equal(activityEntries.filter(ep => ep.metadata?.is_launcher === true).length, 1, 'only one launcher');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Application subclass yields exactly 1 lifecycle entry point (manifest + structural)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kotlin-analyzer-test-'));
  try {
    writeFile(dir, 'app/src/main/java/com/example/NodeApp.kt', [
      'package com.example',
      '',
      'import android.app.Application',
      '',
      'class NodeApp : Application() {',
      '}',
      '',
    ].join('\n'));
    writeFile(dir, 'app/src/main/AndroidManifest.xml', [
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example">',
      '  <application android:name=".NodeApp">',
      '  </application>',
      '</manifest>',
      '',
    ].join('\n'));

    const analyzer = new KotlinAnalyzer();
    const cas = await analyzer.analyze({ projectPath: dir });
    const appEntries = (cas.entry_points || []).filter(ep => ep.name === 'Android Application: NodeApp');
    assert.equal(appEntries.length, 1, 'exactly one Application entry point, not double-counted');
    assert.equal(appEntries[0].type, 'lifecycle');
    assert.equal(appEntries[0].handler?.file, 'app/src/main/java/com/example/NodeApp.kt');
    assert.ok(appEntries[0].handler?.line, 'handler.line is populated');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Service and BroadcastReceiver declared in BOTH manifest and source yield 1 each (no double-count)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kotlin-analyzer-test-'));
  try {
    writeFile(dir, 'app/src/main/java/com/example/SyncService.kt', [
      'package com.example',
      '',
      'import android.app.Service',
      '',
      'class SyncService : Service() {',
      '}',
      '',
    ].join('\n'));
    writeFile(dir, 'app/src/main/java/com/example/BootReceiver.kt', [
      'package com.example',
      '',
      'import android.content.BroadcastReceiver',
      '',
      'class BootReceiver : BroadcastReceiver() {',
      '}',
      '',
    ].join('\n'));
    writeFile(dir, 'app/src/main/AndroidManifest.xml', [
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example">',
      '  <application>',
      '    <service android:name=".SyncService" />',
      '    <receiver android:name=".BootReceiver" />',
      '  </application>',
      '</manifest>',
      '',
    ].join('\n'));

    const analyzer = new KotlinAnalyzer();
    const cas = await analyzer.analyze({ projectPath: dir });
    const entries = cas.entry_points || [];

    const serviceEntries = entries.filter(ep => /SyncService/.test(ep.name));
    const receiverEntries = entries.filter(ep => /BootReceiver/.test(ep.name));
    assert.equal(serviceEntries.length, 1, 'Service declared in both places yields exactly 1 entry point');
    assert.equal(receiverEntries.length, 1, 'Receiver declared in both places yields exactly 1 entry point');
    assert.equal(serviceEntries[0].type, 'lifecycle');
    assert.equal(receiverEntries[0].type, 'event');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ContentProvider subclass structurally detected as an api entry point', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kotlin-analyzer-test-'));
  try {
    writeFile(dir, 'app/src/main/java/com/example/DataProvider.kt', [
      'package com.example',
      '',
      'import android.content.ContentProvider',
      '',
      'class DataProvider : ContentProvider() {',
      '}',
      '',
    ].join('\n'));

    const analyzer = new KotlinAnalyzer();
    const cas = await analyzer.analyze({ projectPath: dir });
    const entry = (cas.entry_points || []).find(ep => /DataProvider/.test(ep.name));
    assert.ok(entry, 'ContentProvider yields an entry point without a manifest');
    assert.equal(entry!.type, 'api');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('WorkManager Worker subclass yields exactly 1 schedule entry point', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kotlin-analyzer-test-'));
  try {
    writeFile(dir, 'app/src/main/java/com/example/UploadWorker.kt', [
      'package com.example',
      '',
      'import androidx.work.CoroutineWorker',
      '',
      'class UploadWorker : CoroutineWorker() {',
      '}',
      '',
    ].join('\n'));

    const analyzer = new KotlinAnalyzer();
    const cas = await analyzer.analyze({ projectPath: dir });
    const workerEntries = (cas.entry_points || []).filter(ep => /UploadWorker/.test(ep.name));
    assert.equal(workerEntries.length, 1, 'exactly one entry point for the Worker subclass');
    assert.equal(workerEntries[0].type, 'schedule');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('NavHost with 3 composable("...") calls yields 3 route entry points', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kotlin-analyzer-test-'));
  try {
    writeFile(dir, 'app/src/main/java/com/example/AppNav.kt', [
      'package com.example',
      '',
      'import androidx.compose.runtime.Composable',
      'import androidx.navigation.compose.NavHost',
      'import androidx.navigation.compose.composable',
      '',
      '@Composable',
      'fun AppNavHost(navController: NavHostController) {',
      '    NavHost(navController = navController, startDestination = "home") {',
      '        composable("home") { HomeScreen() }',
      '        composable("profile/{id}") { ProfileScreen() }',
      '        composable("settings") { SettingsScreen() }',
      '    }',
      '}',
      '',
    ].join('\n'));

    const analyzer = new KotlinAnalyzer();
    const cas = await analyzer.analyze({ projectPath: dir });
    const routeEntries = (cas.entry_points || []).filter(ep => ep.type === 'route');
    assert.equal(routeEntries.length, 3, 'exactly 3 Compose Navigation destinations');
    const routes = routeEntries.map(ep => ep.metadata?.route).sort();
    assert.deepEqual(routes, ['home', 'profile/{id}', 'settings']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a file with 10 plain @Composable functions and no NavHost yields 0 route entries (no over-detection)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kotlin-analyzer-test-'));
  try {
    const lines = ['package com.example', '', 'import androidx.compose.runtime.Composable', ''];
    for (let i = 0; i < 10; i++) {
      lines.push('@Composable', `fun Screen${i}() {}`, '');
    }
    writeFile(dir, 'app/src/main/java/com/example/Screens.kt', lines.join('\n'));

    const analyzer = new KotlinAnalyzer();
    const cas = await analyzer.analyze({ projectPath: dir });
    const composeFnNodes = cas.nodes.filter(n => n.tags?.includes('compose-fn'));
    assert.equal(composeFnNodes.length, 10, 'all 10 @Composable functions are still parsed as nodes');
    const routeEntries = (cas.entry_points || []).filter(ep => ep.type === 'route');
    assert.equal(routeEntries.length, 0, 'no route entry points fabricated absent a NavHost');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
