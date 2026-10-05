import axios from 'axios';

const http = axios.create({ baseURL: '/api' });

export async function createCustomer(body: object) {
  return http.post('/customers', body);
}

export async function removeShipment(id: string) {
  return http.delete(`/shipments/${id}`);
}
