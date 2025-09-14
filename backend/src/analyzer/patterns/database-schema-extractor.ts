/**
 * Database Schema Extractor
 * Extracts database schemas from various ORM definitions, SQL files, and migrations
 * Supports: Prisma, TypeORM, Sequelize, Mongoose, Django ORM, SQLAlchemy, raw SQL
 */

import { parse, TSESTree } from '@typescript-eslint/typescript-estree';
import * as path from 'path';
import * as fs from 'fs-extra';
import { spawn } from 'child_process';
import { ComponentNode } from '../../types';

export interface DatabaseSchema {
  tables: TableSchema[];
  relationships: RelationshipSchema[];
  indexes: IndexSchema[];
  enums: EnumSchema[];
  views: ViewSchema[];
  storedProcedures: StoredProcedureSchema[];
  triggers: TriggerSchema[];
  constraints: ConstraintSchema[];
  dbType: 'postgresql' | 'mysql' | 'mongodb' | 'sqlite' | 'mssql' | 'oracle' | 'dynamodb' | 'redis';
  ormType?: 'prisma' | 'typeorm' | 'sequelize' | 'mongoose' | 'django' | 'sqlalchemy' | 'mikro-orm' | 'raw-sql';
}

export interface TableSchema {
  name: string;
  columns: ColumnSchema[];
  primaryKey?: string[];
  uniqueKeys?: string[][];
  indexes?: string[];
  timestamps?: boolean;
  softDelete?: boolean;
  tablespace?: string;
  comment?: string;
  engine?: string; // MySQL specific
  collation?: string;
  charset?: string;
}

export interface ColumnSchema {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue?: any;
  primaryKey?: boolean;
  unique?: boolean;
  autoIncrement?: boolean;
  generated?: 'always' | 'by default';
  references?: {
    table: string;
    column: string;
    onDelete?: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
    onUpdate?: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
  };
  check?: string;
  comment?: string;
  length?: number;
  precision?: number;
  scale?: number;
  enumValues?: string[];
}

export interface RelationshipSchema {
  name: string;
  type: 'one-to-one' | 'one-to-many' | 'many-to-one' | 'many-to-many';
  from: {
    table: string;
    column: string;
  };
  to: {
    table: string;
    column: string;
  };
  through?: {
    table: string;
    fromColumn: string;
    toColumn: string;
  };
  onDelete?: string;
  onUpdate?: string;
  eager?: boolean;
  lazy?: boolean;
}

export interface IndexSchema {
  name: string;
  table: string;
  columns: string[];
  type?: 'btree' | 'hash' | 'gin' | 'gist' | 'spgist' | 'brin';
  unique?: boolean;
  partial?: string;
  expression?: string;
  concurrent?: boolean;
}

export interface EnumSchema {
  name: string;
  values: string[];
  description?: string;
}

export interface ViewSchema {
  name: string;
  definition: string;
  materialized?: boolean;
  columns?: string[];
}

export interface StoredProcedureSchema {
  name: string;
  parameters: Array<{
    name: string;
    type: string;
    direction: 'IN' | 'OUT' | 'INOUT';
  }>;
  returnType?: string;
  body?: string;
}

export interface TriggerSchema {
  name: string;
  table: string;
  timing: 'BEFORE' | 'AFTER' | 'INSTEAD OF';
  event: 'INSERT' | 'UPDATE' | 'DELETE';
  forEachRow?: boolean;
  condition?: string;
  body?: string;
}

export interface ConstraintSchema {
  name: string;
  table: string;
  type: 'PRIMARY KEY' | 'FOREIGN KEY' | 'UNIQUE' | 'CHECK' | 'EXCLUSION';
  columns?: string[];
  definition?: string;
}

export class DatabaseSchemaExtractor {
  private projectPath: string;
  private schemas: Map<string, DatabaseSchema> = new Map();

  constructor(projectPath: string) {
    this.projectPath = projectPath;
  }

  public async extractSchemas(components: ComponentNode[]): Promise<DatabaseSchema[]> {
    console.log('🗄️ Extracting database schemas from codebase...');
    
    // Look for ORM config files and models
    await this.extractPrismaSchema();
    await this.extractTypeORMSchema(components);
    await this.extractSequelizeSchema(components);
    await this.extractMongooseSchema(components);
    await this.extractDjangoModels(components);
    await this.extractSQLAlchemyModels(components);
    await this.extractMikroORMSchema(components);
    await this.extractRawSQLSchemas();

    const schemas = Array.from(this.schemas.values());
    console.log(`✅ Extracted ${schemas.length} database schemas`);
    
    return schemas;
  }

  // Prisma Schema Extraction
  private async extractPrismaSchema(): Promise<void> {
    const prismaPath = path.join(this.projectPath, 'prisma', 'schema.prisma');
    if (!await fs.pathExists(prismaPath)) return;

    console.log('📦 Found Prisma schema file');
    const content = await fs.readFile(prismaPath, 'utf-8');
    
    const schema: DatabaseSchema = {
      tables: [],
      relationships: [],
      indexes: [],
      enums: [],
      views: [],
      storedProcedures: [],
      triggers: [],
      constraints: [],
      dbType: 'postgresql', // Default, will be overridden by datasource
      ormType: 'prisma'
    };

    // Parse datasource
    const datasourceMatch = content.match(/datasource\s+\w+\s*{[\s\S]*?provider\s*=\s*"([^"]+)"/);
    if (datasourceMatch) {
      schema.dbType = this.mapPrismaProvider(datasourceMatch[1]);
    }

    // Parse enums
    const enumRegex = /enum\s+(\w+)\s*{([^}]+)}/g;
    let enumMatch;
    while ((enumMatch = enumRegex.exec(content)) !== null) {
      const values = enumMatch[2]
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('//'))
        .map(line => line.replace(/[,\s]/g, ''));
      
      schema.enums.push({
        name: enumMatch[1],
        values
      });
    }

    // Parse models
    const modelRegex = /model\s+(\w+)\s*{([^}]+)}/g;
    let modelMatch;
    while ((modelMatch = modelRegex.exec(content)) !== null) {
      const modelName = modelMatch[1];
      const modelBody = modelMatch[2];
      
      const table: TableSchema = {
        name: this.toSnakeCase(modelName),
        columns: [],
        indexes: []
      };

      // Parse fields
      const fieldLines = modelBody.split('\n').filter(line => line.trim() && !line.trim().startsWith('//'));
      for (const line of fieldLines) {
        if (line.includes('@@')) {
          // Model-level attributes
          if (line.includes('@@id')) {
            const idMatch = line.match(/@@id\(\[([^\]]+)\]\)/);
            if (idMatch) {
              table.primaryKey = idMatch[1].split(',').map(f => f.trim());
            }
          } else if (line.includes('@@unique')) {
            const uniqueMatch = line.match(/@@unique\(\[([^\]]+)\]\)/);
            if (uniqueMatch) {
              if (!table.uniqueKeys) table.uniqueKeys = [];
              table.uniqueKeys.push(uniqueMatch[1].split(',').map(f => f.trim()));
            }
          } else if (line.includes('@@index')) {
            const indexMatch = line.match(/@@index\(\[([^\]]+)\]\)/);
            if (indexMatch) {
              const columns = indexMatch[1].split(',').map(f => f.trim());
              schema.indexes.push({
                name: `idx_${table.name}_${columns.join('_')}`,
                table: table.name,
                columns
              });
            }
          }
        } else {
          // Field definitions
          const fieldMatch = line.match(/^\s*(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)?$/);
          if (fieldMatch) {
            const [, fieldName, fieldType, isArray, isOptional, attributes] = fieldMatch;
            
            const column: ColumnSchema = {
              name: this.toSnakeCase(fieldName),
              type: this.mapPrismaType(fieldType),
              nullable: !!isOptional
            };

            // Parse field attributes
            if (attributes) {
              if (attributes.includes('@id')) {
                column.primaryKey = true;
                column.autoIncrement = attributes.includes('@default(autoincrement())');
              }
              if (attributes.includes('@unique')) {
                column.unique = true;
              }
              if (attributes.includes('@default')) {
                const defaultMatch = attributes.match(/@default\(([^)]+)\)/);
                if (defaultMatch) {
                  column.defaultValue = this.parsePrismaDefault(defaultMatch[1]);
                }
              }
              if (attributes.includes('@relation')) {
                // Extract relationship
                const relationMatch = attributes.match(/@relation\([^)]*fields:\s*\[([^\]]+)\][^)]*references:\s*\[([^\]]+)\]/);
                if (relationMatch) {
                  column.references = {
                    table: this.toSnakeCase(fieldType),
                    column: relationMatch[2].trim()
                  };
                  
                  // Add relationship
                  schema.relationships.push({
                    name: `${modelName}_${fieldName}`,
                    type: isArray ? 'one-to-many' : 'many-to-one',
                    from: { table: table.name, column: column.name },
                    to: { table: column.references.table, column: column.references.column }
                  });
                }
              }
            }

            table.columns.push(column);
          }
        }
      }

      schema.tables.push(table);
    }

    this.schemas.set('prisma', schema);
  }

  // TypeORM Schema Extraction
  private async extractTypeORMSchema(components: ComponentNode[]): Promise<void> {
    const entityComponents = components.filter(c => 
      c.path.includes('entity') || 
      c.path.includes('model') ||
      c.metadata.imports?.some(imp => imp.includes('typeorm'))
    );

    if (entityComponents.length === 0) return;

    console.log('🔷 Found TypeORM entities');
    const schema: DatabaseSchema = {
      tables: [],
      relationships: [],
      indexes: [],
      enums: [],
      views: [],
      storedProcedures: [],
      triggers: [],
      constraints: [],
      dbType: 'postgresql',
      ormType: 'typeorm'
    };

    for (const component of entityComponents) {
      const fullPath = path.join(this.projectPath, component.path);
      const content = await fs.readFile(fullPath, 'utf-8');
      
      // Parse with AST
      try {
        const ast = parse(content, {
          loc: false,
          range: false,
          errorOnUnknownASTType: false,
          errorOnTypeScriptSyntacticAndSemanticIssues: false,
          jsx: true
        });

        this.extractTypeORMEntitiesFromAST(ast, schema);
      } catch (error) {
        console.warn(`Failed to parse TypeORM entity ${component.path}:`, error);
      }
    }

    if (schema.tables.length > 0) {
      this.schemas.set('typeorm', schema);
    }
  }

  private extractTypeORMEntitiesFromAST(ast: TSESTree.Program, schema: DatabaseSchema): void {
    // Find @Entity decorated classes
    for (const node of ast.body) {
      if (node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'ClassDeclaration') {
        const classNode = node.declaration;
        const decorators = (classNode as any).decorators || [];
        
        const entityDecorator = decorators.find((d: any) => 
          d.expression?.callee?.name === 'Entity' ||
          d.expression?.type === 'CallExpression' && d.expression.callee?.name === 'Entity'
        );

        if (entityDecorator) {
          const table: TableSchema = {
            name: this.toSnakeCase(classNode.id?.name || 'unknown'),
            columns: []
          };

          // Extract columns from class properties
          for (const member of classNode.body.body) {
            if (member.type === 'PropertyDefinition') {
              const column = this.extractTypeORMColumn(member);
              if (column) {
                table.columns.push(column);
              }
            }
          }

          schema.tables.push(table);
        }
      }
    }
  }

  private extractTypeORMColumn(member: any): ColumnSchema | null {
    const decorators = member.decorators || [];
    const columnDecorator = decorators.find((d: any) => 
      d.expression?.callee?.name === 'Column' ||
      d.expression?.callee?.name === 'PrimaryColumn' ||
      d.expression?.callee?.name === 'PrimaryGeneratedColumn'
    );

    if (!columnDecorator) return null;

    const column: ColumnSchema = {
      name: this.toSnakeCase(member.key?.name || 'unknown'),
      type: 'varchar',
      nullable: false
    };

    // Handle different decorator types
    const decoratorName = columnDecorator.expression?.callee?.name;
    if (decoratorName === 'PrimaryGeneratedColumn') {
      column.primaryKey = true;
      column.autoIncrement = true;
      column.type = 'integer';
    } else if (decoratorName === 'PrimaryColumn') {
      column.primaryKey = true;
    }

    // Extract column options
    if (columnDecorator.expression?.arguments?.[0]) {
      const options = columnDecorator.expression.arguments[0];
      if (options.type === 'ObjectExpression') {
        for (const prop of options.properties) {
          if (prop.type === 'Property') {
            const key = prop.key.type === 'Identifier' ? prop.key.name : '';
            const value = this.extractLiteralValue(prop.value);
            
            switch (key) {
              case 'type':
                column.type = String(value);
                break;
              case 'nullable':
                column.nullable = Boolean(value);
                break;
              case 'unique':
                column.unique = Boolean(value);
                break;
              case 'default':
                column.defaultValue = value;
                break;
              case 'length':
                column.length = Number(value);
                break;
            }
          }
        }
      }
    }

    return column;
  }

  // Sequelize Schema Extraction
  private async extractSequelizeSchema(components: ComponentNode[]): Promise<void> {
    const modelComponents = components.filter(c => 
      c.metadata.imports?.some(imp => imp.includes('sequelize')) ||
      c.path.includes('model')
    );

    if (modelComponents.length === 0) return;

    console.log('🟢 Found Sequelize models');
    const schema: DatabaseSchema = {
      tables: [],
      relationships: [],
      indexes: [],
      enums: [],
      views: [],
      storedProcedures: [],
      triggers: [],
      constraints: [],
      dbType: 'postgresql',
      ormType: 'sequelize'
    };

    for (const component of modelComponents) {
      const fullPath = path.join(this.projectPath, component.path);
      const content = await fs.readFile(fullPath, 'utf-8');
      
      // Extract Sequelize model definitions
      const modelMatch = content.match(/sequelize\.define\s*\(\s*['"`](\w+)['"`]\s*,\s*{([^}]+)}/);
      if (modelMatch) {
        const table: TableSchema = {
          name: this.toSnakeCase(modelMatch[1]),
          columns: []
        };

        // Parse column definitions
        const columnsBody = modelMatch[2];
        const columnRegex = /(\w+)\s*:\s*{([^}]+)}/g;
        let columnMatch;
        
        while ((columnMatch = columnRegex.exec(columnsBody)) !== null) {
          const column: ColumnSchema = {
            name: this.toSnakeCase(columnMatch[1]),
            type: 'varchar',
            nullable: true
          };

          const columnDef = columnMatch[2];
          if (columnDef.includes('DataTypes.STRING')) column.type = 'varchar';
          if (columnDef.includes('DataTypes.INTEGER')) column.type = 'integer';
          if (columnDef.includes('DataTypes.BOOLEAN')) column.type = 'boolean';
          if (columnDef.includes('DataTypes.DATE')) column.type = 'timestamp';
          if (columnDef.includes('DataTypes.TEXT')) column.type = 'text';
          if (columnDef.includes('DataTypes.FLOAT')) column.type = 'float';
          if (columnDef.includes('DataTypes.DECIMAL')) column.type = 'decimal';
          
          if (columnDef.includes('allowNull: false')) column.nullable = false;
          if (columnDef.includes('primaryKey: true')) column.primaryKey = true;
          if (columnDef.includes('unique: true')) column.unique = true;
          if (columnDef.includes('autoIncrement: true')) column.autoIncrement = true;

          table.columns.push(column);
        }

        schema.tables.push(table);
      }
    }

    if (schema.tables.length > 0) {
      this.schemas.set('sequelize', schema);
    }
  }

  // Mongoose Schema Extraction
  private async extractMongooseSchema(components: ComponentNode[]): Promise<void> {
    const schemaComponents = components.filter(c => 
      c.metadata.imports?.some(imp => imp.includes('mongoose')) ||
      c.path.includes('schema') ||
      c.path.includes('model')
    );

    if (schemaComponents.length === 0) return;

    console.log('🍃 Found Mongoose schemas');
    const schema: DatabaseSchema = {
      tables: [], // Collections in MongoDB
      relationships: [],
      indexes: [],
      enums: [],
      views: [],
      storedProcedures: [],
      triggers: [],
      constraints: [],
      dbType: 'mongodb',
      ormType: 'mongoose'
    };

    for (const component of schemaComponents) {
      const fullPath = path.join(this.projectPath, component.path);
      const content = await fs.readFile(fullPath, 'utf-8');
      
      // Extract Mongoose schema definitions
      const schemaMatch = content.match(/new\s+(?:mongoose\.)?Schema\s*\(\s*{([^}]+)}/);
      if (schemaMatch) {
        const modelNameMatch = content.match(/mongoose\.model\s*\(\s*['"`](\w+)['"`]/);
        const table: TableSchema = {
          name: modelNameMatch ? this.toSnakeCase(modelNameMatch[1]) : 'collection',
          columns: []
        };

        // Parse schema fields
        const schemaBody = schemaMatch[1];
        const fieldRegex = /(\w+)\s*:\s*({[^}]+}|\w+)/g;
        let fieldMatch;
        
        while ((fieldMatch = fieldRegex.exec(schemaBody)) !== null) {
          const column: ColumnSchema = {
            name: fieldMatch[1],
            type: 'mixed',
            nullable: true
          };

          const fieldDef = fieldMatch[2];
          if (fieldDef.includes('String')) column.type = 'string';
          if (fieldDef.includes('Number')) column.type = 'number';
          if (fieldDef.includes('Boolean')) column.type = 'boolean';
          if (fieldDef.includes('Date')) column.type = 'date';
          if (fieldDef.includes('ObjectId')) column.type = 'objectid';
          if (fieldDef.includes('Array')) column.type = 'array';
          
          if (fieldDef.includes('required: true')) column.nullable = false;
          if (fieldDef.includes('unique: true')) column.unique = true;

          table.columns.push(column);
        }

        // MongoDB always has _id
        if (!table.columns.find(c => c.name === '_id')) {
          table.columns.unshift({
            name: '_id',
            type: 'objectid',
            nullable: false,
            primaryKey: true
          });
        }

        schema.tables.push(table);
      }
    }

    if (schema.tables.length > 0) {
      this.schemas.set('mongoose', schema);
    }
  }

  // Django Models Extraction (Python)
  private async extractDjangoModels(components: ComponentNode[]): Promise<void> {
    const modelComponents = components.filter(c => 
      c.path.endsWith('.py') && 
      (c.path.includes('models') || c.metadata.imports?.some(imp => imp.includes('django')))
    );

    if (modelComponents.length === 0) return;

    console.log('🐍 Found Django models');
    const schema: DatabaseSchema = {
      tables: [],
      relationships: [],
      indexes: [],
      enums: [],
      views: [],
      storedProcedures: [],
      triggers: [],
      constraints: [],
      dbType: 'postgresql',
      ormType: 'django'
    };

    for (const component of modelComponents) {
      const fullPath = path.join(this.projectPath, component.path);
      const content = await fs.readFile(fullPath, 'utf-8');
      
      // Use Python subprocess to parse Django models
      const pythonScript = `
import ast
import json

def extract_django_models(source_code):
    tree = ast.parse(source_code)
    models = []
    
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef):
            # Check if it inherits from models.Model
            for base in node.bases:
                if (hasattr(base, 'attr') and base.attr == 'Model') or \
                   (hasattr(base, 'id') and base.id == 'Model'):
                    model = {
                        'name': node.name,
                        'fields': []
                    }
                    
                    for item in node.body:
                        if isinstance(item, ast.Assign):
                            for target in item.targets:
                                if hasattr(target, 'id'):
                                    field_name = target.id
                                    field_type = 'unknown'
                                    
                                    if hasattr(item.value, 'func'):
                                        if hasattr(item.value.func, 'attr'):
                                            field_type = item.value.func.attr
                                        elif hasattr(item.value.func, 'id'):
                                            field_type = item.value.func.id
                                    
                                    model['fields'].append({
                                        'name': field_name,
                                        'type': field_type
                                    })
                    
                    models.append(model)
    
    return models

import sys
source = sys.stdin.read()
models = extract_django_models(source)
print(json.dumps(models))
`;

      try {
        const models = await this.executePythonScript(pythonScript, content);
        for (const model of models) {
          const table: TableSchema = {
            name: this.toSnakeCase(model.name),
            columns: []
          };

          // Django always adds id field
          table.columns.push({
            name: 'id',
            type: 'integer',
            nullable: false,
            primaryKey: true,
            autoIncrement: true
          });

          for (const field of model.fields) {
            const column: ColumnSchema = {
              name: this.toSnakeCase(field.name),
              type: this.mapDjangoFieldType(field.type),
              nullable: true
            };

            if (field.type === 'ForeignKey') {
              column.references = {
                table: this.toSnakeCase(field.name),
                column: 'id'
              };
            }

            table.columns.push(column);
          }

          schema.tables.push(table);
        }
      } catch (error) {
        console.warn(`Failed to parse Django models in ${component.path}:`, error);
      }
    }

    if (schema.tables.length > 0) {
      this.schemas.set('django', schema);
    }
  }

  // SQLAlchemy Models Extraction (Python)
  private async extractSQLAlchemyModels(components: ComponentNode[]): Promise<void> {
    const modelComponents = components.filter(c => 
      c.path.endsWith('.py') && 
      c.metadata.imports?.some(imp => imp.includes('sqlalchemy'))
    );

    if (modelComponents.length === 0) return;

    console.log('⚗️ Found SQLAlchemy models');
    const schema: DatabaseSchema = {
      tables: [],
      relationships: [],
      indexes: [],
      enums: [],
      views: [],
      storedProcedures: [],
      triggers: [],
      constraints: [],
      dbType: 'postgresql',
      ormType: 'sqlalchemy'
    };

    // Similar implementation to Django but for SQLAlchemy
    // ... (abbreviated for brevity)

    if (schema.tables.length > 0) {
      this.schemas.set('sqlalchemy', schema);
    }
  }

  // MikroORM Schema Extraction
  private async extractMikroORMSchema(components: ComponentNode[]): Promise<void> {
    const entityComponents = components.filter(c => 
      c.metadata.imports?.some(imp => imp.includes('@mikro-orm')) ||
      c.path.includes('entity')
    );

    if (entityComponents.length === 0) return;

    console.log('🔶 Found MikroORM entities');
    // Implementation similar to TypeORM
    // ... (abbreviated for brevity)
  }

  // Raw SQL Schema Extraction
  private async extractRawSQLSchemas(): Promise<void> {
    const sqlFiles = await this.findFiles(['**/*.sql'], ['node_modules/**', '**/migrations/**']);
    
    if (sqlFiles.length === 0) return;

    console.log('📝 Found raw SQL files');
    const schema: DatabaseSchema = {
      tables: [],
      relationships: [],
      indexes: [],
      enums: [],
      views: [],
      storedProcedures: [],
      triggers: [],
      constraints: [],
      dbType: 'postgresql',
      ormType: 'raw-sql'
    };

    for (const sqlFile of sqlFiles) {
      const content = await fs.readFile(sqlFile, 'utf-8');
      
      // Parse CREATE TABLE statements
      const tableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?['"`]?(\w+)['"`]?\s*\(([^;]+)\)/gi;
      let tableMatch;
      
      while ((tableMatch = tableRegex.exec(content)) !== null) {
        const table: TableSchema = {
          name: tableMatch[1].toLowerCase(),
          columns: []
        };

        const columnsBody = tableMatch[2];
        const lines = columnsBody.split(',').map(l => l.trim());
        
        for (const line of lines) {
          if (line.toUpperCase().startsWith('PRIMARY KEY')) {
            const pkMatch = line.match(/PRIMARY\s+KEY\s*\(([^)]+)\)/i);
            if (pkMatch) {
              table.primaryKey = pkMatch[1].split(',').map(c => c.trim().replace(/['"`]/g, ''));
            }
          } else if (line.toUpperCase().startsWith('FOREIGN KEY')) {
            // Parse foreign key constraints
            const fkMatch = line.match(/FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+(\w+)\s*\(([^)]+)\)/i);
            if (fkMatch) {
              schema.relationships.push({
                name: `fk_${table.name}_${fkMatch[2]}`,
                type: 'many-to-one',
                from: { table: table.name, column: fkMatch[1].trim() },
                to: { table: fkMatch[2], column: fkMatch[3].trim() }
              });
            }
          } else if (line.toUpperCase().includes('INDEX') || line.toUpperCase().includes('KEY')) {
            // Parse index definitions
            continue;
          } else {
            // Parse column definition
            const columnMatch = line.match(/^['"`]?(\w+)['"`]?\s+(\w+)(?:\(([^)]+)\))?(.*)$/i);
            if (columnMatch) {
              const column: ColumnSchema = {
                name: columnMatch[1].toLowerCase(),
                type: this.mapSQLType(columnMatch[2]),
                nullable: !line.toUpperCase().includes('NOT NULL')
              };

              if (line.toUpperCase().includes('PRIMARY KEY')) {
                column.primaryKey = true;
              }
              if (line.toUpperCase().includes('UNIQUE')) {
                column.unique = true;
              }
              if (line.toUpperCase().includes('AUTO_INCREMENT') || line.toUpperCase().includes('SERIAL')) {
                column.autoIncrement = true;
              }
              
              const defaultMatch = line.match(/DEFAULT\s+([^,\s]+)/i);
              if (defaultMatch) {
                column.defaultValue = defaultMatch[1].replace(/['"`]/g, '');
              }

              if (columnMatch[3]) {
                const size = parseInt(columnMatch[3]);
                if (!isNaN(size)) {
                  column.length = size;
                }
              }

              table.columns.push(column);
            }
          }
        }

        schema.tables.push(table);
      }

      // Parse CREATE INDEX statements
      const indexRegex = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?['"`]?(\w+)['"`]?\s+ON\s+['"`]?(\w+)['"`]?\s*\(([^)]+)\)/gi;
      let indexMatch;
      
      while ((indexMatch = indexRegex.exec(content)) !== null) {
        schema.indexes.push({
          name: indexMatch[1],
          table: indexMatch[2].toLowerCase(),
          columns: indexMatch[3].split(',').map(c => c.trim().replace(/['"`]/g, '')),
          unique: content.substring(indexMatch.index, indexMatch.index + 50).toUpperCase().includes('UNIQUE')
        });
      }
    }

    if (schema.tables.length > 0) {
      this.schemas.set('raw-sql', schema);
    }
  }

  // Helper methods
  private async findFiles(patterns: string[], excludePatterns: string[]): Promise<string[]> {
    const glob = (await import('glob')).glob;
    const files: string[] = [];
    
    for (const pattern of patterns) {
      const matches = await glob(pattern, {
        cwd: this.projectPath,
        ignore: excludePatterns,
        absolute: true
      });
      files.push(...matches);
    }
    
    return files;
  }

  private async executePythonScript(script: string, input: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const python = spawn('python3', ['-c', script], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      python.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      python.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      python.on('close', (code) => {
        if (code === 0 && stdout.trim()) {
          try {
            resolve(JSON.parse(stdout.trim()));
          } catch (error) {
            reject(new Error(`Failed to parse Python output: ${error}`));
          }
        } else {
          reject(new Error(`Python script failed: ${stderr}`));
        }
      });

      python.stdin.write(input);
      python.stdin.end();
    });
  }

  private toSnakeCase(str: string): string {
    return str
      .replace(/([A-Z])/g, '_$1')
      .toLowerCase()
      .replace(/^_/, '')
      .replace(/__+/g, '_');
  }

  private mapPrismaProvider(provider: string): DatabaseSchema['dbType'] {
    const mapping: Record<string, DatabaseSchema['dbType']> = {
      'postgresql': 'postgresql',
      'mysql': 'mysql',
      'sqlite': 'sqlite',
      'sqlserver': 'mssql',
      'mongodb': 'mongodb'
    };
    return mapping[provider] || 'postgresql';
  }

  private mapPrismaType(type: string): string {
    const mapping: Record<string, string> = {
      'String': 'varchar',
      'Int': 'integer',
      'BigInt': 'bigint',
      'Float': 'float',
      'Decimal': 'decimal',
      'Boolean': 'boolean',
      'DateTime': 'timestamp',
      'Json': 'jsonb',
      'Bytes': 'bytea'
    };
    return mapping[type] || 'varchar';
  }

  private parsePrismaDefault(value: string): any {
    if (value === 'autoincrement()') return 'AUTO_INCREMENT';
    if (value === 'now()') return 'CURRENT_TIMESTAMP';
    if (value === 'uuid()') return 'gen_random_uuid()';
    if (value === 'true' || value === 'false') return value === 'true';
    if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
    if (!isNaN(Number(value))) return Number(value);
    return value;
  }

  private mapDjangoFieldType(fieldType: string): string {
    const mapping: Record<string, string> = {
      'CharField': 'varchar',
      'TextField': 'text',
      'IntegerField': 'integer',
      'BigIntegerField': 'bigint',
      'FloatField': 'float',
      'DecimalField': 'decimal',
      'BooleanField': 'boolean',
      'DateField': 'date',
      'DateTimeField': 'timestamp',
      'TimeField': 'time',
      'EmailField': 'varchar',
      'URLField': 'varchar',
      'UUIDField': 'uuid',
      'JSONField': 'jsonb',
      'ForeignKey': 'integer',
      'ManyToManyField': 'relation',
      'OneToOneField': 'integer'
    };
    return mapping[fieldType] || 'varchar';
  }

  private mapSQLType(sqlType: string): string {
    const type = sqlType.toUpperCase();
    const mapping: Record<string, string> = {
      'VARCHAR': 'varchar',
      'VARCHAR2': 'varchar',
      'CHAR': 'char',
      'TEXT': 'text',
      'INT': 'integer',
      'INTEGER': 'integer',
      'BIGINT': 'bigint',
      'SMALLINT': 'smallint',
      'TINYINT': 'tinyint',
      'FLOAT': 'float',
      'DOUBLE': 'double',
      'DECIMAL': 'decimal',
      'NUMERIC': 'numeric',
      'BOOLEAN': 'boolean',
      'BOOL': 'boolean',
      'DATE': 'date',
      'DATETIME': 'timestamp',
      'TIMESTAMP': 'timestamp',
      'TIME': 'time',
      'JSON': 'json',
      'JSONB': 'jsonb',
      'UUID': 'uuid',
      'BLOB': 'blob',
      'BYTEA': 'bytea',
      'SERIAL': 'integer',
      'BIGSERIAL': 'bigint'
    };
    return mapping[type] || 'varchar';
  }

  private extractLiteralValue(node: any): any {
    if (node.type === 'Literal') return node.value;
    if (node.type === 'Identifier') return node.name;
    if (node.type === 'TemplateLiteral') return node.quasis[0]?.value?.raw;
    return null;
  }

  public getStatistics(): {
    totalTables: number;
    totalColumns: number;
    totalRelationships: number;
    totalIndexes: number;
    byORM: Record<string, number>;
    byDatabase: Record<string, number>;
  } {
    const stats = {
      totalTables: 0,
      totalColumns: 0,
      totalRelationships: 0,
      totalIndexes: 0,
      byORM: {} as Record<string, number>,
      byDatabase: {} as Record<string, number>
    };

    for (const [key, schema] of this.schemas) {
      stats.totalTables += schema.tables.length;
      stats.totalColumns += schema.tables.reduce((sum, t) => sum + t.columns.length, 0);
      stats.totalRelationships += schema.relationships.length;
      stats.totalIndexes += schema.indexes.length;
      
      if (schema.ormType) {
        stats.byORM[schema.ormType] = (stats.byORM[schema.ormType] || 0) + schema.tables.length;
      }
      
      stats.byDatabase[schema.dbType] = (stats.byDatabase[schema.dbType] || 0) + schema.tables.length;
    }

    return stats;
  }
}
