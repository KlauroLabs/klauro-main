import { Account as Acct } from './account';
export function archive(x: Acct): void {
  x.save();
}
