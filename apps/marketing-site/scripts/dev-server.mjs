import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../src/", import.meta.url));
const publicRoot = fileURLToPath(new URL("../public/", import.meta.url));
const port = Number(process.env.PORT || 4321);

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

function resolvePath(urlPath) {
  const clean = normalize(decodeURIComponent(urlPath.split("?")[0])).replace(/^(\.\.[/\\])+/, "");
  const relative = clean === "/" ? "index.html" : clean.replace(/^[/\\]/, "");
  const base = relative.startsWith("_") || relative.startsWith("assets/") || relative === "robots.txt" ? publicRoot : root;
  return join(base, relative);
}

const server = createServer(async (req, res) => {
  try {
    const path = resolvePath(req.url || "/");
    const info = await stat(path);
    if (!info.isFile()) throw new Error("Not a file");
    res.writeHead(200, { "content-type": types[extname(path)] || "application/octet-stream" });
    createReadStream(path).pipe(res);
  } catch {
    const fallback = join(root, "index.html");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    createReadStream(fallback).pipe(res);
  }
});

server.listen(port, () => {
  console.log(`Klauro marketing site running at http://localhost:${port}`);
});
