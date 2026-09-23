import * as store from './store.js';

export async function keep(item) {
  return store.save('items', item);
}
