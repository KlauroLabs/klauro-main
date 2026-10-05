import { API_ROOT } from './config';

function call(path: string, method: string) {
  return fetch(`${API_ROOT}${path}`, { method });
}

export function payInvoice(id: string) {
  return call(`/invoices/${id}/pay`, 'GET');
}
