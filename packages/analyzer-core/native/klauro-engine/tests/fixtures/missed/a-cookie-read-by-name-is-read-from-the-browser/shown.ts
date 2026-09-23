export function recall(fallback: string) {
  const cookie = document.cookie.split('; ').find((held) => held.startsWith('state='));
  return cookie ? cookie.split('=')[1] : fallback;
}
