export function follow(id) {
  const source = new EventSource('/stream/' + id);
  source.onmessage = (event) => console.log(event.data);
  return source;
}
