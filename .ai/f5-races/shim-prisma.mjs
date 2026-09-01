// Prisma fake dirigido por estado: cada teste seta globalThis.__PRISMA__ com
// os handlers necessários (findUnique/updateMany/create/findMany/...).
// Proxy genérico — QUALQUER model.método resolve para o handler do teste.
export const prisma = new Proxy(
  {},
  {
    get(_target, model) {
      return new Proxy(
        {},
        {
          get(_m, method) {
            return async (args, ...rest) => {
              const st = globalThis.__PRISMA__ || {};
              const fn = st[model]?.[method];
              if (fn) return fn(args, ...rest);
              // fallbacks no-op para métodos não-informados
              return { count: 0 };
            };
          },
        },
      );
    },
  },
);