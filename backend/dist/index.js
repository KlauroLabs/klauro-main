"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const analyze_1 = require("./routes/analyze");
const analyzer_bootstrap_1 = require("./analyzer/analyzer-bootstrap");
const app = (0, express_1.default)();
const PORT = process.env.PORT || 3001;
async function startServer() {
    try {
        console.log('🔧 Initializing Unravl Platform...');
        await (0, analyzer_bootstrap_1.initializeAnalyzerSystem)();
        app.use((0, cors_1.default)());
        app.use(express_1.default.json());
        app.use(express_1.default.static('public'));
        app.use('/api/analyze', analyze_1.analyzeRoutes);
        app.get('/api/health', (req, res) => {
            const stats = (0, analyzer_bootstrap_1.getAnalyzerStatistics)();
            res.json({
                status: 'OK',
                message: 'Unravl API is running',
                analyzers: {
                    total: stats.totalPlugins,
                    official: stats.officialPlugins,
                    community: stats.communityPlugins,
                    languages: stats.supportedLanguages.length,
                    frameworks: stats.supportedFrameworks.length
                },
                timestamp: new Date().toISOString()
            });
        });
        app.get('/api/analyzers', (req, res) => {
            const stats = (0, analyzer_bootstrap_1.getAnalyzerStatistics)();
            res.json(stats);
        });
        app.listen(PORT, () => {
            console.log(`\n🎉 Unravl API Server Ready!`);
            console.log(`🚀 Server running on: http://localhost:${PORT}`);
            console.log(`📊 Health check: http://localhost:${PORT}/api/health`);
            console.log(`🔧 Analyzers info: http://localhost:${PORT}/api/analyzers`);
            console.log(`📈 Analysis endpoint: http://localhost:${PORT}/api/analyze`);
            const stats = (0, analyzer_bootstrap_1.getAnalyzerStatistics)();
            console.log(`\n📋 System Status:`);
            console.log(`   • ${stats.totalPlugins} analyzers loaded`);
            console.log(`   • ${stats.supportedLanguages.length} languages supported`);
            console.log(`   • ${stats.supportedFrameworks.length} frameworks detected`);
            console.log(`\n✨ Ready to analyze codebases!\n`);
        });
    }
    catch (error) {
        console.error('💥 Failed to start Unravl server:', error);
        process.exit(1);
    }
}
startServer().catch(error => {
    console.error('💥 Startup error:', error);
    process.exit(1);
});
