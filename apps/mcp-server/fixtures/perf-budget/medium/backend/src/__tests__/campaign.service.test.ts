import { campaignService } from '../services/campaign.service';

describe('CampaignService', () => {
  it('creates and retrieves a campaign', async () => {
    const created = await campaignService.create({ name: 'sample-campaign', status: 'campaign_active' });
    const fetched = await campaignService.get(created.id);
    expect(fetched).toEqual(created);
  });
});
