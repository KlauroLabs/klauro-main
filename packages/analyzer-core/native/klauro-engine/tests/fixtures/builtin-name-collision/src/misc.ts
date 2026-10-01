export function slugify(input) {
  return input.replaceAll(' ', '-');
}

export function escapeTitle(title) {
  return title.text.replaceAll('"', '');
}
