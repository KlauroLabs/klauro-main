// Unit tests for LanguageDetector class
// Production-ready test suite for language and framework detection

import { LanguageDetector } from '../../analyzer/language-detector';
import { LanguageDetectionError } from '../../analyzer/errors';
import * as fs from 'fs-extra';
import * as path from 'path';

describe('LanguageDetector', () => {
  let detector: LanguageDetector;
  let tempDir: string;

  beforeEach(async () => {
    detector = new LanguageDetector();
    tempDir = await fs.mkdtemp(path.join(__dirname, 'test-lang-detection-'));
  });

  afterEach(async () => {
    await fs.remove(tempDir);
  });

  describe('Node.js/JavaScript project detection', () => {
    it('should detect plain JavaScript project', async () => {
      await fs.writeFile(
        path.join(tempDir, 'package.json'),
        JSON.stringify({
          name: 'test-project',
          version: '1.0.0',
          dependencies: {
            express: '^4.18.0'
          }
        })
      );

      await fs.writeFile(
        path.join(tempDir, 'index.js'),
        'const express = require("express"); const app = express();'
      );

      const result = await detector.detectProject(tempDir);

      expect(result.primary.name).toBe('JavaScript');
      expect(result.confidence).toBeGreaterThan(0.8);
      expect(result.frameworks).toContainEqual(
        expect.objectContaining({ name: 'Express' })
      );
    });

    it('should detect TypeScript project', async () => {
      await fs.writeFile(
        path.join(tempDir, 'package.json'),
        JSON.stringify({
          name: 'test-project',
          dependencies: {
            '@nestjs/core': '^9.0.0'
          },
          devDependencies: {
            typescript: '^4.8.0'
          }
        })
      );

      await fs.writeFile(
        path.join(tempDir, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { target: 'es2020' } })
      );

      await fs.writeFile(
        path.join(tempDir, 'main.ts'),
        'import { NestFactory } from "@nestjs/core";'
      );

      const result = await detector.detectProject(tempDir);

      expect(result.primary.name).toBe('TypeScript');
      expect(result.frameworks).toContainEqual(
        expect.objectContaining({ name: 'NestJS' })
      );
    });

    it('should detect React application', async () => {
      await fs.writeFile(
        path.join(tempDir, 'package.json'),
        JSON.stringify({
          name: 'react-app',
          dependencies: {
            react: '^18.2.0',
            'react-dom': '^18.2.0'
          }
        })
      );

      await fs.mkdir(path.join(tempDir, 'src'));
      await fs.writeFile(
        path.join(tempDir, 'src/App.jsx'),
        'import React from "react"; function App() { return <div>Hello</div>; }'
      );

      const result = await detector.detectProject(tempDir);

      expect(result.primary.name).toBe('JavaScript');
      expect(result.frameworks).toContainEqual(
        expect.objectContaining({ name: 'React' })
      );
    });

    it('should detect Next.js application', async () => {
      await fs.writeFile(
        path.join(tempDir, 'package.json'),
        JSON.stringify({
          dependencies: {
            next: '^13.0.0',
            react: '^18.2.0'
          }
        })
      );

      await fs.mkdir(path.join(tempDir, 'pages'));
      await fs.writeFile(
        path.join(tempDir, 'pages/index.js'),
        'export default function Home() { return <div>Hello Next.js</div>; }'
      );

      const result = await detector.detectProject(tempDir);

      expect(result.frameworks).toContainEqual(
        expect.objectContaining({ name: 'Next.js' })
      );
    });
  });

  describe('Python project detection', () => {
    it('should detect Django project', async () => {
      await fs.writeFile(
        path.join(tempDir, 'requirements.txt'),
        'Django==4.1.0\npsycopg2-binary==2.9.3'
      );

      await fs.writeFile(
        path.join(tempDir, 'manage.py'),
        '#!/usr/bin/env python\nimport django\nfrom django.core.management import execute_from_command_line'
      );

      await fs.writeFile(
        path.join(tempDir, 'settings.py'),
        'INSTALLED_APPS = ["django.contrib.admin"]\nDATABASES = {}'
      );

      const result = await detector.detectProject(tempDir);

      expect(result.primary.name).toBe('Python');
      expect(result.frameworks).toContainEqual(
        expect.objectContaining({ name: 'Django' })
      );
    });

    it('should detect FastAPI project', async () => {
      await fs.writeFile(
        path.join(tempDir, 'requirements.txt'),
        'fastapi==0.85.0\nuvicorn==0.18.0'
      );

      await fs.writeFile(
        path.join(tempDir, 'main.py'),
        'from fastapi import FastAPI\napp = FastAPI()\n@app.get("/")\ndef read_root(): return {"Hello": "World"}'
      );

      const result = await detector.detectProject(tempDir);

      expect(result.primary.name).toBe('Python');
      expect(result.frameworks).toContainEqual(
        expect.objectContaining({ name: 'FastAPI' })
      );
    });

    it('should detect Flask project', async () => {
      await fs.writeFile(
        path.join(tempDir, 'requirements.txt'),
        'Flask==2.2.0\nWerkzeug==2.2.0'
      );

      await fs.writeFile(
        path.join(tempDir, 'app.py'),
        'from flask import Flask\napp = Flask(__name__)\n@app.route("/")\ndef hello(): return "Hello World"'
      );

      const result = await detector.detectProject(tempDir);

      expect(result.primary.name).toBe('Python');
      expect(result.frameworks).toContainEqual(
        expect.objectContaining({ name: 'Flask' })
      );
    });
  });

  describe('Java project detection', () => {
    it('should detect Maven Java project', async () => {
      await fs.writeFile(
        path.join(tempDir, 'pom.xml'),
        `<?xml version="1.0" encoding="UTF-8"?>
         <project>
           <groupId>com.example</groupId>
           <artifactId>test-app</artifactId>
           <version>1.0.0</version>
           <dependencies>
             <dependency>
               <groupId>org.springframework.boot</groupId>
               <artifactId>spring-boot-starter-web</artifactId>
               <version>2.7.0</version>
             </dependency>
           </dependencies>
         </project>`
      );

      await fs.mkdir(path.join(tempDir, 'src/main/java'), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, 'src/main/java/Application.java'),
        '@SpringBootApplication\npublic class Application { public static void main(String[] args) {} }'
      );

      const result = await detector.detectProject(tempDir);

      expect(result.primary.name).toBe('Java');
      expect(result.frameworks).toContainEqual(
        expect.objectContaining({ name: 'Spring Boot' })
      );
    });

    it('should detect Gradle Java project', async () => {
      await fs.writeFile(
        path.join(tempDir, 'build.gradle'),
        `plugins {
           id 'java'
           id 'org.springframework.boot' version '2.7.0'
         }
         dependencies {
           implementation 'org.springframework.boot:spring-boot-starter-web'
         }`
      );

      const result = await detector.detectProject(tempDir);

      expect(result.primary.name).toBe('Java');
      expect(result.buildTools).toContainEqual(
        expect.objectContaining({ name: 'Gradle' })
      );
    });
  });

  describe('C#/.NET project detection', () => {
    it('should detect .NET Core project', async () => {
      await fs.writeFile(
        path.join(tempDir, 'TestApp.csproj'),
        `<Project Sdk="Microsoft.NET.Sdk.Web">
           <PropertyGroup>
             <TargetFramework>net6.0</TargetFramework>
           </PropertyGroup>
           <ItemGroup>
             <PackageReference Include="Microsoft.AspNetCore.App" />
             <PackageReference Include="Microsoft.EntityFrameworkCore" Version="6.0.0" />
           </ItemGroup>
         </Project>`
      );

      await fs.writeFile(
        path.join(tempDir, 'Program.cs'),
        'using Microsoft.AspNetCore.Builder;\nvar app = WebApplication.Create();'
      );

      const result = await detector.detectProject(tempDir);

      expect(result.primary.name).toBe('C#');
      expect(result.frameworks).toContainEqual(
        expect.objectContaining({ name: 'ASP.NET Core' })
      );
    });
  });

  describe('Go project detection', () => {
    it('should detect Go project with Gin framework', async () => {
      await fs.writeFile(
        path.join(tempDir, 'go.mod'),
        `module example.com/test-app

         go 1.19

         require (
           github.com/gin-gonic/gin v1.8.1
           github.com/golang/protobuf v1.5.2
         )`
      );

      await fs.writeFile(
        path.join(tempDir, 'main.go'),
        'package main\nimport "github.com/gin-gonic/gin"\nfunc main() { r := gin.Default() }'
      );

      const result = await detector.detectProject(tempDir);

      expect(result.primary.name).toBe('Go');
      expect(result.frameworks).toContainEqual(
        expect.objectContaining({ name: 'Gin' })
      );
    });
  });

  describe('Rust project detection', () => {
    it('should detect Rust project with Actix-web', async () => {
      await fs.writeFile(
        path.join(tempDir, 'Cargo.toml'),
        `[package]
         name = "test-app"
         version = "0.1.0"

         [dependencies]
         actix-web = "4.2"
         tokio = { version = "1.0", features = ["full"] }`
      );

      await fs.writeFile(
        path.join(tempDir, 'src/main.rs'),
        'use actix_web::{web, App, HttpServer};\nfn main() -> std::io::Result<()> { Ok(()) }'
      );

      const result = await detector.detectProject(tempDir);

      expect(result.primary.name).toBe('Rust');
      expect(result.frameworks).toContainEqual(
        expect.objectContaining({ name: 'Actix-web' })
      );
    });
  });

  describe('PHP project detection', () => {
    it('should detect Laravel project', async () => {
      await fs.writeFile(
        path.join(tempDir, 'composer.json'),
        JSON.stringify({
          name: 'laravel/laravel',
          require: {
            'laravel/framework': '^9.0'
          }
        })
      );

      await fs.writeFile(
        path.join(tempDir, 'artisan'),
        '#!/usr/bin/env php\n<?php\nrequire __DIR__."/vendor/autoload.php";'
      );

      const result = await detector.detectProject(tempDir);

      expect(result.primary.name).toBe('PHP');
      expect(result.frameworks).toContainEqual(
        expect.objectContaining({ name: 'Laravel' })
      );
    });
  });

  describe('file extension detection', () => {
    it('should detect language by file extensions', async () => {
      // Create files with different extensions
      await fs.writeFile(path.join(tempDir, 'component.tsx'), 'export const Component = () => <div>Hello</div>;');
      await fs.writeFile(path.join(tempDir, 'utils.ts'), 'export function helper(): string { return "help"; }');
      await fs.writeFile(path.join(tempDir, 'script.js'), 'console.log("hello");');

      const result = await detector.detectProject(tempDir);

      expect(result.primary.name).toBe('TypeScript');
      expect(result.secondary.map(l => l.name)).toContain('JavaScript');
    });

    it('should calculate language percentages correctly', async () => {
      // Create mostly TypeScript files with some JavaScript
      for (let i = 0; i < 8; i++) {
        await fs.writeFile(
          path.join(tempDir, `file${i}.ts`),
          `export const value${i} = ${i};`
        );
      }
      
      for (let i = 0; i < 2; i++) {
        await fs.writeFile(
          path.join(tempDir, `file${i}.js`),
          `const value${i} = ${i};`
        );
      }

      const result = await detector.detectProject(tempDir);

      expect(result.primary.name).toBe('TypeScript');
      expect(result.primary.percentage).toBeGreaterThan(70);
      
      const jsLang = result.secondary.find(l => l.name === 'JavaScript');
      expect(jsLang?.percentage).toBeGreaterThan(15);
    });
  });

  describe('content-based detection', () => {
    it('should detect frameworks by code patterns', async () => {
      await fs.writeFile(
        path.join(tempDir, 'controller.ts'),
        `import { Controller, Get } from '@nestjs/common';
         
         @Controller('api')
         export class ApiController {
           @Get()
           getData() {
             return { message: 'Hello World' };
           }
         }`
      );

      const result = await detector.detectProject(tempDir);

      expect(result.frameworks).toContainEqual(
        expect.objectContaining({ 
          name: 'NestJS',
          signals: expect.arrayContaining(['@Controller', '@Get'])
        })
      );
    });

    it('should detect React hooks patterns', async () => {
      await fs.writeFile(
        path.join(tempDir, 'component.jsx'),
        `import React, { useState, useEffect } from 'react';
         
         function MyComponent() {
           const [count, setCount] = useState(0);
           
           useEffect(() => {
             console.log('Component mounted');
           }, []);
           
           return <div>Count: {count}</div>;
         }`
      );

      const result = await detector.detectProject(tempDir);

      expect(result.frameworks).toContainEqual(
        expect.objectContaining({ 
          name: 'React',
          signals: expect.arrayContaining(['useState', 'useEffect'])
        })
      );
    });
  });

  describe('project structure detection', () => {
    it('should detect Angular by project structure', async () => {
      await fs.mkdir(path.join(tempDir, 'src/app'), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, 'src/app/app.component.ts'),
        `import { Component } from '@angular/core';
         @Component({
           selector: 'app-root',
           template: '<h1>Hello Angular</h1>'
         })
         export class AppComponent {}`
      );

      await fs.writeFile(
        path.join(tempDir, 'angular.json'),
        JSON.stringify({
          projects: {
            'test-app': {
              projectType: 'application'
            }
          }
        })
      );

      const result = await detector.detectProject(tempDir);

      expect(result.frameworks).toContainEqual(
        expect.objectContaining({ name: 'Angular' })
      );
    });

    it('should detect MVC structure', async () => {
      await fs.mkdir(path.join(tempDir, 'app/controllers'), { recursive: true });
      await fs.mkdir(path.join(tempDir, 'app/models'), { recursive: true });
      
      await fs.writeFile(
        path.join(tempDir, 'app/controllers/UserController.py'),
        'class UserController: pass'
      );
      
      await fs.writeFile(
        path.join(tempDir, 'app/models/User.py'),
        'class User: pass'
      );

      const result = await detector.detectProject(tempDir);

      expect(result.signals).toContainEqual(
        expect.objectContaining({
          type: 'structure',
          value: 'app/controllers'
        })
      );
    });
  });

  describe('analyzer routing', () => {
    it('should route NestJS projects to NestJS analyzer', async () => {
      await fs.writeFile(
        path.join(tempDir, 'package.json'),
        JSON.stringify({ dependencies: { '@nestjs/core': '^9.0.0' } })
      );
      
      await fs.writeFile(path.join(tempDir, 'main.ts'), 'import { NestFactory } from "@nestjs/core";');

      const analyzer = await detector.routeToAnalyzer(tempDir);
      expect(analyzer).toBe('nestjs-analyzer');
    });

    it('should route React projects to frontend analyzer', async () => {
      await fs.writeFile(
        path.join(tempDir, 'package.json'),
        JSON.stringify({ dependencies: { react: '^18.0.0' } })
      );

      const analyzer = await detector.routeToAnalyzer(tempDir);
      expect(analyzer).toBe('frontend-analyzer');
    });

    it('should route Django projects to Django analyzer', async () => {
      await fs.writeFile(path.join(tempDir, 'requirements.txt'), 'Django==4.1.0');
      await fs.writeFile(path.join(tempDir, 'manage.py'), 'import django');

      const analyzer = await detector.routeToAnalyzer(tempDir);
      expect(analyzer).toBe('django-analyzer');
    });

    it('should route Spring Boot projects to Spring analyzer', async () => {
      await fs.writeFile(
        path.join(tempDir, 'pom.xml'),
        '<project><dependencies><dependency><artifactId>spring-boot-starter</artifactId></dependency></dependencies></project>'
      );

      const analyzer = await detector.routeToAnalyzer(tempDir);
      expect(analyzer).toBe('spring-analyzer');
    });

    it('should throw error for undetectable projects', async () => {
      // Empty directory with no recognizable patterns
      await expect(
        detector.routeToAnalyzer(tempDir)
      ).rejects.toThrow(LanguageDetectionError);
    });
  });

  describe('mixed language projects', () => {
    it('should detect multiple languages correctly', async () => {
      // Create a project with multiple languages
      await fs.writeFile(path.join(tempDir, 'frontend.ts'), 'const x: number = 1;');
      await fs.writeFile(path.join(tempDir, 'backend.py'), 'x = 1');
      await fs.writeFile(path.join(tempDir, 'config.json'), '{"test": true}');

      const result = await detector.detectProject(tempDir);

      expect(result.primary).toBeDefined();
      expect(result.secondary.length).toBeGreaterThan(0);
      
      const languages = [result.primary.name, ...result.secondary.map(l => l.name)];
      expect(languages).toContain('TypeScript');
      expect(languages).toContain('Python');
    });

    it('should handle monorepo structure', async () => {
      // Create a monorepo-like structure
      await fs.mkdir(path.join(tempDir, 'packages/frontend'), { recursive: true });
      await fs.mkdir(path.join(tempDir, 'packages/backend'), { recursive: true });
      
      await fs.writeFile(
        path.join(tempDir, 'packages/frontend/package.json'),
        JSON.stringify({ dependencies: { react: '^18.0.0' } })
      );
      
      await fs.writeFile(
        path.join(tempDir, 'packages/backend/requirements.txt'),
        'fastapi==0.85.0'
      );

      const result = await detector.detectProject(tempDir);

      expect(result.frameworks.length).toBeGreaterThan(0);
    });
  });

  describe('confidence scoring', () => {
    it('should have high confidence for strong indicators', async () => {
      await fs.writeFile(
        path.join(tempDir, 'package.json'),
        JSON.stringify({
          name: 'test-app',
          dependencies: { '@nestjs/core': '^9.0.0' }
        })
      );
      
      await fs.writeFile(path.join(tempDir, 'tsconfig.json'), '{}');
      await fs.writeFile(path.join(tempDir, 'nest-cli.json'), '{}');

      const result = await detector.detectProject(tempDir);

      expect(result.confidence).toBeGreaterThan(0.9);
      
      const nestFramework = result.frameworks.find(f => f.name === 'NestJS');
      expect(nestFramework?.confidence).toBeGreaterThan(0.9);
    });

    it('should have lower confidence for weak indicators', async () => {
      // Only create files with extensions, no manifest files
      await fs.writeFile(path.join(tempDir, 'test.ts'), 'const x = 1;');

      const result = await detector.detectProject(tempDir);

      expect(result.confidence).toBeLessThan(0.8);
    });
  });

  describe('edge cases', () => {
    it('should handle empty project directory', async () => {
      const result = await detector.detectProject(tempDir);

      expect(result.primary.name).toBe('Unknown');
      expect(result.confidence).toBeLessThan(0.3);
    });

    it('should handle corrupted package.json', async () => {
      await fs.writeFile(path.join(tempDir, 'package.json'), '{ invalid json');
      await fs.writeFile(path.join(tempDir, 'test.js'), 'console.log("test");');

      // Should not throw, but fall back to other detection methods
      const result = await detector.detectProject(tempDir);
      expect(result).toBeDefined();
    });

    it('should handle binary files gracefully', async () => {
      // Create a fake binary file
      const binaryContent = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
      await fs.writeFile(path.join(tempDir, 'image.png'), binaryContent);
      await fs.writeFile(path.join(tempDir, 'test.js'), 'console.log("test");');

      const result = await detector.detectProject(tempDir);
      expect(result.primary.name).toBe('JavaScript');
    });

    it('should handle very large files', async () => {
      // Create a large file
      const largeContent = 'console.log("test");'.repeat(10000);
      await fs.writeFile(path.join(tempDir, 'large.js'), largeContent);

      const result = await detector.detectProject(tempDir);
      expect(result.primary.name).toBe('JavaScript');
    });
  });
});