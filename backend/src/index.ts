import express from 'express';
import cors from 'cors';
import { analyzeRoutes } from './routes/analyze';
import { initializeAnalyzerSystem, getAnalyzerStatistics } from './analyzer/analyzer-bootstrap';
// import { analysesRoutes } from './routes/analyses';

const app = express();
const PORT = process.env.PORT || 3001;

// Initialize analyzer system
async function startServer() {
  try {
    console.log('🔧 Initializing Unravl Platform...');
    
    // Initialize the analyzer system with all official plugins
    await initializeAnalyzerSystem();
    
    // Middleware
    app.use(cors());
    app.use(express.json());
    app.use(express.static('public'));

    // Routes
    app.use('/api/analyze', analyzeRoutes);
    // app.use('/api/analyses', analysesRoutes);

    // Health check with analyzer statistics
    app.get('/api/health', (req, res) => {
      const stats = getAnalyzerStatistics();
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

    // Analyzer system information endpoint
    app.get('/api/analyzers', (req, res) => {
      const stats = getAnalyzerStatistics();
      res.json(stats);
    });

    app.listen(PORT, () => {
      console.log(`\n🎉 Unravl API Server Ready!`);
      console.log(`🚀 Server running on: http://localhost:${PORT}`);
      console.log(`📊 Health check: http://localhost:${PORT}/api/health`);
      console.log(`🔧 Analyzers info: http://localhost:${PORT}/api/analyzers`);
      console.log(`📈 Analysis endpoint: http://localhost:${PORT}/api/analyze`);
      
      const stats = getAnalyzerStatistics();
      console.log(`\n📋 System Status:`);
      console.log(`   • ${stats.totalPlugins} analyzers loaded`);
      console.log(`   • ${stats.supportedLanguages.length} languages supported`);
      console.log(`   • ${stats.supportedFrameworks.length} frameworks detected`);
      console.log(`\n✨ Ready to analyze codebases!\n`);
    });

  } catch (error) {
    console.error('💥 Failed to start Unravl server:', error);
    process.exit(1);
  }
}

// Start the server with proper error handling
startServer().catch(error => {
  console.error('💥 Startup error:', error);
  process.exit(1);
});