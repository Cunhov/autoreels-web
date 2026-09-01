// Shim de runtime: Prisma 7 não exporta um valor `Prisma` em runtime (só
// tipos). node não elide, então fornecemos um objeto vazio — o código usa
// `Prisma` apenas em posições de tipo.
export const Prisma = {};