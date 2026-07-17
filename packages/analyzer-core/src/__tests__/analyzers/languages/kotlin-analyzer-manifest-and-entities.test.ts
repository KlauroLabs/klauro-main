jest.unmock('glob');
jest.unmock('fs');
jest.unmock('fs-extra');

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { KotlinAnalyzer } from '../../../analyzer/languages/kotlin-analyzer';

/**
 * Regression coverage for two live defects found on a Kotlin/Compose Android
 * CAS: (1) entry_points only ever surfaced the launcher Activity — a manifest
 * declaring a <service>/<receiver>/<provider> produced zero entries for them;
 * (2) data_entities was always empty because Kotlin `data class` DTOs never
 * emitted property nodes, so the orchestrator's generic entity derivation had
 * no field evidence to anchor on even where a class did qualify.
 */
describe('KotlinAnalyzer: AndroidManifest.xml component entry points', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kotlin-manifest-'));
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  async function writeFile(relPath: string, content: string): Promise<void> {
    const full = path.join(tmpDir, relPath);
    await fs.ensureDir(path.dirname(full));
    await fs.writeFile(full, content, 'utf-8');
  }

  it('emits a resolved entry point for each manifest-declared activity/service/receiver/provider, including relative-name resolution', async () => {
    await writeFile(
      'src/main/AndroidManifest.xml',
      [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.app">',
        '    <application android:label="Example">',
        '        <activity android:name=".MainActivity" />',
        '        <service android:name="com.example.app.SyncService" />',
        '        <receiver android:name=".BootReceiver">',
        '            <intent-filter>',
        '                <action android:name="android.intent.action.BOOT_COMPLETED" />',
        '            </intent-filter>',
        '        </receiver>',
        '        <provider android:name=".MessageProvider" android:authorities="com.example.app.provider" />',
        '    </application>',
        '</manifest>',
        '',
      ].join('\n')
    );

    await writeFile(
      'src/main/kotlin/com/example/app/MainActivity.kt',
      [
        'package com.example.app',
        '',
        'import androidx.activity.ComponentActivity',
        '',
        'class MainActivity : ComponentActivity() {',
        '    fun onReady() {}',
        '}',
        '',
      ].join('\n')
    );

    await writeFile(
      'src/main/kotlin/com/example/app/SyncService.kt',
      [
        'package com.example.app',
        '',
        'import android.app.Service',
        '',
        'class SyncService : Service() {',
        '    fun sync() {}',
        '}',
        '',
      ].join('\n')
    );

    await writeFile(
      'src/main/kotlin/com/example/app/BootReceiver.kt',
      [
        'package com.example.app',
        '',
        'import android.content.BroadcastReceiver',
        '',
        'class BootReceiver : BroadcastReceiver() {',
        '    fun onBoot() {}',
        '}',
        '',
      ].join('\n')
    );

    await writeFile(
      'src/main/kotlin/com/example/app/MessageProvider.kt',
      [
        'package com.example.app',
        '',
        'import android.content.ContentProvider',
        '',
        'class MessageProvider : ContentProvider() {',
        '    fun query() {}',
        '}',
        '',
      ].join('\n')
    );

    const analyzer = new KotlinAnalyzer();
    const contribution = await analyzer.analyze({ projectPath: tmpDir } as any);
    const entryPoints = contribution.entry_points || [];

    const byName = (n: string) => entryPoints.find(ep => ep.name.includes(n));

    const activityEntry = byName('MainActivity');
    const serviceEntry = byName('SyncService');
    const receiverEntry = byName('BootReceiver');
    const providerEntry = byName('MessageProvider');

    expect(activityEntry).toBeTruthy();
    expect(serviceEntry).toBeTruthy();
    expect(receiverEntry).toBeTruthy();
    expect(providerEntry).toBeTruthy();

    expect(activityEntry!.type).toBe('page');
    expect(serviceEntry!.type).toBe('lifecycle');
    expect(receiverEntry!.type).toBe('event');
    expect(providerEntry!.type).toBe('api');

    // Only ONE entry point per class (no duplicate from both the supertype
    // check and the manifest pass for MainActivity).
    expect(entryPoints.filter(ep => ep.name.includes('MainActivity')).length).toBe(1);

    // Relative name resolution: `.MainActivity` / `.BootReceiver` / `.MessageProvider`
    // all resolved against the manifest package to the real class file/line.
    expect(activityEntry!.metadata?.file).toContain('MainActivity.kt');
    expect(receiverEntry!.metadata?.actions).toEqual(['android.intent.action.BOOT_COMPLETED']);
  });

  it('skips an unresolvable manifest component without fabricating a phantom entry point', async () => {
    await writeFile(
      'src/main/AndroidManifest.xml',
      [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.app">',
        '    <application>',
        '        <service android:name=".GhostService" />',
        '    </application>',
        '</manifest>',
        '',
      ].join('\n')
    );
    // No GhostService.kt anywhere in the project.
    await writeFile(
      'src/main/kotlin/com/example/app/Unrelated.kt',
      ['package com.example.app', '', 'class Unrelated', ''].join('\n')
    );

    const analyzer = new KotlinAnalyzer();
    const contribution = await analyzer.analyze({ projectPath: tmpDir } as any);
    const entryPoints = contribution.entry_points || [];

    expect(entryPoints.some(ep => ep.name.includes('Ghost'))).toBe(false);
  });
});

describe('KotlinAnalyzer: data class -> data-entity fields', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kotlin-data-entities-'));
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  async function writeFile(relPath: string, content: string): Promise<void> {
    const full = path.join(tmpDir, relPath);
    await fs.ensureDir(path.dirname(full));
    await fs.writeFile(full, content, 'utf-8');
  }

  it('emits a dto node + property nodes with fields for a qualifying data class', async () => {
    await writeFile(
      'src/main/kotlin/com/example/app/model/Session.kt',
      [
        'package com.example.app.model',
        '',
        'import kotlinx.serialization.Serializable',
        'import kotlinx.serialization.SerialName',
        '',
        '@Serializable',
        'data class Session(',
        '    val id: String,',
        '    @SerialName("expires_at") val expiresAt: Long,',
        '    val userId: String',
        ')',
        '',
      ].join('\n')
    );

    const analyzer = new KotlinAnalyzer();
    const contribution = await analyzer.analyze({ projectPath: tmpDir } as any);

    const sessionNode = (contribution.nodes || []).find(n => n.name === 'Session');
    expect(sessionNode).toBeTruthy();
    expect(sessionNode!.type).toBe('dto');

    const fieldNodes = (contribution.nodes || []).filter(n => n.parent === sessionNode!.id && n.type === 'property');
    expect(fieldNodes.map(n => n.name).sort()).toEqual(['expiresAt', 'id', 'userId']);

    const expiresAt = fieldNodes.find(n => n.name === 'expiresAt')!;
    expect(expiresAt.signature?.return_type).toBe('Long');
    expect((expiresAt.metadata?.attributes as any)?.serialization).toContain('SerialName');

    const containsEdge = (contribution.edges || []).find(e =>
      e.source === sessionNode!.id && e.target === fieldNodes[0].id && e.type === 'contains'
    );
    expect(containsEdge).toBeTruthy();
  });

  it('excludes a single-property wrapper data class', async () => {
    await writeFile(
      'src/main/kotlin/com/example/app/model/UserId.kt',
      ['package com.example.app.model', '', 'data class UserId(val value: String)', ''].join('\n')
    );

    const analyzer = new KotlinAnalyzer();
    const contribution = await analyzer.analyze({ projectPath: tmpDir } as any);
    const node = (contribution.nodes || []).find(n => n.name === 'UserId');
    expect(node!.type).toBe('class');
    expect((contribution.nodes || []).some(n => n.parent === node!.id && n.type === 'property')).toBe(false);
  });

  it('excludes a Compose theme data class (ui/theme package, Compose-only field types)', async () => {
    await writeFile(
      'src/main/kotlin/com/example/app/ui/theme/AppColors.kt',
      [
        'package com.example.app.ui.theme',
        '',
        'import androidx.compose.ui.graphics.Color',
        '',
        'data class AppColors(',
        '    val primary: Color,',
        '    val secondary: Color',
        ')',
        '',
      ].join('\n')
    );

    const analyzer = new KotlinAnalyzer();
    const contribution = await analyzer.analyze({ projectPath: tmpDir } as any);
    const node = (contribution.nodes || []).find(n => n.name === 'AppColors');
    expect(node!.type).toBe('class');
    expect((contribution.nodes || []).some(n => n.parent === node!.id && n.type === 'property')).toBe(false);
  });
});
