import { Router } from 'express';
import {
  listCampaigns,
  getCampaign,
  createCampaign,
  updateCampaign,
  removeCampaign,
} from '../controllers/campaign.controller';

export const campaignRouter = Router();

campaignRouter.get('/', listCampaigns);
campaignRouter.get('/:id', getCampaign);
campaignRouter.post('/', createCampaign);
campaignRouter.put('/:id', updateCampaign);
campaignRouter.delete('/:id', removeCampaign);
