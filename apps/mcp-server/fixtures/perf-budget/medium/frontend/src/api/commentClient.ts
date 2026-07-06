import type { Comment } from '../types/comment';

const BASE_URL = '/api/comments';

export async function fetchComments(): Promise<Comment[]> {
  const response = await fetch(BASE_URL);
  return response.json();
}

export async function fetchComment(id: string): Promise<Comment> {
  const response = await fetch(`${BASE_URL}/${id}`);
  return response.json();
}

export async function createComment(payload: Partial<Comment>): Promise<Comment> {
  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.json();
}
