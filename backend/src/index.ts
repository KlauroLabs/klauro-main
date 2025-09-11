import express from 'express';
import cors from 'cors';
import { analyzeRoutes } from './routes/analyze';
// import { analysesRoutes } from './routes/analyses';

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Routes
app.use('/api/analyze', analyzeRoutes);
// app.use('/api/analyses', analysesRoutes);

app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'Unravl API is running' });
});

app.listen(PORT, () => {
  console.log(`🚀 Unravl API server running on port ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/api/health`);
});