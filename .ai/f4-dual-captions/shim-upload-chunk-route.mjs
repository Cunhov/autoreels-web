// Helpers de staging p/ o smoke test do upload-chunk/complete: getUploadsDir
// aponta para um diretório temporário setado pelo teste; listPartIndices
// espelha a descoberta dos .part.{i} do app real.
import fs from "node:fs";
import path from "node:path";

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function getUploadsDir() {
  if (!globalThis.__UPLOADS_DIR__) {
    throw new Error("set globalThis.__UPLOADS_DIR__ antes do teste");
  }
  return globalThis.__UPLOADS_DIR__;
}

export async function listPartIndices(partBase) {
  const dir = path.dirname(partBase);
  if (!fs.existsSync(dir)) return [];
  const base = path.basename(partBase);
  const re = new RegExp(`^${escapeRe(base)}\\.part\\.(\\d+)$`);
  const indices = [];
  for (const f of fs.readdirSync(dir)) {
    const m = f.match(re);
    if (m) indices.push(Number(m[1]));
  }
  return indices.sort((a, b) => a - b);
}