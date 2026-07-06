import type { Review } from '../types/review';

const BASE_URL = '/api/reviews';

export async function fetchReviews(): Promise<Review[]> {
  const response = await fetch(BASE_URL);
  return response.json();
}

export async function fetchReview(id: string): Promise<Review> {
  const response = await fetch(`${BASE_URL}/${id}`);
  return response.json();
}

export async function createReview(payload: Partial<Review>): Promise<Review> {
  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.json();
}
