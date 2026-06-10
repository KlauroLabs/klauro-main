import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { discoverRealRepos } from './repo-discovery';

test('repo discovery marks package repos with missing script source as unsupported', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-repo-discovery-'));
  const repo = path.join(root, 'missing-source-bot');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'constants'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'constants/constants.ts'), 'export const RPC_ENDPOINT = process.env.RPC_ENDPOINT;\n');
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({
    scripts: {
      start: 'ts-node ./src/executeBot.ts',
      arbitrage: 'ts-node ./src/arbitrageBot.ts',
      gather: 'ts-node ./src/gather.ts',
    },
  }));

  try {
    const report = await discoverRealRepos(root);
    const found = report.repos.find(item => item.path === repo);
    assert.equal(found?.status, 'unsupported');
    assert.match(found?.reason || '', /missing source files/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('repo discovery treats Terraform infrastructure repos as eligible source repos', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-repo-discovery-terraform-'));
  const repo = path.join(root, 'system-infra');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.terraform', 'providers'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'main.tf'), `
provider "aws" {
  region = "us-east-1"
}

resource "aws_s3_bucket" "analysis_artifacts" {
  bucket = "klauro-analysis-artifacts"
}
`);
  fs.writeFileSync(path.join(repo, '.terraform', 'providers', 'generated.tf'), `
resource "aws_s3_bucket" "ignored_cache" {
  bucket = "generated-cache"
}
`);

  try {
    const report = await discoverRealRepos(root);
    const found = report.repos.find(item => item.path === repo);
    assert.equal(found?.status, 'eligible');
    assert.deepEqual(found?.languages, ['Terraform']);
    assert.equal(found?.source_files, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
