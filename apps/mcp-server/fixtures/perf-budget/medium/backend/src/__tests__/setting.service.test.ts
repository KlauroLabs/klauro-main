import { settingService } from '../services/setting.service';

describe('SettingService', () => {
  it('creates and retrieves a setting', async () => {
    const created = await settingService.create({ name: 'sample-setting', status: 'setting_active' });
    const fetched = await settingService.get(created.id);
    expect(fetched).toEqual(created);
  });
});
