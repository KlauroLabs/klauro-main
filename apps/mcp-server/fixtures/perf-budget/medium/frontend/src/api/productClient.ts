import type { Product } from '../types/product';

const BASE_URL = '/api/products';

export async function fetchProducts(): Promise<Product[]> {
  const response = await fetch(BASE_URL);
  return response.json();
}

export async function fetchProduct(id: string): Promise<Product> {
  const response = await fetch(`${BASE_URL}/${id}`);
  return response.json();
}

export async function createProduct(payload: Partial<Product>): Promise<Product> {
  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.json();
}
