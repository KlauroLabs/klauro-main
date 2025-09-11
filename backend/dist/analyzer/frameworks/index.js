"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FRAMEWORK_ANALYZERS = exports.LaravelAnalyzer = exports.ActixWebAnalyzer = exports.GinAnalyzer = exports.AspNetCoreAnalyzer = exports.SpringBootAnalyzer = exports.NestJSAnalyzer = exports.ExpressAnalyzer = exports.FlaskAnalyzer = exports.FastAPIAnalyzer = exports.DjangoAnalyzer = exports.NextJSAnalyzer = exports.AngularAnalyzer = exports.VueAnalyzer = exports.ReactAnalyzer = void 0;
exports.getFrameworkAnalyzer = getFrameworkAnalyzer;
exports.detectFrameworkFromFiles = detectFrameworkFromFiles;
var react_analyzer_1 = require("./frontend/react-analyzer");
Object.defineProperty(exports, "ReactAnalyzer", { enumerable: true, get: function () { return react_analyzer_1.ReactAnalyzer; } });
var vue_analyzer_1 = require("./frontend/vue-analyzer");
Object.defineProperty(exports, "VueAnalyzer", { enumerable: true, get: function () { return vue_analyzer_1.VueAnalyzer; } });
var angular_analyzer_1 = require("./frontend/angular-analyzer");
Object.defineProperty(exports, "AngularAnalyzer", { enumerable: true, get: function () { return angular_analyzer_1.AngularAnalyzer; } });
var nextjs_analyzer_1 = require("./frontend/nextjs-analyzer");
Object.defineProperty(exports, "NextJSAnalyzer", { enumerable: true, get: function () { return nextjs_analyzer_1.NextJSAnalyzer; } });
var django_analyzer_1 = require("./backend/django-analyzer");
Object.defineProperty(exports, "DjangoAnalyzer", { enumerable: true, get: function () { return django_analyzer_1.DjangoAnalyzer; } });
var fastapi_analyzer_1 = require("./backend/fastapi-analyzer");
Object.defineProperty(exports, "FastAPIAnalyzer", { enumerable: true, get: function () { return fastapi_analyzer_1.FastAPIAnalyzer; } });
var flask_analyzer_1 = require("./backend/flask-analyzer");
Object.defineProperty(exports, "FlaskAnalyzer", { enumerable: true, get: function () { return flask_analyzer_1.FlaskAnalyzer; } });
var express_analyzer_1 = require("./backend/express-analyzer");
Object.defineProperty(exports, "ExpressAnalyzer", { enumerable: true, get: function () { return express_analyzer_1.ExpressAnalyzer; } });
var nestjs_analyzer_1 = require("./backend/nestjs-analyzer");
Object.defineProperty(exports, "NestJSAnalyzer", { enumerable: true, get: function () { return nestjs_analyzer_1.NestJSAnalyzer; } });
var springboot_analyzer_1 = require("./backend/springboot-analyzer");
Object.defineProperty(exports, "SpringBootAnalyzer", { enumerable: true, get: function () { return springboot_analyzer_1.SpringBootAnalyzer; } });
var aspnetcore_analyzer_1 = require("./backend/aspnetcore-analyzer");
Object.defineProperty(exports, "AspNetCoreAnalyzer", { enumerable: true, get: function () { return aspnetcore_analyzer_1.AspNetCoreAnalyzer; } });
var gin_analyzer_1 = require("./backend/gin-analyzer");
Object.defineProperty(exports, "GinAnalyzer", { enumerable: true, get: function () { return gin_analyzer_1.GinAnalyzer; } });
var actixweb_analyzer_1 = require("./backend/actixweb-analyzer");
Object.defineProperty(exports, "ActixWebAnalyzer", { enumerable: true, get: function () { return actixweb_analyzer_1.ActixWebAnalyzer; } });
var laravel_analyzer_1 = require("./backend/laravel-analyzer");
Object.defineProperty(exports, "LaravelAnalyzer", { enumerable: true, get: function () { return laravel_analyzer_1.LaravelAnalyzer; } });
const react_analyzer_2 = require("./frontend/react-analyzer");
const vue_analyzer_2 = require("./frontend/vue-analyzer");
const angular_analyzer_2 = require("./frontend/angular-analyzer");
const nextjs_analyzer_2 = require("./frontend/nextjs-analyzer");
const django_analyzer_2 = require("./backend/django-analyzer");
const fastapi_analyzer_2 = require("./backend/fastapi-analyzer");
const flask_analyzer_2 = require("./backend/flask-analyzer");
const express_analyzer_2 = require("./backend/express-analyzer");
const nestjs_analyzer_2 = require("./backend/nestjs-analyzer");
const springboot_analyzer_2 = require("./backend/springboot-analyzer");
const aspnetcore_analyzer_2 = require("./backend/aspnetcore-analyzer");
const gin_analyzer_2 = require("./backend/gin-analyzer");
const actixweb_analyzer_2 = require("./backend/actixweb-analyzer");
const laravel_analyzer_2 = require("./backend/laravel-analyzer");
exports.FRAMEWORK_ANALYZERS = [
    {
        name: 'React',
        analyzer: react_analyzer_2.ReactAnalyzer,
        category: 'frontend',
        languages: ['javascript', 'typescript'],
        frameworks: ['react', 'react-native'],
        priority: 100
    },
    {
        name: 'Vue',
        analyzer: vue_analyzer_2.VueAnalyzer,
        category: 'frontend',
        languages: ['javascript', 'typescript'],
        frameworks: ['vue', 'nuxt'],
        priority: 95
    },
    {
        name: 'Angular',
        analyzer: angular_analyzer_2.AngularAnalyzer,
        category: 'frontend',
        languages: ['typescript'],
        frameworks: ['angular', 'ionic'],
        priority: 90
    },
    {
        name: 'Next.js',
        analyzer: nextjs_analyzer_2.NextJSAnalyzer,
        category: 'fullstack',
        languages: ['javascript', 'typescript'],
        frameworks: ['next', 'nextjs'],
        priority: 105
    },
    {
        name: 'Django',
        analyzer: django_analyzer_2.DjangoAnalyzer,
        category: 'backend',
        languages: ['python'],
        frameworks: ['django', 'django-rest-framework'],
        priority: 100
    },
    {
        name: 'FastAPI',
        analyzer: fastapi_analyzer_2.FastAPIAnalyzer,
        category: 'backend',
        languages: ['python'],
        frameworks: ['fastapi', 'starlette', 'pydantic'],
        priority: 105
    },
    {
        name: 'Flask',
        analyzer: flask_analyzer_2.FlaskAnalyzer,
        category: 'backend',
        languages: ['python'],
        frameworks: ['flask', 'flask-restful'],
        priority: 95
    },
    {
        name: 'Express',
        analyzer: express_analyzer_2.ExpressAnalyzer,
        category: 'backend',
        languages: ['javascript', 'typescript'],
        frameworks: ['express', 'express.js'],
        priority: 100
    },
    {
        name: 'NestJS',
        analyzer: nestjs_analyzer_2.NestJSAnalyzer,
        category: 'backend',
        languages: ['typescript'],
        frameworks: ['nestjs', '@nestjs/core'],
        priority: 110
    },
    {
        name: 'Spring Boot',
        analyzer: springboot_analyzer_2.SpringBootAnalyzer,
        category: 'backend',
        languages: ['java', 'kotlin'],
        frameworks: ['spring-boot', 'spring', 'spring-mvc'],
        priority: 100
    },
    {
        name: 'ASP.NET Core',
        analyzer: aspnetcore_analyzer_2.AspNetCoreAnalyzer,
        category: 'backend',
        languages: ['csharp'],
        frameworks: ['aspnetcore', 'aspnet', 'dotnet'],
        priority: 100
    },
    {
        name: 'Gin',
        analyzer: gin_analyzer_2.GinAnalyzer,
        category: 'backend',
        languages: ['go'],
        frameworks: ['gin', 'gin-gonic'],
        priority: 100
    },
    {
        name: 'Actix-web',
        analyzer: actixweb_analyzer_2.ActixWebAnalyzer,
        category: 'backend',
        languages: ['rust'],
        frameworks: ['actix-web', 'actix'],
        priority: 100
    },
    {
        name: 'Laravel',
        analyzer: laravel_analyzer_2.LaravelAnalyzer,
        category: 'backend',
        languages: ['php'],
        frameworks: ['laravel', 'lumen'],
        priority: 100
    }
];
function getFrameworkAnalyzer(language, detectedFrameworks) {
    const sortedAnalyzers = [...exports.FRAMEWORK_ANALYZERS].sort((a, b) => b.priority - a.priority);
    for (const analyzerInfo of sortedAnalyzers) {
        if (!analyzerInfo.languages.includes(language.toLowerCase())) {
            continue;
        }
        const frameworkMatch = analyzerInfo.frameworks.some(fw => detectedFrameworks.some(detected => detected.toLowerCase().includes(fw.toLowerCase()) ||
            fw.toLowerCase().includes(detected.toLowerCase())));
        if (frameworkMatch) {
            return analyzerInfo.analyzer;
        }
    }
    return null;
}
async function detectFrameworkFromFiles(projectPath, files) {
    const detectedFrameworks = [];
    if (files.some(f => f.includes('package.json'))) {
        if (files.some(f => f.endsWith('.jsx') || f.endsWith('.tsx'))) {
            if (files.some(f => f.includes('next.config'))) {
                detectedFrameworks.push('nextjs');
            }
            else {
                detectedFrameworks.push('react');
            }
        }
    }
    if (files.some(f => f.endsWith('.vue'))) {
        if (files.some(f => f.includes('nuxt.config'))) {
            detectedFrameworks.push('nuxt');
        }
        else {
            detectedFrameworks.push('vue');
        }
    }
    if (files.some(f => f === 'angular.json')) {
        detectedFrameworks.push('angular');
    }
    if (files.some(f => f === 'manage.py')) {
        detectedFrameworks.push('django');
    }
    if (files.some(f => f.includes('main.py') || f.includes('app.py'))) {
    }
    if (files.some(f => f === 'app.js' || f === 'server.js')) {
    }
    return detectedFrameworks;
}
