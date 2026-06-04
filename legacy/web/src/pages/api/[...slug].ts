import { NextApiRequest, NextApiResponse } from 'next';
import { API_CONFIG } from '../../config/api';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const slug = req.query.slug as string[];
  const path = slug ? slug.join('/') : '';

  const url = `${API_CONFIG.baseURL}/api/${path}${req.url?.includes('?') ? req.url.substring(req.url.indexOf('?')) : ''}`;

  try {
    const headers: Record<string, string> = {};

    if (req.headers['content-type']) {
      headers['content-type'] = req.headers['content-type'] as string;
    }
    if (req.headers['authorization']) {
      headers['authorization'] = req.headers['authorization'] as string;
    }

    const fetchOptions: RequestInit = {
      method: req.method,
      headers,
    };

    if (req.method !== 'GET' && req.method !== 'HEAD' && req.body) {
      if (headers['content-type']?.includes('application/json')) {
        fetchOptions.body = JSON.stringify(req.body);
      } else {
        fetchOptions.body = req.body as any;
      }
    }

    const response = await fetch(url, fetchOptions);

    const data = await response.text();

    res.status(response.status);

    try {
      res.json(JSON.parse(data));
    } catch {
      res.send(data);
    }
  } catch (error) {
    console.error('Proxy error:', error);
    res.status(500).json({ error: 'Failed to proxy request' });
  }
}

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb',
    },
  },
};