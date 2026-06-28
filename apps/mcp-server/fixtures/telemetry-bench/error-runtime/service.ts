export function persist(x: number): number {
  if (x < 0) {
    throw new Error('negative balance');
  }
  return store(x);
}

function store(x: number): number {
  return x * 2;
}
