export function persist(amount: number) {
  if (amount < 0) throw new Error('negative balance');
  return amount;
}

export function settle(amount: number) {
  return persist(amount) * 2;
}
