export async function fake() {
  return fetch("https://api.fake-only-in-tests.io/v1/thing");
}
