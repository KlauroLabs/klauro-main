import axios from 'axios';

export function nothing() {
}

export async function fetchUser(id: string): Promise<string> {
  if (!id) {
    throw new Error('id is required');
  }
  const response = await axios.get(`/users/${id}`);
  return response.data;
}
