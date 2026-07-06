import { Router } from 'express';
import {
  listApiKeys,
  getApiKey,
  createApiKey,
  updateApiKey,
  removeApiKey,
} from '../controllers/apiKey.controller';

export const apiKeyRouter = Router();

apiKeyRouter.get('/', listApiKeys);
apiKeyRouter.get('/:id', getApiKey);
apiKeyRouter.post('/', createApiKey);
apiKeyRouter.put('/:id', updateApiKey);
apiKeyRouter.delete('/:id', removeApiKey);
