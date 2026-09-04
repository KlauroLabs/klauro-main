import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DartAnalyzer } from './dart-analyzer';

test('DartAnalyzer resolves the nearest nested pubspec for Flutter lifecycle classification', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dart-nested-flutter-'));
  try {
    const app = path.join(root, 'apps', 'mobile');
    fs.mkdirSync(path.join(app, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(app, 'pubspec.yaml'), [
      'name: nested_flutter',
      'dependencies:',
      '  flutter:',
      '    sdk: flutter',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(app, 'lib', 'main.dart'), [
      "import 'package:flutter/material.dart';",
      'void main() => runApp(const MaterialApp());',
      '',
    ].join('\n'));

    const contribution = await new DartAnalyzer().analyze({ projectPath: root });
    const main = contribution.entry_points.find(entry => entry.name === 'Flutter application start');
    assert.ok(main);
    assert.equal(main.type, 'lifecycle');
    assert.equal(main.metadata?.framework, 'flutter');
    assert.equal(contribution.entry_points.some(entry => entry.type === 'cli'), false);
    assert.equal(contribution.analyzer_metadata.framework_specific?.framework, 'flutter');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test('DartAnalyzer records library-private and public function visibility', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dart-function-visibility-'));
  try {
    fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(root, 'pubspec.yaml'), 'name: visibility_fixture\n');
    fs.writeFileSync(path.join(root, 'lib', 'helpers.dart'), [
      'int _internalValue() => 1;',
      'int publicValue() => _internalValue();',
      '',
    ].join('\n'));

    const contribution = await new DartAnalyzer().analyze({ projectPath: root });
    const privateFunction = contribution.nodes.find(node => node.name === '_internalValue');
    const publicFunction = contribution.nodes.find(node => node.name === 'publicValue');
    assert.equal(privateFunction?.metadata?.access_modifier, 'private');
    assert.equal(privateFunction?.metadata?.is_exported, false);
    assert.equal(publicFunction?.metadata?.access_modifier, 'public');
    assert.equal(publicFunction?.metadata?.is_exported, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
