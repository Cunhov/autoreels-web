// Shim de "next-auth" p/ o smoke test: getServerSession devolve uma sessão
// fake com user.id (as rotas leem via getSessionUserId).
export async function getServerSession() {
  return { user: { id: "u1", name: "Teste" } };
}
export default {};