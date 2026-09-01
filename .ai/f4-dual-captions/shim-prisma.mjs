// Prisma fake dirigido por estado: o teste seta globalThis.__PRISMA__ com os
// handlers necessários (findFirst/create/aggregate) antes de chamar a rota.
export const prisma = {
  contentItem: {
    async findFirst(args) {
      const st = globalThis.__PRISMA__ || {};
      const fn = st.contentItem?.findFirst;
      if (fn) return fn(args);
      return null;
    },
    async findMany(args) {
      const st = globalThis.__PRISMA__ || {};
      const fn = st.contentItem?.findMany;
      if (fn) return fn(args);
      return [];
    },
    async create(args) {
      const st = globalThis.__PRISMA__ || {};
      const fn = st.contentItem?.create;
      if (fn) return fn(args);
      return { id: "created", ...(args.data || {}) };
    },
    async count(args) {
      const st = globalThis.__PRISMA__ || {};
      const fn = st.contentItem?.count;
      if (fn) return fn(args);
      return 0;
    },
    async aggregate(args) {
      const st = globalThis.__PRISMA__ || {};
      const fn = st.contentItem?.aggregate;
      if (fn) return fn(args);
      return { _sum: { size: 0 } };
    },
  },
};