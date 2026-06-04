import { parse } from '@typescript-eslint/typescript-estree';
import { TypeScriptJavaScriptAnalyzer } from '../../analyzer/languages/typescript-javascript-analyzer';
import { NestJSAnalyzer } from '../../analyzer/frameworks/web/nestjs-analyzer';

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
