import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const html = await readFile(join(root, "src/index.html"), "utf8");
const css = await readFile(join(root, "src/styles.css"), "utf8");

const required = [
  "Your million-line system",
  "Up to 97% fewer tokens",
  "Contact Klauro",
  "mike.shattuck@klauro.com",
  "Up to 88% faster",
  "Better codebase fit",
];

const forbidden = [
  /pricing/i,
  /try now/i,
  /get early access/i,
  /request beta access/i,
  /start setup/i,
];

const failures = [];
for (const phrase of required) {
  if (!html.includes(phrase)) failures.push(`Missing required phrase: ${phrase}`);
}
for (const pattern of forbidden) {
  if (pattern.test(html)) failures.push(`Forbidden copy still present: ${pattern}`);
}
if (/letter-spacing:\s*-\d/.test(css)) failures.push("Negative letter spacing found.");

const dist = join(root, "dist");
try {
  const distStat = await stat(dist);
  if (!distStat.isDirectory()) failures.push("dist is not a directory.");
  const distFiles = await readdir(dist);
  if (!distFiles.includes("index.html")) failures.push("dist/index.html missing.");
} catch {
  failures.push("dist directory missing. Run npm run build first.");
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("Marketing site checks passed.");
