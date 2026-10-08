import { test } from '@playwright/test';
import { addToCart } from './cart-helpers';

test('adds an item', async ({ page }) => {
  await page.goto('/');
  await addToCart(page);
});
