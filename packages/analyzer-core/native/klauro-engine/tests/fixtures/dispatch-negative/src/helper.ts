export function configureMode(mode: string) {
  if (mode === 'fast') {
    return true;
  }
  return mode === 'slow';
}
