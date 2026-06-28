import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { TerraformAnalyzer } from '../../../analyzer/languages/terraform-analyzer';

describe('TerraformAnalyzer', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-terraform-analyzer-'));
  });

  afterEach(async () => {
    await fs.remove(tempDir);
  });

  it('classifies environment overlays, backend configs, and saved plans as infrastructure facts', async () => {
    await fs.ensureDir(path.join(tempDir, 'environments'));
    await fs.writeFile(path.join(tempDir, 'main.tf'), [
      'provider "aws" {',
      '  region = var.aws_region',
      '}',
      '',
      'module "api" {',
      '  source = "./modules/api"',
      '}',
    ].join('\n'));
    await fs.writeFile(path.join(tempDir, 'environments', 'demo.tfvars'), 'environment = "demo"\naws_region = "us-west-2"\n');
    await fs.writeFile(path.join(tempDir, 'environments', 'internal.conf'), 'bucket = "zerac-internal-terraform-state"\n');
    await fs.writeFile(path.join(tempDir, 'environments', 'production.tfvars'), 'environment = "production"\n');
    await fs.writeFile(path.join(tempDir, 'staging.tfplan'), Buffer.from([0x50, 0x4b, 0x03, 0x04]));

    const analyzer = new TerraformAnalyzer();
    const result = await analyzer.analyze({
      projectPath: tempDir,
      options: {},
      cache: new Map(),
      metadata: {},
    } as any);

    const nodes = result.nodes || [];
    const entryPoints = result.entry_points || [];
    const overlays = nodes.filter(node =>
      ['environments/demo.tfvars', 'environments/internal.conf', 'environments/production.tfvars', 'staging.tfplan']
        .includes(node.source?.file || '')
    );
    const environments = new Set(overlays.map(node => (node.metadata as any)?.environment));

    expect(environments).toEqual(new Set(['demo', 'internal', 'production', 'staging']));
    expect(overlays.find(node => node.source?.file === 'environments/internal.conf')?.type).toBe('infrastructure_file');
    expect(overlays.find(node => node.source?.file === 'staging.tfplan')?.type).toBe('infrastructure_plan');
    expect(entryPoints.some(entry => entry.name === 'Terraform plan staging.tfplan')).toBe(true);
  });
});
