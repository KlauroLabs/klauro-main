
import * as fs from 'fs-extra';
import * as path from 'path';
import { glob } from 'glob';
import { BaseAnalyzer } from './base-analyzer';

export interface AnalyzerEvidence {
  analyzer: string;
  score: number;
  evidence: {
    packageJsonMatch?: boolean;
    filePatterns?: string[];
    contentPatterns?: string[];
    configFiles?: string[];
    directoryStructure?: string[];
  };
  confidence: number;
}

export class AnalyzerSelector {
  private projectPath: string;
  private fileCache: Map<string, string> = new Map();
  
  constructor(projectPath: string) {
    this.projectPath = projectPath;
  }

  async selectBestAnalyzer(analyzers: Map<string, BaseAnalyzer>): Promise<{
    analyzer: BaseAnalyzer;
    evidence: AnalyzerEvidence;
  } | null> {
    console.log('🔍 Analyzing project structure to select best analyzer...');
    
    const projectInfo = await this.gatherProjectIntelligence();
    
    const scores: AnalyzerEvidence[] = [];
    
    for (const [name, analyzer] of analyzers) {
      const evidence = await this.scoreAnalyzer(name, analyzer, projectInfo);
      scores.push(evidence);
    }
    
    scores.sort((a, b) => {
      const scoreA = a.score * a.confidence;
      const scoreB = b.score * b.confidence;
      return scoreB - scoreA;
    });
    
    const best = scores[0];
    if (best && best.confidence > 0.5) {
      console.log(`✅ Selected ${best.analyzer} (score: ${best.score}, confidence: ${(best.confidence * 100).toFixed(0)}%)`);
      console.log(`   Evidence: ${JSON.stringify(best.evidence)}`);
      
      const analyzer = analyzers.get(best.analyzer);
      if (analyzer) {
        return {
          analyzer,
          evidence: best
        };
      }
    }
    
    console.log('⚠️ No analyzer with sufficient confidence, using TypeScript/JavaScript analyzer as default');
    const defaultAnalyzer = analyzers.get('TypeScriptJavaScriptAnalyzer') || analyzers.values().next().value;
    if (defaultAnalyzer) {
      return {
        analyzer: defaultAnalyzer,
        evidence: {
          analyzer: 'TypeScriptJavaScriptAnalyzer',
          score: 50,
          evidence: { filePatterns: ['*.ts', '*.js'] },
          confidence: 0.5
        }
      };
    }
    
    return null;
  }

  private async gatherProjectIntelligence() {
    const info: any = {
      packageJson: null,
      files: [],
      directories: [],
      mainLanguage: null,
      frameworks: [],
      fileTypes: new Map<string, number>(),
      hasTests: false,
      projectType: null
    };
    
    const packageJsonPath = path.join(this.projectPath, 'package.json');
    if (await fs.pathExists(packageJsonPath)) {
      info.packageJson = await fs.readJson(packageJsonPath);
    }
    
    const allFiles = await glob('**/*', {
      cwd: this.projectPath,
      ignore: ['node_modules/**', '.git/**', 'dist/**', 'build/**'],
      absolute: false,
      nodir: true,
      maxDepth: 5
    });
    
    info.files = allFiles.slice(0, 1000);
    
    for (const file of info.files) {
      const ext = path.extname(file).toLowerCase();
      info.fileTypes.set(ext, (info.fileTypes.get(ext) || 0) + 1);
    }
    
    const langExtensions = {
      typescript: ['.ts', '.tsx'],
      javascript: ['.js', '.jsx', '.mjs', '.cjs'],
      python: ['.py'],
      java: ['.java'],
      csharp: ['.cs'],
      go: ['.go'],
      rust: ['.rs'],
      php: ['.php']
    };
    
    let maxCount = 0;
    for (const [lang, exts] of Object.entries(langExtensions)) {
      const count = exts.reduce((sum, ext) => sum + (info.fileTypes.get(ext) || 0), 0);
      if (count > maxCount) {
        maxCount = count;
        info.mainLanguage = lang;
      }
    }
    
    info.hasTests = info.files.some((f: string) => 
      f.includes('test') || f.includes('spec') || 
      f.includes('__tests__') || f.includes('__test__')
    );
    
    const hasJSX = info.fileTypes.get('.jsx') || info.fileTypes.get('.tsx');
    const hasHTML = info.fileTypes.get('.html');
    const hasAPI = info.files.some((f: string) => 
      f.includes('routes') || f.includes('controllers') || 
      f.includes('api') || f.includes('server')
    );
    
    if (hasJSX || hasHTML) {
      info.projectType = hasAPI ? 'fullstack' : 'frontend';
    } else if (hasAPI) {
      info.projectType = 'backend';
    } else if (info.packageJson?.main || info.packageJson?.module) {
      info.projectType = 'library';
    }
    
    const dirs = new Set<string>();
    for (const file of info.files) {
      const dir = path.dirname(file);
      if (dir !== '.') {
        dirs.add(dir.split('/')[0]);
      }
    }
    info.directories = Array.from(dirs);
    
    return info;
  }

  private async scoreAnalyzer(
    name: string, 
    analyzer: BaseAnalyzer, 
    projectInfo: any
  ): Promise<AnalyzerEvidence> {
    let score = 0;
    const evidence: any = {};
    
    const supportedLangs = analyzer.getSupportedLanguages();
    if (projectInfo.mainLanguage && supportedLangs.includes(projectInfo.mainLanguage)) {
      score += 30;
      evidence.mainLanguage = projectInfo.mainLanguage;
    }
    
    const supportedFrameworks = analyzer.getSupportedFrameworks();
    
    if (name.includes('React')) {
      const jsxCount = (projectInfo.fileTypes.get('.jsx') || 0) + (projectInfo.fileTypes.get('.tsx') || 0);
      if (jsxCount > 0) {
        score += 50;
        evidence.filePatterns = ['*.jsx', '*.tsx'];
      }
      
      if (projectInfo.packageJson?.dependencies?.react) {
        score += 20;
        evidence.packageJsonMatch = true;
      }
      
      if (projectInfo.directories.some((d: string) => d === 'components' || d === 'pages')) {
        score += 10;
        evidence.directoryStructure = ['components', 'pages'];
      }
    }
    
    else if (name.includes('Express')) {
      if (projectInfo.packageJson?.dependencies?.express) {
        score += 30;
        evidence.packageJsonMatch = true;
      }
      
      const serverFiles = projectInfo.files.filter((f: string) => 
        f.includes('server') || f.includes('app') || 
        f.includes('routes') || f.includes('middleware')
      );
      if (serverFiles.length > 0) {
        score += 20;
        evidence.filePatterns = serverFiles.slice(0, 5);
      }
      
      const expressIndicators = projectInfo.files.filter((f: string) => 
        f.endsWith('app.ts') || f.endsWith('app.js') ||
        f.endsWith('server.ts') || f.endsWith('server.js') ||
        f.includes('routes/') || f.includes('controllers/')
      );
      if (expressIndicators.length > 0) {
        score += 30;
        evidence.directoryStructure = expressIndicators.slice(0, 3);
      }
      
      if (projectInfo.projectType === 'backend' || projectInfo.projectType === 'fullstack') {
        score += 20;
      }
      
      if (projectInfo.packageJson?.dependencies?.['body-parser'] ||
          projectInfo.packageJson?.dependencies?.cors ||
          projectInfo.packageJson?.dependencies?.helmet) {
        score += 10;
      }
    }
    
    else if (name.includes('Angular')) {
      if (projectInfo.packageJson?.dependencies?.['@angular/core']) {
        score += 50;
        evidence.packageJsonMatch = true;
      }
      
      if (await fs.pathExists(path.join(this.projectPath, 'angular.json'))) {
        score += 40;
        evidence.configFiles = ['angular.json'];
      }
    }
    
    else if (name.includes('Vue')) {
      const vueFiles = projectInfo.fileTypes.get('.vue') || 0;
      if (vueFiles > 0) {
        score += 50;
        evidence.filePatterns = ['*.vue'];
      }
      
      if (projectInfo.packageJson?.dependencies?.vue) {
        score += 30;
        evidence.packageJsonMatch = true;
      }
    }
    
    else if (name.includes('Django')) {
      if (await fs.pathExists(path.join(this.projectPath, 'manage.py'))) {
        score += 50;
        evidence.configFiles = ['manage.py'];
      }
      
      if (projectInfo.files.some((f: string) => f.includes('settings.py'))) {
        score += 30;
        evidence.filePatterns = ['settings.py'];
      }
    }
    
    else if (name.includes('Spring')) {
      if (await fs.pathExists(path.join(this.projectPath, 'pom.xml'))) {
        score += 40;
        evidence.configFiles = ['pom.xml'];
      }
      
      if (await fs.pathExists(path.join(this.projectPath, 'build.gradle'))) {
        score += 40;
        evidence.configFiles = ['build.gradle'];
      }
    }
    
    else if (name.includes('TypeScript') || name.includes('JavaScript')) {
      if (projectInfo.mainLanguage === 'typescript' || projectInfo.mainLanguage === 'javascript') {
        score += 40;
        evidence.mainLanguage = projectInfo.mainLanguage;
      }
      
      if (!projectInfo.packageJson?.dependencies?.react && 
          !projectInfo.packageJson?.dependencies?.angular &&
          !projectInfo.packageJson?.dependencies?.vue) {
        score += 20;
      }
    }
    
    let confidence = 0;
    if (score >= 80) confidence = 0.95;
    else if (score >= 60) confidence = 0.85;
    else if (score >= 40) confidence = 0.70;
    else if (score >= 20) confidence = 0.50;
    else confidence = 0.30;
    
    return {
      analyzer: name,
      score,
      evidence,
      confidence
    };
  }
}