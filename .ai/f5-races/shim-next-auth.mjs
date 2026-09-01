// Shim de "next-auth" p/ o smoke test: sessão fake com user.id (as rotas leem
// via getSessionUserId) — espelha o shim do F4.
export async function getServerSession() {
  return { user: { id: "u1", name: "Teste" } };
}
export default { getServerSession };