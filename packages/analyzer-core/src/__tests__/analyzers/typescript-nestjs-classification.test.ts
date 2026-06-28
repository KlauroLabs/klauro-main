import { parse } from '@typescript-eslint/typescript-estree';
import { TypeScriptJavaScriptAnalyzer } from '../../analyzer/languages/typescript-javascript-analyzer';
import { NestJSAnalyzer } from '../../analyzer/frameworks/web/nestjs-analyzer';
import { TreeSitterTSExtractor } from '../../analyzer/core/tree-sitter-ts-extractor';

describe('TypeScript and NestJS class classification', () => {
  it('classifies DTO-like classes as DTOs even inside controller paths', () => {
    const analyzer = new TypeScriptJavaScriptAnalyzer() as any;

    const dtoType = analyzer.determineClassType(
      {
        name: 'MFAEnrollmentDto',
        decorators: [{ name: 'ApiProperty' }],
        implements: [],
      },
      'src/auth/controllers/mfa-enrollment.dto.ts',
    );

    expect(dtoType).toBe('dto');
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
    const extractor = new TreeSitterTSExtractor();
    const extraction = extractor.extractFromSource(source, 'src/types/invoice-dto.ts');
    const analyzer = new TypeScriptJavaScriptAnalyzer() as any;
    const invoice = extraction.classes.find((item: any) => item.name === 'InvoiceDto');
    const wallet = extraction.classes.find((item: any) => item.name === 'WalletResponse');

    expect(invoice).toEqual(expect.objectContaining({ kind: 'interface' }));
    expect(wallet).toEqual(expect.objectContaining({ kind: 'type' }));
    expect(invoice!.properties.map((item: any) => item.name).sort()).toEqual(['id', 'status', 'totalCents']);
    expect(wallet!.properties.map((item: any) => item.name).sort()).toEqual(['balanceCents', 'id']);
    expect(analyzer.determineClassTypeFromExtraction(invoice, 'src/types/invoice-dto.ts')).toBe('dto');
    expect(analyzer.determineClassTypeFromExtraction(wallet, 'src/types/invoice-dto.ts')).toBe('dto');
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
