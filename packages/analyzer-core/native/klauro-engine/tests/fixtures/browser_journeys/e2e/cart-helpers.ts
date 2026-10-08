import { expect, Page } from '@playwright/test';

export async function addToCart(page: Page) {
  await page.getByRole('button', { name: 'Add to cart' }).click();
  await expect(page.getByText('1 item')).toBeVisible();
}
