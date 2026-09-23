export function save(path, data) {
  return fetch(`/api/${path}`, { method: 'POST', body: JSON.stringify(data) });
}
