// F5-RACES alias hook: resolve "@/..." (tsconfig paths) e relativos sem
// extensão para node (ESM exige extensão). Overrides dirigidos para os módulos
// dos quais as rotas/libs sob teste dependem (next/server, next-auth,
// @prisma/client, @/lib/prisma, @/lib/auth) — espelha o alias-hook do F4.
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";

const root = process.cwd();

const OVERRIDES = {
  "@prisma/client": ".ai/f5-races/prisma-shim.mjs",
  "next/server": ".ai/f5-races/shim-next-server.mjs",
  "next-auth": ".ai/f5-races/shim-next-auth.mjs",
  "@/lib/prisma": ".ai/f5-races/shim-prisma.mjs",
  "@/lib/auth": ".ai/f5-races/shim-auth.mjs",
  "sharp": ".ai/f5-races/shim-sharp.mjs",
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