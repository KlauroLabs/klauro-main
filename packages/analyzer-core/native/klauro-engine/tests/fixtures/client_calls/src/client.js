import axios from 'axios';

function api() {
  return axios.create({ baseURL: '/' });
}

export function mute(id) {
  return api().post(`/api/v1/accounts/${id}/mute`);
}

export function load() {
  return api().get('/api/v1/accounts/load');
}
