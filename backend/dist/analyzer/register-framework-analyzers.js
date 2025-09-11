"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerFrameworkAnalyzers = registerFrameworkAnalyzers;
exports.autoRegisterFrameworkAnalyzer = autoRegisterFrameworkAnalyzer;
exports.getFrameworkAnalyzerRecommendations = getFrameworkAnalyzerRecommendations;
const frameworks_1 = require("./frameworks");
const telemetry_schema_1 = require("../telemetry/telemetry-schema");
async function registerFrameworkAnalyzers(registry) {
    const span = telemetry_schema_1.telemetry.createSpan('register-framework-analyzers');
    console.log('📦 Registering framework analyzers...');
    let successCount = 0;
    let failureCount = 0;
    for (const analyzerInfo of frameworks_1.FRAMEWORK_ANALYZERS) {
        try {
            const plugin = {
                id: `unravl.framework.${analyzerInfo.name.toLowerCase().replace(/[.\s]/g, '-')}`,
                name: `${analyzerInfo.name} Framework Analyzer`,
                version: '1.0.0',
                description: `Specialized analyzer for ${analyzerInfo.name} framework projects`,
                author: 'Unravl Team',
                analyzer: analyzerInfo.analyzer,
                supportedLanguages: analyzerInfo.languages,
                supportedFrameworks: analyzerInfo.frameworks,
                type: 'official',
                category: 'framework',
                priority: analyzerInfo.priority,
                metadata: {
                    minEngineVersion: '1.0.0',
                    license: 'MIT',
                    keywords: [
                        analyzerInfo.name.toLowerCase(),
                        analyzerInfo.category,
                        ...analyzerInfo.frameworks
                    ],
                    maintainers: ['Unravl Team'],
                    lastUpdated: new Date(),
                    verified: true,
                    homepage: 'https://unravl.io/analyzers/' + analyzerInfo.name.toLowerCase(),
                    repository: 'https://github.com/unravl/analyzers',
                    documentation: 'https://docs.unravl.io/analyzers/' + analyzerInfo.name.toLowerCase()
                },
                dependencies: [
                    {
                        name: `unravl.language.${analyzerInfo.languages[0]}`,
                        version: '1.0.0',
                        type: 'required',
                        description: `Requires ${analyzerInfo.languages[0]} base analyzer`
                    }
                ],
                configuration: {
                    schema: {
                        type: 'object',
                        properties: {
                            enabled: { type: 'boolean', default: true },
                            depth: { type: 'number', default: 3 },
                            excludePatterns: {
                                type: 'array',
                                items: { type: 'string' },
                                default: ['node_modules', 'dist', 'build', '.git']
                            }
                        }
                    },
                    defaults: {
                        enabled: true,
                        depth: 3,
                        excludePatterns: ['node_modules', 'dist', 'build', '.git']
                    },
                    required: []
                }
            };
            await registry.registerPlugin(plugin);
            successCount++;
            telemetry_schema_1.telemetry.emit({
                type: 'framework_analyzer_registered',
                source: { analyzer: 'framework-registration' },
                data: {
                    analyzerName: analyzerInfo.name,
                    pluginId: plugin.id,
                    category: analyzerInfo.category,
                    frameworks: analyzerInfo.frameworks
                }
            });
        }
        catch (error) {
            failureCount++;
            console.error(`❌ Failed to register ${analyzerInfo.name} analyzer:`, error);
            telemetry_schema_1.telemetry.emit({
                type: 'error_occurred',
                source: { analyzer: 'framework-registration' },
                data: {
                    analyzerName: analyzerInfo.name,
                    error: error instanceof Error ? error.message : String(error)
                }
            });
        }
    }
    console.log(`✅ Registered ${successCount} framework analyzers`);
    if (failureCount > 0) {
        console.log(`⚠️ Failed to register ${failureCount} framework analyzers`);
    }
    span.end();
}
async function autoRegisterFrameworkAnalyzer(registry, projectPath, detectedLanguage, detectedFrameworks) {
    const span = telemetry_schema_1.telemetry.createSpan('auto-register-framework-analyzer');
    console.log(`🔍 Auto-detecting framework analyzer for ${detectedLanguage} with frameworks:`, detectedFrameworks);
    let bestMatch = null;
    let highestPriority = -1;
    for (const analyzerInfo of frameworks_1.FRAMEWORK_ANALYZERS) {
        if (!analyzerInfo.languages.includes(detectedLanguage.toLowerCase())) {
            continue;
        }
        const frameworkMatch = analyzerInfo.frameworks.some(fw => detectedFrameworks.some(detected => {
            const fwLower = fw.toLowerCase();
            const detectedLower = detected.toLowerCase();
            return fwLower === detectedLower ||
                fwLower.includes(detectedLower) ||
                detectedLower.includes(fwLower);
        }));
        if (frameworkMatch && analyzerInfo.priority > highestPriority) {
            bestMatch = analyzerInfo;
            highestPriority = analyzerInfo.priority;
        }
    }
    if (bestMatch) {
        const pluginId = `unravl.framework.${bestMatch.name.toLowerCase().replace(/[.\s]/g, '-')}`;
        const existingPlugin = registry.getPlugin(pluginId);
        if (!existingPlugin) {
            const plugin = {
                id: pluginId,
                name: `${bestMatch.name} Framework Analyzer`,
                version: '1.0.0',
                description: `Auto-detected analyzer for ${bestMatch.name} framework`,
                author: 'Unravl Team',
                analyzer: bestMatch.analyzer,
                supportedLanguages: bestMatch.languages,
                supportedFrameworks: bestMatch.frameworks,
                type: 'official',
                category: 'framework',
                priority: bestMatch.priority,
                metadata: {
                    minEngineVersion: '1.0.0',
                    license: 'MIT',
                    keywords: bestMatch.frameworks,
                    maintainers: ['Unravl Team'],
                    lastUpdated: new Date(),
                    verified: true,
                    autoDetected: true
                },
                dependencies: [],
                configuration: {
                    schema: {},
                    defaults: {},
                    required: []
                }
            };
            await registry.registerPlugin(plugin);
        }
        console.log(`✅ Auto-registered ${bestMatch.name} framework analyzer`);
        telemetry_schema_1.telemetry.emit({
            type: 'framework_analyzer_auto_detected',
            source: { analyzer: 'framework-registration' },
            data: {
                analyzerName: bestMatch.name,
                pluginId,
                detectedLanguage,
                detectedFrameworks
            }
        });
        span.end();
        return pluginId;
    }
    console.log('ℹ️ No matching framework analyzer found');
    span.end();
    return null;
}
function getFrameworkAnalyzerRecommendations(detectedLanguage, detectedFrameworks, projectFiles) {
    const recommendations = [];
    for (const analyzerInfo of frameworks_1.FRAMEWORK_ANALYZERS) {
        if (!analyzerInfo.languages.includes(detectedLanguage.toLowerCase())) {
            continue;
        }
        let score = 0;
        for (const fw of analyzerInfo.frameworks) {
            if (detectedFrameworks.some(d => d.toLowerCase().includes(fw.toLowerCase()))) {
                score += 10;
            }
        }
        if (analyzerInfo.name === 'React' && projectFiles.some(f => f.endsWith('.jsx') || f.endsWith('.tsx'))) {
            score += 5;
        }
        if (analyzerInfo.name === 'Vue' && projectFiles.some(f => f.endsWith('.vue'))) {
            score += 5;
        }
        if (analyzerInfo.name === 'Angular' && projectFiles.some(f => f === 'angular.json')) {
            score += 10;
        }
        if (analyzerInfo.name === 'Django' && projectFiles.some(f => f === 'manage.py')) {
            score += 10;
        }
        if (analyzerInfo.name === 'Next.js' && projectFiles.some(f => f.includes('next.config'))) {
            score += 15;
        }
        if (score > 0) {
            recommendations.push(`${analyzerInfo.name} (score: ${score})`);
        }
    }
    recommendations.sort((a, b) => {
        const scoreA = parseInt(a.match(/score: (\d+)/)?.[1] || '0');
        const scoreB = parseInt(b.match(/score: (\d+)/)?.[1] || '0');
        return scoreB - scoreA;
    });
    return recommendations;
}
