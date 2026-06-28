export class Logger {
  save(): void { /* unrelated save on a DIFFERENT class */ }
}
export function logIt(l: Logger): void {
  l.save();
}
