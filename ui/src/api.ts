import axios from 'axios';
import { AnalysisRequest, AnalysisResponse } from './types';

const API_BASE_URL = 'http://localhost:3001/api';

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

export const analysisApi = {
  // Analyze a repository
  analyzeRepository: async (request: AnalysisRequest): Promise<AnalysisResponse> => {
    const response = await api.post<AnalysisResponse>('/analyze/repository', request);
    return response.data;
  },

  // Get available sample projects
  getSamples: async (): Promise<any> => {
    const response = await api.get('/analyze/samples');
    return response.data;
  },

  // Health check
  healthCheck: async (): Promise<any> => {
    const response = await api.get('/health');
    return response.data;
  },
};

export default api;