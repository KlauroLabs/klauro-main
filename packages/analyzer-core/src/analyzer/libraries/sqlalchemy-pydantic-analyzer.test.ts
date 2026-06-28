import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SQLAlchemyPydanticAnalyzer } from './sqlalchemy-pydantic-analyzer';

function makeProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlalchemy-pydantic-test-'));

  fs.writeFileSync(
    path.join(dir, 'requirements.txt'),
    ['sqlalchemy==2.0.0', 'pydantic==2.5.0', ''].join('\n')
  );

  fs.writeFileSync(
    path.join(dir, 'models.py'),
    [
      'from sqlalchemy import Column, Integer, String, ForeignKey',
      'from sqlalchemy.orm import declarative_base, relationship',
      '',
      'Base = declarative_base()',
      '',
      'class User(Base):',
      "    __tablename__ = 'users'",
      '    id = Column(Integer, primary_key=True)',
      '    email = Column(String, nullable=False, unique=True)',
      "    posts = relationship('Post', back_populates='author')",
      '',
      'class Post(Base):',
      "    __tablename__ = 'posts'",
      '    id = Column(Integer, primary_key=True)',
      '    title = Column(String)',
      "    user_id = Column(Integer, ForeignKey('users.id'))",
      '',
    ].join('\n')
  );

  fs.writeFileSync(
    path.join(dir, 'schemas.py'),
    [
      'from pydantic import BaseModel',
      '',
      'class UserCreate(BaseModel):',
      '    email: str',
      '    age: int = 0',
      '',
    ].join('\n')
  );

  return dir;
}

test('canAnalyze detects sqlalchemy/pydantic project', async () => {
  const dir = makeProject();
  try {
    const analyzer = new SQLAlchemyPydanticAnalyzer();
    assert.equal(await analyzer.canAnalyze(dir), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('extracts SQLAlchemy entities, fields, relations and Pydantic DTOs', async () => {
  const dir = makeProject();
  try {
    const analyzer = new SQLAlchemyPydanticAnalyzer();
    const result = await analyzer.analyze({ projectPath: dir });

    const entities = result.nodes.filter((n) => n.type === 'entity');
    const dtos = result.nodes.filter((n) => n.type === 'dto');

    // Entities: User + Post
    const user = entities.find((n) => n.name === 'User');
    const post = entities.find((n) => n.name === 'Post');
    assert.ok(user, 'User entity present');
    assert.ok(post, 'Post entity present');
    assert.equal((user!.metadata as any).table, 'users');
    assert.equal((post!.metadata as any).table, 'posts');

    // User fields: id (pk), email (nullable=False, unique)
    const userFields = (user!.metadata as any).fields as Array<any>;
    const idField = userFields.find((f) => f.name === 'id');
    const emailField = userFields.find((f) => f.name === 'email');
    assert.ok(idField && idField.primary, 'id is primary key');
    assert.ok(emailField, 'email field present');
    assert.equal(emailField.unique, true, 'email unique');
    assert.equal(emailField.optional, false, 'email not nullable');

    // Relation edge User -> Post (via relationship('Post'))
    const relEdge = result.edges.find(
      (e) =>
        e.source === 'entity_sqlalchemy_user' &&
        e.target === 'entity_sqlalchemy_post'
    );
    assert.ok(relEdge, 'User -> Post relation edge present');

    // ForeignKey edge Post -> User
    const fkEdge = result.edges.find(
      (e) =>
        e.source === 'entity_sqlalchemy_post' &&
        e.target === 'entity_sqlalchemy_user'
    );
    assert.ok(fkEdge, 'Post -> User foreign-key edge present');

    // Pydantic DTO: UserCreate with email + age, tagged pydantic-model
    const userCreate = dtos.find((n) => n.name === 'UserCreate');
    assert.ok(userCreate, 'UserCreate DTO node present');
    assert.equal(userCreate!.type, 'dto');
    assert.ok(
      ((userCreate!.metadata as any).tags || []).includes('pydantic-model'),
      'UserCreate tagged pydantic-model'
    );
    const dtoFields = (userCreate!.metadata as any).fields as Array<any>;
    assert.ok(dtoFields.find((f) => f.name === 'email'), 'email field on DTO');
    const ageField = dtoFields.find((f) => f.name === 'age');
    assert.ok(ageField, 'age field on DTO');
    assert.equal(ageField.optional, true, 'age has default => optional');

    // Best-effort entity<->schema link: User -> UserCreate
    const schemaLink = result.edges.find(
      (e) =>
        e.source === 'entity_sqlalchemy_user' &&
        e.target === 'dto_pydantic_usercreate'
    );
    assert.ok(schemaLink, 'User entity linked to UserCreate schema');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
