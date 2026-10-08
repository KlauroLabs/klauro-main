import { test as setup } from '@playwright/test';

setup('sign in', async ({ page }) => {
  await page.goto('/login');
});
