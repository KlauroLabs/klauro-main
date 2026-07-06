import { deviceService } from '../services/device.service';

describe('DeviceService', () => {
  it('creates and retrieves a device', async () => {
    const created = await deviceService.create({ name: 'sample-device', status: 'device_active' });
    const fetched = await deviceService.get(created.id);
    expect(fetched).toEqual(created);
  });
});
