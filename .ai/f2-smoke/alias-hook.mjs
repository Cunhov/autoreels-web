// Resolve "@/..." alias (tsconfig paths) e relativos sem extensão para node
// com type-stripping (ESM exige extensão; projetos Next usam extensionless).
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";

function resolveFile(specifier, parentURL) {
  const root = process.cwd();
  // Prisma 7: `Prisma` é namespace apenas-de-tipos no nosso código (usado só
  // em posições de tipo) — sem export runtime; shim puro para o smoke test.
  if (specifier === "@prisma/client" || specifier === "@prisma/client/index") {
    return pathToFileURL(path.join(root, ".ai/f2-smoke/prisma-shim.mjs")).href;
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