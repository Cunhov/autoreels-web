// Shim mínimo de "next/server" para rodar rotas fora do Next.
export class NextResponse extends Response {
  static json(body, init = {}) {
    return new Response(JSON.stringify(body), {
      status: init.status || 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  static redirect(url, init = {}) {
    return new Response(null, {
      status: init.status || 307,
      headers: { Location: url },
    });
  }
}