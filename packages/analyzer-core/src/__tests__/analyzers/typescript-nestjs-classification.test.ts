jest.unmock('fs');
jest.unmock('fs-extra');
jest.unmock('glob');

import { parse } from '@typescript-eslint/typescript-estree';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { TypeScriptJavaScriptAnalyzer } from '../../analyzer/languages/typescript-javascript-analyzer';
import { NestJSAnalyzer } from '../../analyzer/frameworks/web/nestjs-analyzer';

describe('TypeScript and NestJS class classification', () => {
  let projectPath: string;

  beforeEach(async () => {
    projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-ts-classification-'));
  });

  afterEach(async () => {
    await fs.rm(projectPath, { recursive: true, force: true });
  });

  async function analyzeFile(relativePath: string, source: string) {
    const filePath = path.join(projectPath, relativePath);
    await fs.ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, source);
    return new TypeScriptJavaScriptAnalyzer().analyze({ projectPath } as any);
  }

  it('classifies DTO-like classes as DTOs even inside controller paths', async () => {
    const contribution = await analyzeFile(
      'src/auth/controllers/mfa-enrollment.dto.ts',
      [
        'export class MFAEnrollmentDto {',
        '  @ApiProperty()',
        '  token!: string;',
        '}',
      ].join('\n'),
    );

    expect(contribution.nodes?.find(node => node.name === 'MFAEnrollmentDto')?.type).toBe('dto');
  });

  it('extracts DTO-like TypeScript interfaces and type aliases as data shapes with fields', async () => {
    const source = [
      'export interface InvoiceDto {',
      '  id: string;',
      '  status: "draft" | "paid";',
      '  totalCents: number;',
      '}',
      '',
      'export type WalletResponse = {',
      '  id: string;',
      '  balanceCents: number;',
      '};',
    ].join('\n');
    const contribution = await analyzeFile('src/types/invoice-dto.ts', source);
    const invoice = contribution.nodes?.find(node => node.name === 'InvoiceDto');
    const wallet = contribution.nodes?.find(node => node.name === 'WalletResponse');
    const properties = contribution.nodes?.filter(node => node.type === 'property').map(node => node.name).sort();

    expect(invoice?.type).toBe('dto');
    expect(wallet?.type).toBe('dto');
    expect(properties).toEqual(['balanceCents', 'id', 'id', 'status', 'totalCents']);
  });

  it('only treats controller-file classes as controllers when the class itself is controller-like', () => {
    const analyzer = new NestJSAnalyzer() as any;
    const ast = parse(
      [
        'class MFAEnrollmentDto {',
        '  @ApiProperty()',
        '  token!: string;',
        '}',
        '',
        '@Controller("auth")',
        'class AuthController {',
        '  @Post("mfa")',
        '  enroll() {}',
        '}',
      ].join('\n'),
      {
        loc: true,
        range: true,
        decorators: true,
        sourceType: 'module',
      },
    );

    const controller = analyzer.extractControllerInfo(ast, 'src/auth/controllers/auth.controller.ts');

    expect(controller?.name).toBe('AuthController');
    expect(controller?.name).not.toBe('MFAEnrollmentDto');
  });
});
