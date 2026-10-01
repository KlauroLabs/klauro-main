import { execSync } from 'child_process';

export function bill() {
  execSync('billing-worker --once');
}
