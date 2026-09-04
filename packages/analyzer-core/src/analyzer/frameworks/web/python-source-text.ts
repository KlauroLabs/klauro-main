export function maskPythonTripleQuotedStrings(content: string): string {
  const lines = content.split('\n');
  let open: '"""' | "'''" | null = null;
  return lines.map(line => {
    let cursor = 0;
    let out = '';
    while (cursor < line.length) {
      if (open) {
        const close = line.indexOf(open, cursor);
        if (close === -1) { cursor = line.length; break; }
        cursor = close + 3;
        open = null;
        continue;
      }
      const dq = line.indexOf('"""', cursor);
      const sq = line.indexOf("'''", cursor);
      const next = dq === -1 ? sq : sq === -1 ? dq : Math.min(dq, sq);
      if (next === -1) { out += line.slice(cursor); cursor = line.length; break; }
      out += line.slice(cursor, next);
      open = line.startsWith('"""', next) ? '"""' : "'''";
      cursor = next + 3;
      const close = line.indexOf(open, cursor);
      if (close !== -1) { cursor = close + 3; open = null; }
      else cursor = line.length;
    }
    return out;
  }).join('\n');
}
