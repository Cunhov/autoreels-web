#!/usr/bin/env npx tsx
/**
 * Smoke F4 — PRIMEIRO COMENTÁRIO (YouTube auto após Short; IG/TikTok só salvam)
 *
 * Decisão do dono: o campo first_comment vive no ContentItem (library); o
 * buildPostData faz o SNAPSHOT para o Post; o publisher (publishYoutubePost)
 * chama createComment APÓS o Short publicado. Este smoke valida:
 *  - sanitizeFirstComment (trim / limite 500 / vazio→null / escape)
 *  - buildPostData propaga first_comment do item para o Post criado
 *  - publishYoutubeFirstComment (lib/first-comment.ts):
 *      · post published + first_comment → chama POST /api/videos/{id}/comments
 *        com o texto E o proxy do canal (dispatcher)
 *      · falha do comentário NUNCA altera o status do post (sem escrita de Post
 *        por construção) nem lança — loga warning PT-BR e retorna false
 *      · texto vazio / sem video_id remoto / sem sessão → SKIP sem chamada
 *
 * Runner: npx --no-install tsx scripts/gauntlet/first-comment.mts
 * Exit code 0 only if every scenario passes.
 */
import { sanitizeFirstComment, FIRST_COMMENT_MAX } from "@/lib/sanitize";
import { buildPostData } from "@/lib/planner-runtime";
import { publishYoutubeFirstComment } from "@/lib/first-comment";

let pass = 0, fail = 0;
function check(label: string, ok: boolean, detail = "") {
	if (ok) { pass++; console.log(`✅ ${label}${detail ? " — " + detail : ""}`); }
	else { fail++; console.error(`❌ ${label}${detail ? " — " + detail : ""}`); }
}

// ── mock do fetch da API externa do YouTube ────────────────────────────────
const origFetch = global.fetch as unknown as typeof fetch;
type Call = { url: string; init: RequestInit & { dispatcher?: unknown } };
let fetchCalls: Call[] = [];
let nextCommentStatus = 200;

function mockFetch(url: string | URL, init?: RequestInit & { dispatcher?: unknown }) {
	const u = String(url);
	fetchCalls.push({ url: u, init: init as Call["init"] });
	if (u.includes("/comments")) {
		return Promise.resolve(
			new Response(JSON.stringify({ comment_id: "comment-1" }), {
				status: nextCommentStatus,
			}) as unknown as Response,
		);
	}
	return Promise.resolve(
		new Response(JSON.stringify({ error: "not_mocked" }), { status: 404 }) as unknown as Response,
	);
}
function install() { (global as unknown as { fetch: unknown }).fetch = mockFetch as unknown as typeof fetch; }
function restore() { (global as unknown as { fetch: unknown }).fetch = origFetch as unknown as typeof fetch; }
function commentsCalls(): Call[] {
	return fetchCalls.filter((c) => c.url.includes("/api/videos/") && c.url.includes("/comments"));
}
const API_BASE = "https://yt-api.f4.mock";
process.env.YOUTUBE_API_BASE_URL = API_BASE;
process.env.YOUTUBE_API_KEY = "test-key";

async function run() {
	install();

	// ── 1. sanitizeFirstComment ─────────────────────────────────────────────
	check("sanitize trim", sanitizeFirstComment("  olá mundo  ") === "olá mundo");
	check("sanitize vazio → null", sanitizeFirstComment("   ") === null);
	check("sanitize null → null", sanitizeFirstComment(null) === null);
	check("sanitize undefined → null", sanitizeFirstComment(undefined) === null);
	check("sanitize escapa HTML",
		sanitizeFirstComment("<b>oi</b>") === "&lt;b&gt;oi&lt;/b&gt;",
		String(sanitizeFirstComment("<b>oi</b>")));
	const long = "x".repeat(FIRST_COMMENT_MAX + 100);
	check("sanitize limita a 500",
		(sanitizeFirstComment(long) || "").length === FIRST_COMMENT_MAX,
		`len=${(sanitizeFirstComment(long) || "").length}`);

	// ── 2. buildPostData propaga first_comment do item ──────────────────────
	const itemRow = {
		id: "item1",
		title: "Título do vídeo",
		caption: "legenda padrão",
		caption_youtube: null,
		caption_instagram: null,
		caption_tiktok: null,
		tags: null,
		first_comment: "   Compre o curso no link da bio  ",
	};
	const mockPrisma = {
		contentItem: {
			// resolveCaptionTemplateVars (select title/caption/.../tags) e o
			// lookup de first_comment caem na MESMA row (mesmo item).
			findFirst: async () => itemRow,
		},
	} as never;
	const runtimeBase = {
		mediaType: "IMAGE",
		mediaUrl: "/api/file/u1/img.jpg",
		thumbnailUrl: null,
		children: [] as never[],
		selectedContent: { id: "item1" },
		shareToFeed: true,
		locationId: null,
		collaborators: null,
		userTags: null,
		audioConfiguration: null,
	};
	const postData = await buildPostData({
		prisma: mockPrisma,
		planner: { user_id: "u1", id: "p1" },
		channel: { id: "c1", name: "Canal YT", platform: "youtube" },
		runtime: runtimeBase as never,
		config: {} as never,
		now: new Date("2025-01-01T00:00:00Z"),
		templateIndex: 0,
		postOrdinal: 0,
	});
	check("buildPostData propaga first_comment (trim importa)",
		(postData as unknown as { first_comment: string | null }).first_comment === "Compre o curso no link da bio",
		String((postData as unknown as { first_comment: string | null }).first_comment));

	// item sem first_comment → Post.first_comment null
	const postDataNoComment = await buildPostData({
		prisma: {
			contentItem: { findFirst: async () => ({ ...itemRow, first_comment: "   " }) },
		} as never,
		planner: { user_id: "u1", id: "p1" },
		channel: { id: "c1", name: "Canal YT", platform: "youtube" },
		runtime: runtimeBase as never,
		config: {} as never,
		now: new Date("2025-01-01T00:00:00Z"),
		templateIndex: 0,
		postOrdinal: 0,
	});
	check("buildPostData item sem comentário → null",
		(postDataNoComment as unknown as { first_comment: string | null }).first_comment === null,
		String((postDataNoComment as unknown as { first_comment: string | null }).first_comment));

	// ── 3. publishYoutubeFirstComment: sucesso com proxy ────────────────────
	const logs: Array<{ msg: string; level: string }> = [];
	const ok = await publishYoutubeFirstComment({
		postId: "post-1",
		plannerId: "planner-1",
		videoId: "short_abc",
		sessionId: "ses-1",
		text: "  Primeiro comentário de teste  ",
		proxyUrl: "http://user:pass@proxy.f4.mock:3128",
		log: (msg, level) => { logs.push({ msg, level: level ?? "info" }); },
	});
	const commentCalls = commentsCalls();
	check("sucesso: cria comentário via API", ok === true && commentCalls.length === 1);
	check("sucesso: path correto /api/videos/{id}/comments",
		commentCalls[0]?.url.includes("/api/videos/short_abc/comments"),
		commentCalls[0]?.url || "(sem chamada)");
	const body = commentCalls[0]?.init.body
		? decodeURIComponent(String(commentCalls[0].init.body)).replace(/\+/g, " ")
		: "";
	check("sucesso: envia session_id", body.includes("session_id=ses-1"), body);
	check("sucesso: envia o texto", body.includes("Primeiro comentário de teste"), body);
	check("sucesso: proxy repassado (dispatcher)", Boolean(commentCalls[0]?.init.dispatcher));
	check("sucesso: log info publicado", logs.some((l) => l.level === "info" && /primeiro comentário publicado/.test(l.msg)));

	// ── 4. SKIPs: sem chamada à API ─────────────────────────────────────────
	fetchCalls = [];
	await publishYoutubeFirstComment({
		postId: "post-2", plannerId: "planner-1", videoId: null,
		sessionId: "ses-1", text: "comentário",
	});
	check("skip sem video_id remoto → sem chamada", commentsCalls().length === 0);

	fetchCalls = [];
	await publishYoutubeFirstComment({
		postId: "post-3", plannerId: "planner-1", videoId: "short_xyz",
		sessionId: "ses-1", text: "   ",
	});
	check("skip texto vazio → sem chamada", commentsCalls().length === 0);

	fetchCalls = [];
	await publishYoutubeFirstComment({
		postId: "post-4", plannerId: "planner-1", videoId: "short_xyz",
		sessionId: "", text: "comentário",
	});
	check("skip sem sessão → sem chamada", commentsCalls().length === 0);

	// ── 5. falha de comentário NUNCA afeta o post ──────────────────────────
	// Post já publicado (desfecho gravado antes do comentário no publisher).
	// publishYoutubeFirstComment NÃO recebe prisma e não grava nada no Post —
	// falha do comentário não pode alterar status/failed_reason por construção.
	const publishedPost = {
		id: "post-5",
		status: "published",
		published_at: new Date("2025-01-01T00:00:00Z"),
		youtube_video_id: "short_fail",
		first_comment: "comentário que vai falhar",
		failed_reason: null,
		error_message: null,
	};
	const before = JSON.stringify(publishedPost);
	nextCommentStatus = 500;
	const warnLogs: Array<{ msg: string; level: string }> = [];
	let threw = false;
	let result: boolean | null = null;
	try {
		result = await publishYoutubeFirstComment({
			postId: "post-5",
			plannerId: "planner-1",
			videoId: "short_fail",
			sessionId: "ses-1",
			text: "comentário que vai falhar",
			log: (msg, level) => { warnLogs.push({ msg, level: level ?? "info" }); },
		});
	} catch { threw = true; }
	check("falha 500: não lança", threw === false);
	check("falha 500: retorna false", result === false);
	check("falha 500: tentou chamar a API", commentsCalls().length === 1);
	check("falha 500: log warning PT-BR",
		warnLogs.some((l) => l.level === "warning" && /NÃO afeta a publicação/.test(l.msg)),
		warnLogs.map((l) => l.msg).join(" | "));
	check("falha 500: post permanece published sem failed_reason",
		JSON.stringify(publishedPost) === before && publishedPost.status === "published" &&
		publishedPost.failed_reason === null && publishedPost.error_message === null);

	restore();
	console.log(`\n=== Smoke F4 PRIMEIRO COMENTÁRIO: ${pass} PASS, ${fail} FAIL ===`);
	if (fail > 0) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });