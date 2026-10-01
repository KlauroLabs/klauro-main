export function Lists() {
  return import('./pages/ListsPage');
}

export function Detail() {
  return import('./pages/DetailPage').then((held) => ({ default: held.DetailPage }));
}

export function Wrapped() {
  return import('./pages/WrappedPage');
}
