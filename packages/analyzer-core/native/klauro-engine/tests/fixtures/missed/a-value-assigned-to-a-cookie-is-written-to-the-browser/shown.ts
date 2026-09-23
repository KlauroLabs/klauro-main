export function remember(value: string) {
  document.cookie = `state=${value}; path=/; max-age=${7 * 24 * 60 * 60}`;
}
