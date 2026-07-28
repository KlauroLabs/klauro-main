import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

test('streaming upload materially lowers cold-package peak RSS', () => {
  const legacy = measure('legacy', 'cold');
  const streaming = measure('streaming', 'cold');
  console.log(JSON.stringify({ legacy, streaming, reduction_percent: Math.round((1 - streaming.peak_delta_bytes / legacy.peak_delta_bytes) * 1000) / 10 }));
  assert.equal(streaming.source_bytes, legacy.source_bytes);
  assert.ok(streaming.peak_delta_bytes < legacy.peak_delta_bytes * 0.45,
    `streaming ${(streaming.peak_delta_bytes / 1048576).toFixed(1)} MiB vs legacy ${(legacy.peak_delta_bytes / 1048576).toFixed(1)} MiB`);
  assert.ok(streaming.peak_delta_bytes < 96 * 1024 * 1024,
    `streaming peak delta ${(streaming.peak_delta_bytes / 1048576).toFixed(1)} MiB exceeds bounded-memory target`);
});

test('streaming upload materially lowers incremental-package peak RSS', () => {
  const legacy = measure('legacy', 'incremental');
  const streaming = measure('streaming', 'incremental');
  console.log(JSON.stringify({ incremental_legacy: legacy, incremental_streaming: streaming, reduction_percent: Math.round((1 - streaming.peak_delta_bytes / legacy.peak_delta_bytes) * 1000) / 10 }));
  assert.equal(streaming.source_bytes, legacy.source_bytes);
  assert.ok(streaming.peak_delta_bytes < legacy.peak_delta_bytes * 0.5,
    `streaming incremental ${(streaming.peak_delta_bytes / 1048576).toFixed(1)} MiB vs legacy ${(legacy.peak_delta_bytes / 1048576).toFixed(1)} MiB`);
  assert.ok(streaming.peak_delta_bytes < 96 * 1024 * 1024);
});

function measure(mode: 'legacy' | 'streaming', scenario: 'cold' | 'incremental'): { source_bytes: number; peak_delta_bytes: number } {
  const script = `
    import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
    import { gzipSync } from 'node:zlib'; import { execFileSync } from 'node:child_process';
    const remoteModule=await import('./src/remote-source.ts'); const remote=remoteModule.default||remoteModule;
    const uploadModule=await import('./src/streaming-source-upload.ts'); const upload=uploadModule.default||uploadModule;
    const {buildSourceSnapshot,buildStreamingSourceSnapshot,buildWorkingTreeChangeContext,buildStreamingWorkingTreeChanges}=remote;
    const {createAnalyzeUploadRequest,createIncrementalUploadRequest}=upload;
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'klauro-memory-'));
    if (${JSON.stringify(scenario)}==='incremental') execFileSync('git',['init','-q'],{cwd:root});
    const content='export const payload = "'+'x'.repeat(768*1024-32)+'";\\n';
    for(let i=0;i<160;i++) fs.writeFileSync(path.join(root,'file-'+String(i).padStart(4,'0')+'.ts'),content);
    global.gc(); const baseline=process.memoryUsage().rss; const sourceBytes=160*Buffer.byteLength(content);
    if (${JSON.stringify(mode)}==='legacy') {
      const snapshot=${JSON.stringify(scenario)}==='cold' ? await buildSourceSnapshot(root) : await buildWorkingTreeChangeContext(root);
      const json=Buffer.from(JSON.stringify(${JSON.stringify(scenario)}==='cold' ? {project_id:'p',project_path:root,snapshot,async:true} : {analysis_id:'a',project_id:'p',project_path:root,changes:snapshot,async:true}));
      gzipSync(json); globalThis.__hold=[snapshot,json];
    } else {
      const snapshot=${JSON.stringify(scenario)}==='cold' ? await buildStreamingSourceSnapshot(root) : await buildStreamingWorkingTreeChanges(root);
      const request=${JSON.stringify(scenario)}==='cold' ? createAnalyzeUploadRequest({project_id:'p',project_path:root,snapshot,async:true}) : createIncrementalUploadRequest({analysis_id:'a',project_id:'p',project_path:root,changes:snapshot,async:true});
      await request.prepare(); await request.dispose();
    }
    const peak=process.resourceUsage().maxRSS*1024;
    fs.rmSync(root,{recursive:true,force:true});
    console.log(JSON.stringify({source_bytes:sourceBytes,peak_delta_bytes:Math.max(0,peak-baseline)}));
  `;
  const output = execFileSync(process.execPath, ['--expose-gc', '--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(output.trim().split('\n').pop()!);
}
