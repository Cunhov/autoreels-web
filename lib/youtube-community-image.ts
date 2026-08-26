import sharp from "sharp";

/**
 * Adapta uma imagem para 1:1 com preenchimento em blur gaussiano.
 *
 * Somente para posts da Comunidade do YouTube. Instagram não é afetado.
 * - Original preservado no storage; adaptação apenas em memória no momento do upload.
 * - Imagens já quadradas (≈2% de tolerância, inclusivo) retornam intocadas.
 * - GIF/WebP animado (pages > 1, delay multi-frame ou loop) retorna intocado — animação seria destruída ao converter para JPEG.
 * - Imagens não-quadradas viram 1080x1080: fundo em cover+blur+escurecido + frente em contain centralizada.
 * - Saída sempre JPEG (YouTube aceita). Fallback best-effort com log PT-BR em qualquer erro.
 * - Upscale intencional: imagens pequenas são ampliadas para 1080 (pixelização aceita para manter 1:1).
 * - Dupla recompressão evitada: fundo intermediário é PNG/raw, só o composite final vira JPEG q90.
 */

const SIZE = 1080;
const BLUR_SIGMA = 25;
const BRIGHTNESS = 0.9;
// Tolerância para considerar quadrada: |w-h| / max(w,h) <= 0.02  (borda 2% inclusiva)
const SQUARE_TOLERANCE = 0.02;
const MAX_PIXELS = 25_000_000;

export interface AdaptInput {
	buffer: Buffer;
	contentType: string;
	filename?: string;
}

export interface AdaptOutput {
	buffer: Buffer;
	contentType: string;
	filename: string;
	wasAdapted: boolean;
	origWidth?: number;
	origHeight?: number;
	fallbackReason?: string;
}

/**
 * Converte filename para .jpg de forma segura, preservando PT-BR.
 * Sanitização intencional: acentos normalizados para ASCII para compatibilidade
 * com Content-Disposition multipart (YouTube API). Limita a 100 chars.
 * Quando idx é informado, garante unicidade com sufixo -{idx+1}.
 */
export function toJpgFilename(filename?: string, idx?: number): string {
	if (!filename) return idx != null && idx > 0 ? `imagem-${idx + 1}.jpg` : "imagem.jpg";
	const clean = filename.split("?")[0].split("#")[0];
	const base = clean.split("/").pop() || clean;
	const dot = base.lastIndexOf(".");
	const name = dot > 0 ? base.slice(0, dot) : base;
	// Sanitização: normaliza acentos para compatibilidade multipart (cafe <- café)
	const normalized = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
	let safe = normalized.replace(/[^a-zA-Z0-9._-]/g, "_") || "imagem";
	// Limita tamanho para não estourar header Content-Disposition
	safe = safe.slice(0, 100);
	if (idx != null && idx > 0) {
		// Garante unicidade em carrossel com basenames iguais (a/foto.jpg + b/foto.jpg -> foto.jpg + foto-2.jpg)
		const suffix = `-${idx + 1}`;
		// Reserva espaço para sufixo dentro do limite
		if (safe.length + suffix.length > 100) safe = safe.slice(0, 100 - suffix.length);
		return `${safe}${suffix}.jpg`;
	}
	return `${safe}.jpg`;
}

/**
 * Adapta a imagem para 1:1 com blur quando necessário.
 * Best-effort com observabilidade: qualquer falha loga warning PT-BR e retorna original.
 */
export async function adaptImageToSquareWithBlur(
	input: AdaptInput,
	idx?: number,
): Promise<AdaptOutput> {
	const original: AdaptOutput = {
		buffer: input.buffer,
		contentType: input.contentType,
		filename: input.filename || "imagem",
		wasAdapted: false,
	};

	// Validação mínima — buffer vazio/corrompido não deve virar Blob vazio (transiente)
	if (!input.buffer || !Buffer.isBuffer(input.buffer) || input.buffer.length === 0) {
		const reason = "buffer vazio ou inválido";
		console.warn(`[YouTube] adaptação com blur — fallback: ${reason}`);
		return { ...original, fallbackReason: reason };
	}

	try {
		// rotate() antes de metadata garante w/h com EXIF aplicado (iPhone orientation 5-8)
		const meta = await sharp(input.buffer, { failOn: "none", limitInputPixels: MAX_PIXELS }).rotate().metadata();
		const w = meta.width;
		const h = meta.height;
		if (!w || !h) {
			console.warn("[YouTube] adaptação com blur — fallback: dimensões ausentes");
			return { ...original, fallbackReason: "dimensões ausentes" };
		}

		// Guard de pixels: imagem com dimensões enormes (ex.: 15000x15000) estouraria memória do tick
		if (w * h > MAX_PIXELS) {
			console.warn(`[YouTube] adaptação com blur — fallback: imagem muito grande (${w}x${h})`);
			return { ...original, origWidth: w, origHeight: h, fallbackReason: "imagem muito grande" };
		}

		// GIF/WebP animado: sharp extrai só frame 1 — preservar original e avisar
		// WebP animado em sharp 0.34 pode não reportar pages e expor delay/loop
		const pages = meta.pages;
		const delay = (meta as { delay?: number[] }).delay;
		// loop isolado ignorado: WebP estático pode expor loop:0 em sharp@0.34 gerando falso-positivo
		const isAnimated =
			(typeof pages === "number" && pages > 1) ||
			(Array.isArray(delay) && delay.length > 1);
		if (isAnimated) {
			const frames = typeof pages === "number" ? pages : Array.isArray(delay) ? delay.length : "?";
			console.warn(`[YouTube] adaptação com blur ignorada — imagem animada (${frames} frames) mantida original`);
			return { ...original, origWidth: w, origHeight: h, fallbackReason: "imagem animada" };
		}

		// Verifica se já é quadrada dentro da tolerância (2% inclusivo)
		const diff = Math.abs(w - h) / Math.max(w, h);
		if (diff <= SQUARE_TOLERANCE) {
			return { ...original, origWidth: w, origHeight: h, wasAdapted: false };
		}

		// Gera fundo e frente em paralelo — evita decodificar sequencialmente
		// bg: cover 1080x1080 + blur + brightness, saída PNG intermediária (sem recompressão JPEG dupla)
		// fg: contain 1080x1080 com fundo transparente
		// limitInputPixels já validado acima via w*h; failOn none mantém best-effort
		const [bgBuffer, fgBuffer] = await Promise.all([
			sharp(input.buffer, { failOn: "none", limitInputPixels: MAX_PIXELS })
				.rotate()
				.resize(SIZE, SIZE, { fit: "cover", position: "centre", withoutEnlargement: false })
				.blur(BLUR_SIGMA)
				.modulate({ brightness: BRIGHTNESS })
				.png()
				.toBuffer(),
			sharp(input.buffer, { failOn: "none", limitInputPixels: MAX_PIXELS })
				.rotate()
				.resize(SIZE, SIZE, {
					fit: "contain",
					background: { r: 0, g: 0, b: 0, alpha: 0 },
					withoutEnlargement: false,
				})
				.png()
				.toBuffer(),
		]);

		// Compõe frente sobre fundo centralizado — única compressão JPEG
		const outBuffer = await sharp(bgBuffer, { failOn: "none", limitInputPixels: MAX_PIXELS })
			.composite([{ input: fgBuffer, gravity: "centre" }])
			.jpeg({ quality: 90 })
			.toBuffer();

		return {
			buffer: outBuffer,
			contentType: "image/jpeg",
			filename: toJpgFilename(input.filename, idx),
			wasAdapted: true,
			origWidth: w,
			origHeight: h,
		};
	} catch (e: unknown) {
		const reason = (e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200)).replace(/\n/g, " ");
		console.warn(`[YouTube] adaptação com blur — fallback: ${reason}`);
		return { ...original, fallbackReason: reason || "erro sharp" };
	}
}
