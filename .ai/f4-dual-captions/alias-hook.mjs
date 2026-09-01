// Resolve "@/..." alias (tsconfig paths) e relativos sem extensão para node
// com type-stripping (ESM exige extensão; projetos Next usam extensionless).
// F4 smoke test: overrides dirigidos p/ os módulos dos quais as rotas sob
// teste dependem (next/server, next-auth, prisma, auth, upload-chunk helpers,
// ffmpeg) — espelha o alias-hook do .ai/f2-smoke, com shims extras p/ rodar
// app/api/upload-chunk/complete e app/api/content-items fora do Next.
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";

const root = process.cwd();

const OVERRIDES = {
  "@prisma/client": ".ai/f4-dual-captions/prisma-shim.mjs",
  "next/server": ".ai/f4-dual-captions/shim-next-server.mjs",
  "next-auth": ".ai/f4-dual-captions/shim-next-auth.mjs",
  "@/lib/prisma": ".ai/f4-dual-captions/shim-prisma.mjs",
  "@/lib/auth": ".ai/f4-dual-captions/shim-auth.mjs",
  "@/app/api/upload-chunk/route": ".ai/f4-dual-captions/shim-upload-chunk-route.mjs",
  "@/lib/ffmpeg": ".ai/f4-dual-captions/shim-ffmpeg.mjs",
};

function resolveFile(specifier, parentURL) {
  const override = OVERRIDES[specifier];
  if (override) {
    return pathToFileURL(path.join(root, override)).href;
  }
  let p;
  if (specifier.startsWith("@/")) {
    p = path.join(root, specifier.slice(2));
  } else if (specifier.startsWith(".")) {
    const base = parentURL ? path.dirname(new URL(parentURL).pathname) : root;
    p = path.resolve(base, specifier);
  } else {
    return null;
  }
  if (!path.extname(p) && fs.existsSync(p + ".ts")) {
    return pathToFileURL(p + ".ts").href;
  }
  if (!path.extname(p) && fs.existsSync(p + ".tsx")) {
    return pathToFileURL(p + ".tsx").href;
  }
  return pathToFileURL(p).href;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const mapped = resolveFile(specifier, context.parentURL);
    if (mapped) return nextResolve(mapped, context);
    return nextResolve(specifier, context);
  },
});