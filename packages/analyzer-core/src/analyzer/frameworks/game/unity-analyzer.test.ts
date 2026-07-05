import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { UnityAnalyzer } from './unity-analyzer';

function makeTempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unity-analyzer-test-'));
  fs.mkdirSync(path.join(dir, 'ProjectSettings'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 2022.3.10f1\n');

  const player = [
    'using UnityEngine;',
    '',
    'public class Player : MonoBehaviour',
    '{',
    '    [SerializeField] private float speed = 5f;',
    '',
    '    void Awake() {',
    '        Debug.Log("awake");',
    '    }',
    '',
    '    void Update() {',
    '        transform.Translate(Vector3.forward * speed * Time.deltaTime);',
    '    }',
    '',
    '    void OnCollisionEnter(Collision collision) {',
    '        Debug.Log("hit " + collision.gameObject.name);',
    '    }',
    '}',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'Player.cs'), player);

  return dir;
}

test('UnityAnalyzer canAnalyze detects a Unity project', async () => {
  const dir = makeTempProject();
  const analyzer = new UnityAnalyzer();
  assert.equal(await analyzer.canAnalyze(dir), true);
});

test('UnityAnalyzer surfaces MonoBehaviour lifecycle hooks and collision callback as lifecycle entry points', async () => {
  const dir = makeTempProject();
  const analyzer = new UnityAnalyzer();
  const cas = await analyzer.analyze({ projectPath: dir });

  const entryPoints = cas.entry_points || [];
  const hookNames = entryPoints.map(ep => ep.metadata?.hook);
  assert.ok(hookNames.includes('Awake'), 'expected Awake lifecycle entry point');
  assert.ok(hookNames.includes('Update'), 'expected Update lifecycle entry point');
  assert.ok(hookNames.includes('OnCollisionEnter'), 'expected OnCollisionEnter entry point');
  assert.ok(entryPoints.every(ep => ep.type === 'lifecycle'), 'all Unity entry points should be type lifecycle');

  const classNode = (cas.nodes || []).find(n => n.type === 'class' && n.name === 'Player');
  assert.ok(classNode, 'expected Player class node');
  assert.deepEqual(classNode?.metadata?.attributes?.serialize_fields, ['speed']);
});
