import React, { useState, useEffect } from 'react';
import { useParams, useNavigate, Routes, Route } from 'react-router-dom';
import { ArchitectureBlueprint } from './types';
import ExplorerRouterView from './ExplorerRouterView';

interface StoredAnalysis {
  id: string;
  name: string;
  timestamp: number;
  blueprint: ArchitectureBlueprint;
  repositoryPath: string;
}

export default function AnalysisViewer() {
  const { analysisId } = useParams<{ analysisId: string }>();
  const navigate = useNavigate();
  const [blueprint, setBlueprint] = useState<ArchitectureBlueprint | null>(null);
  const [analysisInfo, setAnalysisInfo] = useState<StoredAnalysis | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!analysisId) {
      setError('No analysis ID provided');
      setLoading(false);
      return;
    }

    // Load analysis from localStorage
    try {
      const storedAnalyses = JSON.parse(localStorage.getItem('unravl-analyses') || '[]');
      const analysis = storedAnalyses.find((a: StoredAnalysis) => a.id === analysisId);

      if (!analysis) {
        setError('Analysis not found');
        setLoading(false);
        return;
      }

      setAnalysisInfo(analysis);
      setBlueprint(analysis.blueprint);
      setLoading(false);
    } catch (err) {
      console.error('Error loading analysis:', err);
      setError('Failed to load analysis');
      setLoading(false);
    }
  }, [analysisId]);

  if (loading) {
    return (
      <div style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        height: '80vh',
        background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
        color: 'white'
      }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '48px', marginBottom: '20px' }}>🔄</div>
          <h2>Loading Analysis...</h2>
          <p>Analysis ID: {analysisId}</p>
        </div>
      </div>
    );
  }

  if (error || !blueprint) {
    return (
      <div style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        height: '80vh',
        background: 'linear-gradient(135deg, #ff7b7b 0%, #ff6b9d 100%)',
        color: 'white'
      }}>
        <div style={{ textAlign: 'center', maxWidth: '500px' }}>
          <div style={{ fontSize: '48px', marginBottom: '20px' }}>❌</div>
          <h2>Analysis Not Found</h2>
          <p style={{ marginBottom: '30px' }}>
            {error || `Could not find analysis with ID: ${analysisId}`}
          </p>
          <div style={{ display: 'flex', gap: '15px', justifyContent: 'center' }}>
            <button
              onClick={() => navigate('/')}
              style={{
                background: 'rgba(255,255,255,0.2)',
                border: '2px solid rgba(255,255,255,0.3)',
                color: 'white',
                padding: '12px 24px',
                borderRadius: '25px',
                cursor: 'pointer',
                fontSize: '16px'
              }}
            >
              🏠 Go Home
            </button>
            <button
              onClick={() => navigate('/analyses')}
              style={{
                background: 'rgba(255,255,255,0.2)',
                border: '2px solid rgba(255,255,255,0.3)',
                color: 'white',
                padding: '12px 24px',
                borderRadius: '25px',
                cursor: 'pointer',
                fontSize: '16px'
              }}
            >
              📁 View All Analyses
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh' }}>
      {/* Analysis header */}
      <div style={{
        background: 'linear-gradient(90deg, #667eea 0%, #764ba2 100%)',
        color: 'white',
        padding: '20px',
        boxShadow: '0 2px 10px rgba(0,0,0,0.1)'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h1 style={{ margin: '0 0 5px 0', fontSize: '24px' }}>
              📊 {analysisInfo?.name}
            </h1>
            <div style={{ opacity: 0.9, fontSize: '14px' }}>
              <span>Analysis ID: {analysisId}</span>
              <span style={{ margin: '0 15px' }}>•</span>
              <span>Analyzed: {analysisInfo ? new Date(analysisInfo.timestamp).toLocaleString() : ''}</span>
              <span style={{ margin: '0 15px' }}>•</span>
              <span>{blueprint.metadata.totalComponents} components</span>
            </div>
          </div>
          
          <div style={{ display: 'flex', gap: '10px' }}>
            <button
              onClick={() => {
                const url = `${window.location.origin}/analysis/${analysisId}/overview`;
                navigator.clipboard.writeText(url);
                alert('Analysis URL copied to clipboard!');
              }}
              style={{
                background: 'rgba(255,255,255,0.1)',
                border: '1px solid rgba(255,255,255,0.3)',
                color: 'white',
                padding: '8px 16px',
                borderRadius: '6px',
                cursor: 'pointer',
                fontSize: '14px'
              }}
            >
              🔗 Share
            </button>
            <button
              onClick={() => navigate('/')}
              style={{
                background: 'rgba(255,255,255,0.1)',
                border: '1px solid rgba(255,255,255,0.3)',
                color: 'white',
                padding: '8px 16px',
                borderRadius: '6px',
                cursor: 'pointer',
                fontSize: '14px'
              }}
            >
              🏠 Home
            </button>
            <button
              onClick={() => navigate('/analyses')}
              style={{
                background: 'rgba(255,255,255,0.1)',
                border: '1px solid rgba(255,255,255,0.3)',
                color: 'white',
                padding: '8px 16px',
                borderRadius: '6px',
                cursor: 'pointer',
                fontSize: '14px'
              }}
            >
              📁 All Analyses
            </button>
          </div>
        </div>
      </div>

      {/* Explorer view with nested routing */}
      <div style={{ background: 'white' }}>
        <Routes>
          <Route path="overview" element={<ExplorerRouterView blueprint={blueprint} />} />
          <Route path="category/:category" element={<ExplorerRouterView blueprint={blueprint} />} />
          <Route path="component/:componentId" element={<ExplorerRouterView blueprint={blueprint} />} />
          <Route path="*" element={<ExplorerRouterView blueprint={blueprint} />} />
        </Routes>
      </div>
    </div>
  );
}