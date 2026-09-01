// Shim de runtime p/ o smoke test (F4): o código usa `Prisma` somente em
// posições de tipo — Prisma 7 não exporta um valor runtime com esse nome;
// Next/SWC elide, node não.
export const Prisma = {};