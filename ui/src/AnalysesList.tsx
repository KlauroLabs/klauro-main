import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArchitectureBlueprint } from './types';

interface StoredAnalysis {
  id: string;
  name: string;
  timestamp: number;
  blueprint: ArchitectureBlueprint;
  repositoryPath: string;
}

export default function AnalysesList() {
  const navigate = useNavigate();
  const [analyses, setAnalyses] = useState<StoredAnalysis[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Load analyses from localStorage
    try {
      const storedAnalyses = JSON.parse(localStorage.getItem('unravl-analyses') || '[]');
      setAnalyses(storedAnalyses);
    } catch (err) {
      console.error('Error loading analyses:', err);
    }
    setLoading(false);
  }, []);

  const deleteAnalysis = (analysisId: string) => {
    if (confirm('Are you sure you want to delete this analysis?')) {
      const updatedAnalyses = analyses.filter(a => a.id !== analysisId);
      setAnalyses(updatedAnalyses);
      localStorage.setItem('unravl-analyses', JSON.stringify(updatedAnalyses));
    }
  };

  const clearAllAnalyses = () => {
    if (confirm('Are you sure you want to delete ALL analyses? This cannot be undone.')) {
      setAnalyses([]);
      localStorage.removeItem('unravl-analyses');
    }
  };

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
          <h2>Loading Analyses...</h2>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', background: '#f5f7fa' }}>
      {/* Header */}
      <div style={{
        background: 'linear-gradient(90deg, #667eea 0%, #764ba2 100%)',
        color: 'white',
        padding: '30px 40px',
        boxShadow: '0 2px 10px rgba(0,0,0,0.1)'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h1 style={{ margin: '0 0 10px 0', fontSize: '32px' }}>
              📁 Your Analyses
            </h1>
            <p style={{ margin: 0, opacity: 0.9, fontSize: '16px' }}>
              {analyses.length} saved analysis{analyses.length !== 1 ? 'es' : ''}
            </p>
          </div>
          
          <div style={{ display: 'flex', gap: '15px' }}>
            <button
              onClick={() => navigate('/')}
              style={{
                background: 'rgba(255,255,255,0.1)',
                border: '2px solid rgba(255,255,255,0.3)',
                color: 'white',
                padding: '12px 24px',
                borderRadius: '25px',
                cursor: 'pointer',
                fontSize: '16px'
              }}
            >
              🏠 Home
            </button>
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
              ➕ New Analysis
            </button>
          </div>
        </div>
      </div>

      {/* Content */}
      <div style={{ padding: '40px' }}>
        {analyses.length === 0 ? (
          <div style={{
            textAlign: 'center',
            padding: '60px 40px',
            background: 'white',
            borderRadius: '16px',
            boxShadow: '0 4px 15px rgba(0,0,0,0.08)'
          }}>
            <div style={{ fontSize: '64px', marginBottom: '20px' }}>📊</div>
            <h2 style={{ color: '#333', marginBottom: '15px' }}>No Analyses Yet</h2>
            <p style={{ color: '#666', marginBottom: '30px', fontSize: '16px' }}>
              Start by analyzing your first repository to see it appear here.
            </p>
            <button
              onClick={() => navigate('/')}
              style={{
                background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                color: 'white',
                border: 'none',
                padding: '15px 30px',
                borderRadius: '25px',
                cursor: 'pointer',
                fontSize: '16px',
                fontWeight: 'bold'
              }}
            >
              🚀 Create Your First Analysis
            </button>
          </div>
        ) : (
          <>
            {/* Actions */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '30px' }}>
              <h2 style={{ color: '#333' }}>Recent Analyses</h2>
              <button
                onClick={clearAllAnalyses}
                style={{
                  background: '#ff4757',
                  color: 'white',
                  border: 'none',
                  padding: '8px 16px',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontSize: '14px'
                }}
              >
                🗑️ Clear All
              </button>
            </div>

            {/* Analyses grid */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(400px, 1fr))',
              gap: '25px'
            }}>
              {analyses.map(analysis => (
                <div
                  key={analysis.id}
                  style={{
                    background: 'white',
                    borderRadius: '16px',
                    padding: '25px',
                    boxShadow: '0 4px 15px rgba(0,0,0,0.08)',
                    transition: 'all 0.3s ease',
                    cursor: 'pointer',
                    border: '1px solid #e0e0e0'
                  }}
                  onClick={() => navigate(`/analysis/${analysis.id}/overview`)}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.transform = 'translateY(-5px)';
                    e.currentTarget.style.boxShadow = '0 8px 25px rgba(0,0,0,0.15)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.transform = 'translateY(0)';
                    e.currentTarget.style.boxShadow = '0 4px 15px rgba(0,0,0,0.08)';
                  }}
                >
                  {/* Header */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '15px' }}>
                    <h3 style={{ margin: 0, color: '#333', fontSize: '18px' }}>
                      📊 {analysis.name}
                    </h3>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteAnalysis(analysis.id);
                      }}
                      style={{
                        background: '#ff4757',
                        color: 'white',
                        border: 'none',
                        padding: '4px 8px',
                        borderRadius: '4px',
                        cursor: 'pointer',
                        fontSize: '12px'
                      }}
                    >
                      🗑️
                    </button>
                  </div>

                  {/* Metadata */}
                  <div style={{ marginBottom: '15px', fontSize: '14px', color: '#666' }}>
                    <div style={{ marginBottom: '5px' }}>
                      <strong>Path:</strong> {analysis.repositoryPath}
                    </div>
                    <div style={{ marginBottom: '5px' }}>
                      <strong>Analyzed:</strong> {new Date(analysis.timestamp).toLocaleString()}
                    </div>
                    <div>
                      <strong>ID:</strong> <code style={{ fontSize: '12px' }}>{analysis.id}</code>
                    </div>
                  </div>

                  {/* Stats */}
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr 1fr',
                    gap: '15px',
                    marginBottom: '15px'
                  }}>
                    <div style={{ textAlign: 'center' }}>
                      <div style={{ fontSize: '20px', fontWeight: 'bold', color: '#4CAF50' }}>
                        {analysis.blueprint.metadata.totalComponents}
                      </div>
                      <div style={{ fontSize: '12px', color: '#666' }}>Components</div>
                    </div>
                    <div style={{ textAlign: 'center' }}>
                      <div style={{ fontSize: '20px', fontWeight: 'bold', color: '#2196F3' }}>
                        {analysis.blueprint.metadata.entryPointsCount}
                      </div>
                      <div style={{ fontSize: '12px', color: '#666' }}>Entry Points</div>
                    </div>
                    <div style={{ textAlign: 'center' }}>
                      <div style={{ fontSize: '20px', fontWeight: 'bold', color: analysis.blueprint.riskAreas.filter(r => r.riskLevel === 'high').length > 0 ? '#f44336' : '#4CAF50' }}>
                        {analysis.blueprint.riskAreas.filter(r => r.riskLevel === 'high').length}
                      </div>
                      <div style={{ fontSize: '12px', color: '#666' }}>Critical Issues</div>
                    </div>
                  </div>

                  {/* Framework */}
                  <div style={{
                    background: '#f8f9fa',
                    padding: '8px 12px',
                    borderRadius: '6px',
                    fontSize: '12px',
                    color: '#666',
                    textAlign: 'center'
                  }}>
                    Framework: {analysis.blueprint.framework}
                  </div>

                  {/* Quick actions */}
                  <div style={{ marginTop: '15px', display: 'flex', gap: '8px' }}>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        const url = `${window.location.origin}/analysis/${analysis.id}/overview`;
                        navigator.clipboard.writeText(url);
                        alert('Analysis URL copied to clipboard!');
                      }}
                      style={{
                        background: '#2196F3',
                        color: 'white',
                        border: 'none',
                        padding: '6px 12px',
                        borderRadius: '4px',
                        cursor: 'pointer',
                        fontSize: '12px',
                        flex: 1
                      }}
                    >
                      🔗 Share
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate(`/analysis/${analysis.id}/category/route`);
                      }}
                      style={{
                        background: '#4CAF50',
                        color: 'white',
                        border: 'none',
                        padding: '6px 12px',
                        borderRadius: '4px',
                        cursor: 'pointer',
                        fontSize: '12px',
                        flex: 1
                      }}
                    >
                      🛣️ Routes
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}