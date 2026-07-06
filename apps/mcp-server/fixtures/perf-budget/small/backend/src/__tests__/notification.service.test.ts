import { notificationService } from '../services/notification.service';

describe('NotificationService', () => {
  it('creates and retrieves a notification', async () => {
    const created = await notificationService.create({ name: 'sample-notification', status: 'notification_active' });
    const fetched = await notificationService.get(created.id);
    expect(fetched).toEqual(created);
  });
});
