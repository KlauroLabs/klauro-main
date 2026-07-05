jest.unmock('fs');
jest.unmock('fs-extra');
jest.unmock('glob');

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { ValidationSchemaAnalyzer } from '../../analyzer/libraries/architecture/validation-schema-analyzer';
import { CASContribution, CASNode } from '../../types/cas.types';

describe('ValidationSchemaAnalyzer', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-validation-schema-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function analyzeProject(
    manifests: Record<string, unknown | string>,
    files: Record<string, string>
  ): Promise<CASContribution> {
    for (const [relativePath, content] of Object.entries(manifests)) {
      const fullPath = path.join(tempDir, relativePath);
      await fs.ensureDir(path.dirname(fullPath));
      if (typeof content === 'string') {
        await fs.writeFile(fullPath, content);
      } else {
        await fs.writeJson(fullPath, content);
      }
    }
    for (const [relativePath, content] of Object.entries(files)) {
      const fullPath = path.join(tempDir, relativePath);
      await fs.ensureDir(path.dirname(fullPath));
      await fs.writeFile(fullPath, content);
    }
    const analyzer = new ValidationSchemaAnalyzer();
    return analyzer.analyze({ projectPath: tempDir } as any);
  }

  function contractNodes(contribution: CASContribution): CASNode[] {
    return (contribution.nodes || []).filter(node => node.type === 'validation_contract');
  }

  function contract(contribution: CASContribution, name: string): CASNode {
    const found = contractNodes(contribution).find(node => node.name === name);
    expect(found).toBeDefined();
    return found!;
  }

  it('extracts Zod schemas and links parse usage to a route-like handler', async () => {
    const contribution = await analyzeProject(
      { 'package.json': { dependencies: { zod: '^3.23.0', express: '^4.18.0' } } },
      {
        'src/routes/users.ts': [
          "import { z } from 'zod';",
          "import express from 'express';",
          'const router = express.Router();',
          'export const CreateUserSchema = z.object({',
          '  email: z.string().email(),',
          '  age: z.number().optional(),',
          '});',
          "router.post('/users', async function createUser(req, res) {",
          '  const input = CreateUserSchema.parse(req.body);',
          '  res.json(input);',
          '});',
        ].join('\n'),
      }
    );

    const node = contract(contribution, 'CreateUserSchema');
    expect(node.metadata?.attributes?.library).toBe('zod');
    expect(node.metadata?.attributes?.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'email', type: 'string', required: true }),
      expect.objectContaining({ name: 'age', type: 'number', required: false }),
    ]));
    expect(contribution.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'validates_input_for' }),
    ]));
  });

  it('extracts Yup, Joi, and Ajv/JSON Schema contracts from import-gated files', async () => {
    const contribution = await analyzeProject(
      {
        'package.json': {
          dependencies: {
            yup: '^1.4.0',
            joi: '^17.12.0',
            ajv: '^8.12.0',
          },
        },
      },
      {
        'src/contracts.ts': [
          "import * as yup from 'yup';",
          "import Joi from 'joi';",
          "import Ajv from 'ajv';",
          'const ajv = new Ajv();',
          'export const ProfileSchema = yup.object().shape({',
          '  displayName: yup.string().required(),',
          '  newsletter: yup.boolean(),',
          '});',
          'export const SearchSchema = Joi.object({',
          '  q: Joi.string().min(2).required(),',
          '  page: Joi.number().optional(),',
          '});',
          'export const JsonUserSchema = {',
          "  type: 'object',",
          '  properties: {',
          "    id: { type: 'string' },",
          "    score: { type: 'number', minimum: 0 },",
          '  },',
          "  required: ['id'],",
          '};',
          'ajv.compile(JsonUserSchema);',
        ].join('\n'),
      }
    );

    expect(contract(contribution, 'ProfileSchema').metadata?.attributes?.library).toBe('yup');
    expect(contract(contribution, 'SearchSchema').metadata?.attributes?.library).toBe('joi');
    const json = contract(contribution, 'JsonUserSchema');
    expect(json.metadata?.attributes?.library).toBe('ajv');
    expect(json.metadata?.attributes?.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'id', type: 'string', required: true }),
      expect.objectContaining({ name: 'score', type: 'number', required: false }),
    ]));
  });

  it('extracts class-validator DTO fields and handler parameter usage', async () => {
    const contribution = await analyzeProject(
      { 'package.json': { dependencies: { 'class-validator': '^0.14.0', '@nestjs/common': '^10.0.0' } } },
      {
        'src/users.controller.ts': [
          "import { Body, Controller, Post } from '@nestjs/common';",
          "import { IsEmail, IsOptional, IsString } from 'class-validator';",
          'export class CreateUserDto {',
          '  @IsEmail()',
          '  email!: string;',
          '  @IsOptional()',
          '  @IsString()',
          '  name?: string;',
          '}',
          "@Controller('users')",
          'export class UsersController {',
          '  @InternalPost()',
          '  create(@Body() body: CreateUserDto) {',
          '    return body;',
          '  }',
          '}',
        ].join('\n'),
      }
    );

    const dto = contract(contribution, 'CreateUserDto');
    expect(dto.metadata?.attributes?.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'email', type: 'string', required: true }),
      expect.objectContaining({ name: 'name', type: 'string', required: false }),
    ]));
    expect(contribution.edges?.some(edge => edge.type === 'validates_input_for')).toBe(true);
  });

  it('extracts Marshmallow and Cerberus schemas without duplicating Pydantic', async () => {
    const contribution = await analyzeProject(
      { 'requirements.txt': ['marshmallow==3.20.1', 'cerberus==1.3.5'].join('\n') },
      {
        'app/schemas.py': [
          'from marshmallow import Schema, fields',
          'from cerberus import Validator',
          '',
          'class UserSchema(Schema):',
          '    email = fields.Email(required=True)',
          '    age = fields.Int()',
          '',
          'user_rules = {',
          "    'email': {'type': 'string', 'required': True},",
          "    'age': {'type': 'integer', 'min': 0},",
          '}',
          '',
          '@app.post("/users")',
          'def create_user():',
          '    payload = UserSchema().load(request.json)',
          '    Validator().validate(payload, user_rules)',
          '    return payload',
        ].join('\n'),
      }
    );

    expect(contract(contribution, 'UserSchema').metadata?.attributes?.library).toBe('marshmallow');
    const cerberus = contract(contribution, 'user_rules');
    expect(cerberus.metadata?.attributes?.library).toBe('cerberus');
    expect(cerberus.metadata?.attributes?.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'email', type: 'string', required: true }),
      expect.objectContaining({ name: 'age', type: 'integer' }),
    ]));
    expect(contractNodes(contribution).map(node => node.metadata?.attributes?.library)).not.toContain('pydantic');
  });

  it('does not attribute schemas from bare symbols without matching imports', async () => {
    const contribution = await analyzeProject(
      { 'package.json': { dependencies: { zod: '^3.23.0', joi: '^17.12.0' } } },
      {
        'src/local.ts': [
          'const z = { object: (shape: unknown) => shape, string: () => ({}) };',
          'const LocalSchema = z.object({ name: z.string() });',
          'const Joi = { object: (shape: unknown) => shape, string: () => ({}) };',
          'const AnotherSchema = Joi.object({ value: Joi.string() });',
        ].join('\n'),
      }
    );

    expect(contractNodes(contribution)).toHaveLength(0);
  });
});
