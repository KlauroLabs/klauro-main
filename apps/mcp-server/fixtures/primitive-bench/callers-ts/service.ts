import { Account } from './account';
export function persist(a: Account): void {
  a.save();
}
