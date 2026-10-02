"use client";
import { useState, useEffect, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import {
	Upload,
	X,
	Radio,
	Calendar as CalendarIcon,
	Youtube,
	Film,
	MessageSquare,
	ImagePlus,
	FolderOpen,
} from "lucide-react";
import { useUploadActions } from "@/contexts/UploadContext";
import {
	YT_TITLE_MAX,
	CAPTION_MAX,
	DESCRIPTION_MAX,
	PINNED_MAX,
	MAX_VIDEO_BYTES,
	MAX_IMAGE_BYTES,
	escapeHtml,
} from "@/lib/sanitize";
import IOSSwitch from "@/components/IOSSwitch";
import ContentLibrary from "@/components/ContentLibrary";
import { useDialogA11y } from "@/lib/dialog-a11y";
import { toLocalDateTimeInputValue } from "@/lib/format";

interface Channel {
	id: string;
	name: string;
	platform: string;
}

type YoutubeType = "short" | "community";

const MAX_TITLE_LENGTH = YT_TITLE_MAX; // centralizado BK-08
const MAX_COMMUNITY_IMAGES = 10;
const CAPTION_LIMIT = CAPTION_MAX;
const DESCRIPTION_LIMIT = DESCRIPTION_MAX;
const PINNED_LIMIT = PINNED_MAX;

interface LibraryMedia {
	id: string;
	name: string;
	type: string;
	url: string;
	thumbnail_url?: string;
	caption?: string;
	title?: string;
	size?: number;
}

function MediaLibraryPicker({ images, onClose, onChoose }: {
	images: boolean;
	onClose: () => void;
	onChoose: (items: LibraryMedia[]) => void;
}) {
	const [ids, setIds] = useState<string[]>([]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const dialogRef = useDialogA11y(true, onClose);
	const requestRef = useRef<AbortController | null>(null);
	useEffect(() => () => requestRef.current?.abort(), []);

	async function choose() {
		if (busy || ids.length === 0 || ids.length > (images ? MAX_COMMUNITY_IMAGES : 1)) return;
		setBusy(true);
		setError("");
		const controller = new AbortController();
		requestRef.current = controller;
		try {
			const items = await Promise.all(ids.map(async (id) => {
				const response = await fetch(`/api/content-items/${encodeURIComponent(id)}`, { signal: controller.signal });
				if (!response.ok) throw new Error("Não foi possível carregar a mídia selecionada. Tente novamente.");
				const item = await response.json() as LibraryMedia;
				const validType = images ? ["image", "carousel_item"].includes(item.type) : item.type === "video";
				if (!validType || !item.url) throw new Error("Selecione uma mídia compatível com este tipo de publicação.");
				if (item.size && item.size > (images ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES)) throw new Error("A mídia selecionada excede o limite de tamanho permitido.");
				return item;
			}));
			if (!controller.signal.aborted) onChoose(items);
		} catch (err) {
			if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Falha ao carregar a mídia.");
		} finally {
			if (!controller.signal.aborted) setBusy(false);
		}
	}

	return (
		<div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm p-3 sm:p-4" onClick={onClose} role="presentation">
			<div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="media-library-title" tabIndex={-1} onClick={e => e.stopPropagation()} className="bg-ios-card w-full max-w-4xl h-[85dvh] rounded-2xl shadow-2xl flex flex-col overflow-hidden">
				<div className="p-4 border-b border-ios-separator flex items-start justify-between gap-3 shrink-0">
					<div className="min-w-0"><h2 id="media-library-title" className="font-semibold text-lg">Escolher da Biblioteca</h2><p className="text-sm text-ios-text-secondary">{images ? "Selecione até 10 imagens." : "Selecione um vídeo."}</p></div>
					<button type="button" onClick={onClose} aria-label="Fechar seleção de mídia" className="p-3 -m-2 rounded-lg shrink-0"><X size={20} /></button>
				</div>
				<div className="flex-1 min-h-0 overflow-hidden"><ContentLibrary mode="select" disableUrlNavigation foldersSelectable={false} allowedTypes={images ? ["image", "carousel_item"] : ["video"]} onSelectionChange={setIds} /></div>
				<div className="p-4 border-t border-ios-separator shrink-0 space-y-2">
					{error && <p role="alert" className="text-sm text-ios-red">{error}</p>}
					{ids.length > (images ? MAX_COMMUNITY_IMAGES : 1) && <p role="alert" className="text-sm text-ios-orange">{images ? "Selecione no máximo 10 imagens." : "Selecione apenas um vídeo."}</p>}
					<div className="flex justify-end gap-2"><button type="button" onClick={onClose} className="px-4 py-3 rounded-xl text-ios-blue">Cancelar</button><button type="button" disabled={busy || ids.length === 0 || ids.length > (images ? MAX_COMMUNITY_IMAGES : 1)} onClick={choose} className="px-4 py-3 rounded-xl bg-ios-blue text-white font-semibold disabled:opacity-50">{busy ? "Carregando…" : "Usar seleção"}</button></div>
				</div>
			</div>
		</div>
	);
}

export default function NewPost() {
	const router = useRouter();
	const { data: session } = useSession();
	const { uploadAndWait } = useUploadActions();
	const [channels, setChannels] = useState<Channel[]>([]);
	const [selectedChannel, setSelectedChannel] = useState("");
	const [scheduledAt, setScheduledAt] = useState("");
	const [file, setFile] = useState<File | null>(null);
	const [libraryVideo, setLibraryVideo] = useState<LibraryMedia | null>(null);
	const [libraryOpen, setLibraryOpen] = useState(false);
	const [minSchedule, setMinSchedule] = useState("");
	const [previewUrl, setPreviewUrl] = useState<string | null>(null);
	const [caption, setCaption] = useState("");
	const [uploading, setUploading] = useState(false);
	const [error, setError] = useState("");
	// Falha ao carregar canais: estado distinto de vazio (DoD #5) — sem isso o
	// usuário vê só "Default Account" e não sabe por que o canal YouTube some.
	const [channelsError, setChannelsError] = useState("");
	// Vazio distinto de "carregando": sem este flag o aviso de "nenhum canal"
	// piscaria durante o fetch inicial (channels ainda = []).
	const [channelsLoaded, setChannelsLoaded] = useState(false);
	// BK-05: debounce 800ms + disable apos primeiro clique
	const lastSubmitRef = useRef<number>(0);
	const idempotencyKeyRef = useRef<string | null>(null);

	// ── YouTube ──
	const isYoutubeChannel =
		channels.find((c) => c.id === selectedChannel)?.platform === "youtube";
	const [youtubeType, setYoutubeType] = useState<YoutubeType>("short");
	// Opções do Short (salvas em Post.youtube_options)
	const [ytTitle, setYtTitle] = useState("");
	const [ytDescription, setYtDescription] = useState("");
	const [ytPrivacy, setYtPrivacy] = useState<"PUBLIC" | "UNLISTED" | "PRIVATE">(
		"PUBLIC",
	);
	const [ytMadeForKids, setYtMadeForKids] = useState(false);
	const [ytMonetize, setYtMonetize] = useState(false);
	const [ytPinnedComment, setYtPinnedComment] = useState("");
	// BK-20: CONFIRMACAO VISUAL para PUBLIC (mantém default PUBLIC mas mitiga risco acidental)
	const [showPublicConfirm, setShowPublicConfirm] = useState(false);
	const publicConfirmRef = useDialogA11y(showPublicConfirm, () => setShowPublicConfirm(false));
	// Imagens da Comunidade (até 10)
	interface CommunityImage {
		file?: File;
		url: string;
	}
	const [communityImages, setCommunityImages] = useState<CommunityImage[]>([]);
	// Quantidade descartada ao exceder o limite de 10 — exibida como aviso
	// para o usuário não agendar achando que incluiu imagens que ficaram fora.
	const [imagesDropped, setImagesDropped] = useState(0);
	// Espelho p/ cleanup de unmount (revogar object URLs sem setState no unmount)
	const communityImagesRef = useRef<CommunityImage[]>([]);
	useEffect(() => {
		communityImagesRef.current = communityImages;
	}, [communityImages]);
	useEffect(() => {
		return () => {
			for (const img of communityImagesRef.current) {
				URL.revokeObjectURL(img.url);
			}
		};
	}, []);

	useEffect(() => {
		fetchChannels();
	}, []);

	useEffect(() => {
		const refresh = () => setMinSchedule(toLocalDateTimeInputValue(new Date().toISOString()));
		refresh();
		const timer = setInterval(refresh, 60_000);
		return () => clearInterval(timer);
	}, []);

	// Deep link from the calendar: /new?scheduled_at=YYYY-MM-DDTHH:MM pre-fills
	// the schedule input. Read via window.location (no useSearchParams) so the
	// page needs no Suspense boundary. Format is already datetime-local native.
	useEffect(() => {
		if (typeof window === "undefined") return;
		const params = new URLSearchParams(window.location.search);
		const scheduled = params.get("scheduled_at");
		if (scheduled && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(scheduled)) {
			setScheduledAt(scheduled);
		}
	}, []);

	// Release the object URL when the preview changes or the page unmounts
	useEffect(() => {
		return () => {
			if (previewUrl) URL.revokeObjectURL(previewUrl);
		};
	}, [previewUrl]);

	async function fetchChannels() {
		setChannelsError("");
		setChannelsLoaded(false);
		try {
			const res = await fetch("/api/channels");
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			setChannels(data);
		} catch (err) {
			console.error("Failed to load channels:", err);
			setChannels([]);
			setChannelsError(
				"Não foi possível carregar os canais. Verifique sua conexão e tente novamente.",
			);
		} finally {
			setChannelsLoaded(true);
		}
	}

	const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const selected = e.target.files?.[0] || null;
		if (selected) {
			// BK-15: validar MIME e tamanho
			const isVideo = selected.type.startsWith("video/");
			const isImage = selected.type.startsWith("image/");
			if (isImage || (!isVideo && !/\.(mp4|mov|m4v|webm|mkv)$/i.test(selected.name))) {
				setError("Selecione um arquivo de vídeo para esta publicação.");
				e.target.value = "";
				return;
			}
			if (selected.size > MAX_VIDEO_BYTES) {
				setError(`Arquivo excede limite de ${MAX_VIDEO_BYTES / 1024 / 1024}MB`);
				e.target.value = "";
				return;
			}
		}
		if (previewUrl) URL.revokeObjectURL(previewUrl);
		setFile(selected);
		setLibraryVideo(null);
		setError("");
		setPreviewUrl(selected ? URL.createObjectURL(selected) : null);
		// Reset so selecting the same file again re-triggers onChange
		e.target.value = "";
	};

	/** Seleção de imagens para o post da Comunidade (máx. 10) — BK-09 unifica mensagens + BK-15 valida tipo/tamanho */
	const handleCommunityImagesChange = (
		e: React.ChangeEvent<HTMLInputElement>,
	) => {
		const incoming = Array.from(e.target.files || []);
		// BK-15: filtra MIME e tamanho antes de criar objectURL
		const valid: typeof incoming = [];
		for (const f of incoming) {
			if (f.type && !f.type.startsWith("image/")) {
				setError(`Tipo não suportado (só imagens): ${f.type}`);
				continue;
			}
			if (f.size > MAX_IMAGE_BYTES) {
				setError(
					`Imagem ${f.name} excede ${MAX_IMAGE_BYTES / 1024 / 1024}MB e foi ignorada`,
				);
				continue;
			}
			valid.push(f);
		}
		const selected = valid.map((file) => ({
			file,
			url: URL.createObjectURL(file),
		}));
		// Merge/descartes calculados FORA do updater (updaters devem ser puros;
		// em StrictMode são invocados duas vezes).
		const merged = [...communityImages, ...selected].slice(
			0,
			MAX_COMMUNITY_IMAGES,
		);
		let dropped = 0;
		for (const item of [...communityImages, ...selected]) {
			if (!merged.includes(item)) {
				URL.revokeObjectURL(item.url);
				dropped++;
			}
		}
		setCommunityImages(merged);
		setImagesDropped(dropped);
		e.target.value = "";
	};

	const removeCommunityImage = (index: number) => {
		setImagesDropped(0);
		// Efeito colateral fora do updater (ver handleCommunityImagesChange).
		const removed = communityImages[index];
		if (removed) URL.revokeObjectURL(removed.url);
		setCommunityImages((prev) => prev.filter((_, i) => i !== index));
	};

	/** Libera os object URLs de todas as imagens da Comunidade selecionadas. */
	const clearCommunityImages = () => {
		if (communityImagesRef.current.length === 0) return;
		for (const img of communityImagesRef.current) {
			URL.revokeObjectURL(img.url);
		}
		setCommunityImages([]);
		setImagesDropped(0);
	};

	/**
	 * Troca Short/Comunidade. Sair do modo Comunidade descarta as imagens já
	 * selecionadas e revoga os object URLs na hora (sem acumular blobs vivos
	 * na sessão até o unmount), além de zerar o aviso de descarte.
	 */
	const switchYoutubeType = (next: YoutubeType) => {
		if (next !== "community") clearCommunityImages();
		setYoutubeType(next);
	};

	const chooseLibraryMedia = (items: LibraryMedia[]) => {
		if (isYoutubeChannel && youtubeType === "community") {
			const incoming = items.filter(item => !communityImages.some(img => img.url === item.url));
			const combined = [...communityImages, ...incoming.map(item => ({ url: item.url }))];
			setCommunityImages(combined.slice(0, MAX_COMMUNITY_IMAGES));
			setImagesDropped(Math.max(0, combined.length - MAX_COMMUNITY_IMAGES));
		} else {
			const item = items[0];
			if (!item) return;
			setFile(null);
			setLibraryVideo(item);
			setPreviewUrl(item.url);
			if (!caption.trim() && item.caption) setCaption(item.caption.slice(0, CAPTION_LIMIT));
			if (!ytTitle.trim()) setYtTitle((item.title || item.name.replace(/\.[^.]+$/, "")).slice(0, YT_TITLE_MAX));
		}
		setError("");
		setLibraryOpen(false);
	};

	const titleExceeds = ytTitle.length > MAX_TITLE_LENGTH;
	const canSubmit = useMemo(() => {
		if (isYoutubeChannel) {
			if (youtubeType === "short") {
				return Boolean(file || libraryVideo) && ytTitle.trim().length > 0 && !titleExceeds;
			}
			// Comunidade do YouTube aceita 0..10 imagens — texto é o único obrigatório.
			return caption.trim().length > 0;
		}
		return Boolean(file || libraryVideo);
	}, [isYoutubeChannel, youtubeType, file, libraryVideo, ytTitle, titleExceeds, caption]);

	// Upload the file via the global upload queue (chunked, resumable).
	// uploadAndWait enqueues the file and resolves when the task finishes.
	const handleSubmit = async (e: React.FormEvent, publicConfirmed = false) => {
		e.preventDefault();
		if (!canSubmit || uploading) return;
		// BK-20: CONFIRMACAO VISUAL para PUBLIC — modal antes de enviar (mantém PUBLIC como default)
		if (
			isYoutubeChannel &&
			youtubeType === "short" &&
			ytPrivacy === "PUBLIC" &&
			!publicConfirmed
		) {
			setShowPublicConfirm(true);
			return;
		}
		// BK-05: debounce 800ms (duplo clique)
		const nowMs = Date.now();
		if (nowMs - lastSubmitRef.current < 800) return;
		lastSubmitRef.current = nowMs;
		if (!idempotencyKeyRef.current)
			idempotencyKeyRef.current =
				typeof crypto !== "undefined" && "randomUUID" in crypto
					? crypto.randomUUID()
					: String(Date.now()) + Math.random();

		// BK-10: validar scheduledAt (Date.parse + isNaN + min = agora)
		if (scheduledAt) {
			const ts = Date.parse(scheduledAt);
			if (Number.isNaN(ts)) {
				setError("Data de agendamento inválida");
				return;
			}
			const d = new Date(ts);
			// min = agora (permite 1 min de tolerância para clock skew)
			if (d.getTime() < Date.now() - 60_000) {
				setError("Data de agendamento deve ser no futuro");
				return;
			}
		}
		// BK-14: validar limites caption/description/pinned com slice e aviso seria aplicado no backend, mas valida aqui para feedback imediato
		if (caption.length > CAPTION_LIMIT) {
			setError(`Legenda excede ${CAPTION_LIMIT} caracteres e será truncada`);
		}
		if (ytDescription.length > DESCRIPTION_LIMIT) {
			setError(`Descrição excede ${DESCRIPTION_LIMIT} caracteres e será truncada`);
		}
		if (ytPinnedComment.length > PINNED_LIMIT) {
			setError(
				`Comentário fixado excede ${PINNED_LIMIT} caracteres e será truncado`,
			);
		}

		setUploading(true);
		setError("");

		try {
			if (!session?.user)
				throw new Error("Você precisa estar logado para criar uma publicação.");

			let videoUrl: string | null = null;
			let imageUrl: string | null = null;
			let childrenUrls: string | null = null;

			if (isYoutubeChannel && youtubeType === "community") {
				// Comunidade: sobe as imagens (0..10) e guarda em children_urls —
				// é exatamente o campo que o publisher lê para montar o multipart.
				// Sem imagens, o post é SÓ texto (o publisher usa POST /api/post JSON).
				if (communityImages.length > 0) {
					const uploads = communityImages.flatMap((img, index) => img.file ? [{ file: img.file, index }] : []);
					const results = uploads.length ? await uploadAndWait(uploads.map(img => img.file), { folderId: null }) : [];
					const urls = communityImages.map(img => img.url);
					for (const [index, r] of results.entries()) {
						if (r.error || !r.item?.url) {
							throw new Error(r.error || "Falha ao enviar uma das imagens");
						}
						urls[uploads[index].index] = r.item.url as string;
					}
					imageUrl = urls[0];
					childrenUrls = JSON.stringify(urls.map((url) => ({ url, type: "image" })));
				}
			} else if (libraryVideo) {
				videoUrl = libraryVideo.url;
			} else if (file) {
				// 1. Upload the file through the global upload queue (root folder)
				const results = await uploadAndWait([file], { folderId: null });
				const first = results[0];
				if (!first || first.error || !first.item?.url) {
					throw new Error(first?.error || "Falha ao enviar o vídeo");
				}
				videoUrl = first.item.url as string;
			}

			// 2. Create the post record (scheduled_at as ISO; publish now if empty)
			const body: Record<string, unknown> = {
				caption: escapeHtml(caption.slice(0, CAPTION_LIMIT)), // BK-07 sanitize + BK-14 limite
				status: "pending",
				channel_id: selectedChannel || null,
				// Convert local datetime string to absolute ISO so the server (UTC)
				// interprets the user's local wall-clock correctly. If empty, the
				// cron publisher picks it up on the next tick (it treats NULL as due).
				scheduled_at: scheduledAt ? new Date(scheduledAt).toISOString() : null,
			};
			if (videoUrl) body.video_url = videoUrl;
			if (imageUrl) body.image_url = imageUrl;
			if (childrenUrls) body.children_urls = childrenUrls;

			if (isYoutubeChannel) {
				// Post na Comunidade SÓ de texto (0 imagens) não é mídia: omite
				// media_type (nullable no schema) para o calendário/analytics não
				// o rotularem/agruparem como "IMAGE".
				if (!(youtubeType === "community" && communityImages.length === 0)) {
					body.media_type = youtubeType === "community" ? "IMAGE" : "VIDEO";
				}
				body.youtube_type = youtubeType;
				if (youtubeType === "short") {
					// BK-08 slice apenas no submit com aviso + BK-07 escape HTML
					let finalTitle = ytTitle.trim();
					if (finalTitle.length > YT_TITLE_MAX) {
						finalTitle = finalTitle.slice(0, YT_TITLE_MAX);
						setError(`Título truncado para ${YT_TITLE_MAX} caracteres`);
					}
					finalTitle = escapeHtml(finalTitle);
					// BK-14 slice description/pinned
					let finalDesc = ytDescription.slice(0, DESCRIPTION_LIMIT);
					if (ytDescription.length > DESCRIPTION_LIMIT)
						finalDesc = escapeHtml(finalDesc);
					else finalDesc = escapeHtml(finalDesc);
					let finalPinned = ytPinnedComment.trim().slice(0, PINNED_LIMIT);
					if (ytPinnedComment.trim().length > PINNED_LIMIT)
						finalPinned = escapeHtml(finalPinned);
					else finalPinned = escapeHtml(finalPinned);
					body.youtube_options = JSON.stringify({
						title: finalTitle,
						description: finalDesc,
						privacy: ytPrivacy,
						made_for_kids: ytMadeForKids,
						monetize_with_ads: ytMonetize,
						...(finalPinned ? { pinned_comment_text: finalPinned } : {}),
					});
				}
			} else {
				body.media_type = "REELS";
			}

			const res = await fetch("/api/posts", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-idempotency-key": idempotencyKeyRef.current || "",
				},
				body: JSON.stringify({
					...body,
					_idempotencyKey: idempotencyKeyRef.current,
				}),
			});

			if (!res.ok) {
				const postErr = (await res.json().catch(() => ({}))) as {
					error?: string;
				};
				throw new Error(postErr.error || "Falha ao registrar a publicação");
			}

			router.push("/");
		} catch (err: unknown) {
			const message =
				(err as { message?: string })?.message ||
				"Ocorreu um erro durante o envio.";
			console.error(err);
			setError(message);
		} finally {
			setUploading(false);
		}
	};

	return (
		<div className="max-w-2xl mx-auto pb-20 md:pb-0">
			<h1 className="text-[34px] font-bold tracking-tight text-ios-text mb-6 px-4">
				Novo post
			</h1>

			<form onSubmit={handleSubmit} className="space-y-6">
				{/* Canal + tipo de conteúdo YouTube */}
				<div className="ios-inset-grouped bg-ios-card divide-y divide-ios-separator">
					<div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-4 bg-ios-card">
						<label htmlFor="post-channel" className="text-[17px] text-ios-text font-medium flex items-center gap-2">
							<Radio size={18} className="text-ios-blue" />
							Canal
						</label>
						<select
							id="post-channel"
							title="Canal"
							value={selectedChannel}
							onChange={(e) => {
								const next = e.target.value;
								setSelectedChannel(next);
								// Trocar de canal: saindo de YouTube a seleção de imagens
								// da Comunidade é descartada (revogando os object URLs).
								const nextIsYoutube =
									channels.find((c) => c.id === next)?.platform === "youtube";
								if (!nextIsYoutube) clearCommunityImages();
							}}
							className="bg-transparent text-[17px] text-ios-blue focus:outline-none min-w-0 w-full sm:w-auto sm:max-w-[60%] py-2"
						>
							<option value="">Conta padrão</option>
							{channels.map((c) => (
								<option key={c.id} value={c.id}>
									{c.platform === "youtube" ? "▶ " : ""}
									{c.name}
								</option>
							))}
						</select>
					</div>

					<div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-4 bg-ios-card">
						<label htmlFor="post-schedule" className="text-[17px] text-ios-text font-medium flex items-center gap-2">
							<CalendarIcon size={18} className="text-ios-blue" />
							Agendar
						</label>
						<input
							id="post-schedule"
							title="Agendamento"
							type="datetime-local"
							value={scheduledAt}
							min={minSchedule || undefined}
							onChange={(e) => setScheduledAt(e.target.value)}
							className="bg-transparent text-[17px] text-ios-blue focus:outline-none min-w-0 w-full sm:w-auto py-2"
						/>
					</div>
				</div>

				{/* ── Escolha do tipo de conteúdo YouTube ─────────────────────── */}
				{channelsLoaded && channelsError === "" && channels.length === 0 && (
					<div className="mx-4 p-3 rounded-xl bg-ios-orange/10 text-ios-orange text-sm">
						Nenhum canal conectado — adicione um canal YouTube ou Instagram em{" "}
						<span className="font-semibold">Canais</span> antes de agendar um post.
					</div>
				)}
				{channelsError && (
					<div className="mx-4 p-3 rounded-xl bg-ios-red/10 text-ios-red text-sm flex items-center justify-between gap-3">
						<span>{channelsError}</span>
						<button
							type="button"
							onClick={fetchChannels}
							className="font-semibold underline shrink-0"
						>
							Tentar novamente
						</button>
					</div>
				)}

				{isYoutubeChannel && (
					<div className="px-4 space-y-3">
						<div className="grid grid-cols-2 gap-2 p-1 bg-ios-separator/50 rounded-xl">
							<button
								type="button"
								onClick={() => switchYoutubeType("short")}
								className={`py-2.5 rounded-lg text-sm font-semibold flex items-center justify-center gap-1.5 ${youtubeType === "short" ? "bg-ios-card text-ios-red shadow-sm" : "text-ios-secondary"}`}
							>
								<Film size={15} /> Short
							</button>
							<button
								type="button"
								onClick={() => switchYoutubeType("community")}
								className={`py-2.5 rounded-lg text-sm font-semibold flex items-center justify-center gap-1.5 ${youtubeType === "community" ? "bg-ios-card text-ios-red shadow-sm" : "text-ios-secondary"}`}
							>
								<MessageSquare size={15} /> Comunidade
							</button>
						</div>
					</div>
				)}

				{/* ── Mídia ── */}
				{!isYoutubeChannel || youtubeType === "short" ? (
					/* Vídeo: Reels do Instagram OU Short do YouTube */
					<div className="px-4">
						<label
							htmlFor="file-upload"
							className={`block w-full aspect-[9/16] max-w-[200px] mx-auto rounded-xl border-2 border-dashed transition-all relative overflow-hidden bg-ios-card ${file || libraryVideo ? "border-ios-blue" : "border-ios-separator hover:border-ios-blue/50"}`}
						>
							{file || libraryVideo ? (
								<div className="w-full h-full bg-black flex items-center justify-center relative">
									<video
										key={previewUrl || undefined}
										className="w-full h-full object-cover opacity-80"
										src={previewUrl || undefined}
										muted
										playsInline
									/>
									<div className="absolute inset-0 flex items-center justify-center">
										<span className="text-white text-sm font-medium bg-black/50 px-3 py-1 rounded-full">
											{file?.name || libraryVideo?.name}
										</span>
									</div>
									<button
										type="button"
										onClick={(e) => {
											e.preventDefault();
											if (previewUrl) URL.revokeObjectURL(previewUrl);
											setFile(null);
											setLibraryVideo(null);
											setPreviewUrl(null);
										}}
										aria-label="Remover vídeo selecionado"
										className="absolute z-10 top-2 right-2 bg-black/50 backdrop-blur-md p-3 rounded-full text-white"
									>
										<X size={16} />
									</button>
								</div>
							) : (
								<div className="w-full h-full flex flex-col items-center justify-center text-ios-text-secondary gap-2 cursor-pointer">
									<Upload size={32} />
									<span className="text-sm font-medium">
										{isYoutubeChannel ? "Selecionar vídeo do Short" : "Selecionar vídeo"}
									</span>
									<span className="text-[10px]">9:16 MP4</span>
								</div>
							)}
							<input
								id="file-upload"
								name="file-upload"
								type="file"
								className="absolute inset-0 opacity-0 cursor-pointer"
								accept="video/*"
								onChange={handleFileChange}
								required={!file && !libraryVideo && (!isYoutubeChannel || youtubeType === "short")}
							/>
						</label>
						<button type="button" onClick={() => setLibraryOpen(true)} className="w-full py-3 flex items-center justify-center gap-2 rounded-xl bg-ios-card text-ios-blue border border-ios-separator font-medium"><FolderOpen size={18} />Escolher da Biblioteca</button>
					</div>
				) : (
					/* Imagens da Comunidade (até 10) */
					<div className="px-4 space-y-3">
						<label
							htmlFor="community-images-upload"
							className="block w-full rounded-xl border-2 border-dashed border-ios-separator hover:border-ios-blue/50 transition-all bg-ios-card py-8 flex cursor-pointer"
						>
							<div className="w-full flex flex-col items-center justify-center text-ios-text-secondary gap-2">
								<ImagePlus size={28} />
								<span className="text-sm font-medium">
									Adicionar imagens (opcional)
								</span>
								<span className="text-[10px]">
									JPEG, PNG, GIF ou WebP · até {MAX_COMMUNITY_IMAGES}
								</span>
							</div>
							<input
								id="community-images-upload"
								name="community-images-upload"
								type="file"
								className="hidden"
								multiple
								accept="image/jpeg,image/png,image/gif,image/webp"
								onChange={handleCommunityImagesChange}
							/>
						</label>
						{imagesDropped > 0 && (
							<p className="text-[11px] text-ios-orange px-1">
								Limite de {MAX_COMMUNITY_IMAGES} imagens — {imagesDropped}{" "}
								descartada(s). Remova uma imagem para adicionar outra.
							</p>
						)}
						<button type="button" onClick={() => setLibraryOpen(true)} className="w-full py-3 flex items-center justify-center gap-2 rounded-xl bg-ios-card text-ios-blue border border-ios-separator font-medium"><FolderOpen size={18} />Escolher imagens da Biblioteca</button>
						{communityImages.length === 0 && (
							<p className="text-[11px] text-ios-text-secondary px-1">
								0 imagens — post somente texto (OK)
							</p>
						)}
						{communityImages.length > 0 &&
							communityImages.length <= MAX_COMMUNITY_IMAGES && (
								<p className="text-[11px] text-ios-text-secondary px-1">
									{communityImages.length === 1
										? "1 imagem selecionada"
										: `${communityImages.length} imagens selecionadas`}
								</p>
							)}
						{communityImages.length > 0 && (
							<div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2">
								{communityImages.map((img, i) => (
									<div
										key={`${img.url}-${i}`}
										className="relative aspect-square rounded-lg overflow-hidden bg-ios-gray-6 border border-ios-separator"
									>
										{/* eslint-disable-next-line @next/next/no-img-element -- preview local de blob URL */}
										<img
											src={img.url}
											alt={img.file?.name || `Imagem ${i + 1} da Biblioteca`}
											className="w-full h-full object-cover"
										/>
										<button
											type="button"
											onClick={() => removeCommunityImage(i)}
											aria-label={`Remover imagem ${i + 1}`}
											className="absolute top-1 right-1 bg-black/50 backdrop-blur p-2 rounded-full text-white"
										>
											<X size={12} />
										</button>
									</div>
								))}
							</div>
						)}
					</div>
				)}

				{/* ── Campos do Short do YouTube ──────────────────────────────── */}
				{isYoutubeChannel && youtubeType === "short" && (
					<div className="ios-inset-grouped bg-ios-card divide-y divide-ios-separator">
						<div className="p-4 bg-ios-card">
							<div className="flex items-center justify-between mb-1.5">
								<label
									htmlFor="yt-title"
									className="text-[15px] text-ios-text font-medium flex items-center gap-2"
								>
									<Youtube size={17} className="text-ios-red" />
									Título <span className="text-ios-red">*</span>
								</label>
								<span
									className={`text-[11px] tabular-nums ${titleExceeds ? "text-ios-red font-semibold" : "text-ios-text-secondary"}`}
								>
									{ytTitle.length}/{MAX_TITLE_LENGTH}
								</span>
							</div>
							<input
								id="yt-title"
								type="text"
								value={ytTitle}
								onChange={(e) => setYtTitle(e.target.value)}
								/* BK-08: sem maxLength para não matar validação — contador visual + slice no submit */
								placeholder="Título do Short (obrigatório)"
								className="w-full bg-transparent text-[16px] text-ios-text placeholder:text-ios-text-secondary focus:outline-none"
							/>
							{titleExceeds && (
								<p className="text-[11px] text-ios-red mt-1">
									O título excede o limite de {MAX_TITLE_LENGTH} caracteres do YouTube.
								</p>
							)}
						</div>

						<div className="p-4 bg-ios-card">
							<label
								htmlFor="yt-description"
								className="text-[15px] text-ios-text font-medium block mb-1.5"
							>
								Descrição
							</label>
							<div className="relative">
								<textarea
									id="yt-description"
									rows={3}
									maxLength={DESCRIPTION_LIMIT}
									value={ytDescription}
									onChange={(e) => setYtDescription(e.target.value)}
									placeholder="Descrição do vídeo (opcional)"
									className="block w-full bg-transparent text-[16px] text-ios-text placeholder:text-ios-text-secondary focus:outline-none resize-none"
								/>
								<span
									className={`absolute bottom-1 right-2 text-[11px] tabular-nums ${ytDescription.length > DESCRIPTION_LIMIT ? "text-ios-red" : "text-ios-text-secondary"}`}
								>
									{ytDescription.length}/{DESCRIPTION_LIMIT}
								</span>
							</div>
						</div>

						<div className="flex items-center justify-between p-4 bg-ios-card">
							<span className="text-[17px] text-ios-text font-medium flex items-center gap-2">
								Privacidade
								{ytPrivacy === "PUBLIC" && (
									<span
										className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-amber-400 text-amber-900 border border-amber-500/30"
										title="Será publicado publicamente — visível para todos no YouTube"
									>
										⚠️ Público
									</span>
								)}
							</span>
							<div className="flex items-center gap-2">
								{ytPrivacy === "PUBLIC" && (
									<span
										className="w-2 h-2 rounded-full bg-amber-400 animate-pulse"
										title="Visível para todos"
										aria-label="Público"
									/>
								)}
								<select
									title="Privacidade do Short"
									value={ytPrivacy}
									onChange={(e) => setYtPrivacy(e.target.value as typeof ytPrivacy)}
									className="bg-transparent text-[17px] text-ios-blue text-right focus:outline-none"
								>
									<option value="PUBLIC">Público</option>
									<option value="UNLISTED">Não listado</option>
									<option value="PRIVATE">Privado</option>
								</select>
							</div>
						</div>

						<label className="flex items-center justify-between p-4 bg-ios-card cursor-pointer">
							<span className="text-[17px] text-ios-text font-medium">
								Feito para crianças
							</span>
							<IOSSwitch
								checked={ytMadeForKids}
								onChange={setYtMadeForKids}
								ariaLabel="Feito para crianças"
							/>
						</label>

						<label className="flex items-center justify-between p-4 bg-ios-card cursor-pointer">
							<span className="text-[17px] text-ios-text font-medium">
								Monetizar com anúncios
							</span>
							<IOSSwitch
								checked={ytMonetize}
								onChange={setYtMonetize}
								ariaLabel="Monetizar com anúncios"
							/>
						</label>

						<div className="p-4 bg-ios-card">
							<label
								htmlFor="yt-pinned"
								className="text-[15px] text-ios-text font-medium block mb-1.5"
							>
								Comentário fixado{" "}
								<span className="text-ios-text-secondary font-normal">(opcional)</span>
							</label>
							<div className="relative">
								<input
									id="yt-pinned"
									type="text"
									maxLength={PINNED_LIMIT}
									value={ytPinnedComment}
									onChange={(e) => setYtPinnedComment(e.target.value)}
									placeholder="Comentário criado e fixado automaticamente após publicar"
									className="w-full bg-transparent text-[16px] text-ios-text placeholder:text-ios-text-secondary focus:outline-none pr-16"
								/>
								<span
									className={`absolute bottom-1 right-2 text-[11px] tabular-nums ${ytPinnedComment.length > PINNED_LIMIT ? "text-ios-red" : "text-ios-text-secondary"}`}
								>
									{ytPinnedComment.length}/{PINNED_LIMIT}
								</span>
							</div>
						</div>
					</div>
				)}

				{/* Legenda / texto do post */}
				<div className="ios-inset-grouped bg-ios-card divide-y divide-ios-separator">
					<div className="bg-ios-card">
						<div className="relative">
							<textarea
								id="caption"
								aria-label={isYoutubeChannel && youtubeType === "community" ? "Texto do post na Comunidade" : "Legenda do post"}
								rows={4}
								maxLength={CAPTION_LIMIT}
								className="block w-full bg-transparent p-4 text-[17px] text-ios-text placeholder:text-ios-text-secondary focus:outline-none resize-none"
								placeholder={
									isYoutubeChannel && youtubeType === "community"
										? "Texto do post na Comunidade (obrigatório)"
										: isYoutubeChannel
											? "Legenda interna (opcional)"
											: "Escreva uma legenda..."
								}
								value={caption}
								onChange={(e) => setCaption(e.target.value)}
							/>
							<span
								className={`absolute bottom-2 right-3 text-[11px] tabular-nums ${caption.length > CAPTION_LIMIT ? "text-ios-red" : "text-ios-text-secondary"}`}
							>
								{caption.length}/{CAPTION_LIMIT}
							</span>
						</div>
					</div>
				</div>

				{error && (
					<div role="alert" className="mx-4 p-3 bg-red-50 dark:bg-red-900/20 text-ios-red text-sm rounded-xl text-center">
						{error}
					</div>
				)}

				{/* BK-20: Modal de confirmação para PUBLIC */}
				{showPublicConfirm &&
					isYoutubeChannel &&
					youtubeType === "short" &&
					ytPrivacy === "PUBLIC" && (
						<div
							className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
							role="presentation"
							onClick={() => setShowPublicConfirm(false)}
						>
							<div ref={publicConfirmRef} role="dialog" aria-modal="true" aria-labelledby="public-confirm-title" tabIndex={-1} onClick={e => e.stopPropagation()} className="bg-ios-card w-full max-w-sm rounded-2xl overflow-hidden shadow-2xl border border-ios-separator">
								<div className="p-5 space-y-3">
									<div className="flex items-center gap-2 text-amber-600">
										<span className="w-8 h-8 rounded-full bg-amber-400 flex items-center justify-center text-amber-900 font-bold">
											!
										</span>
										<h3
											id="public-confirm-title"
											className="text-[17px] font-semibold text-ios-text"
										>
											Publicar como Público?
										</h3>
									</div>
									<p className="text-sm text-ios-secondary">
										Este Short será{" "}
										<span className="font-semibold text-amber-600">
											visível para todos
										</span>{" "}
										no YouTube. Confirme que deseja publicar como{" "}
										<span className="inline-flex px-1.5 py-0.5 rounded bg-amber-400 text-amber-900 text-xs font-bold">
											PÚBLICO
										</span>
										.
									</p>
									<div className="flex gap-2 pt-2">
										<button
											type="button"
											onClick={() => setShowPublicConfirm(false)}
											className="flex-1 py-2.5 rounded-xl bg-ios-separator text-ios-text font-semibold text-sm"
										>
											Cancelar
										</button>
										<button
											type="button"
											onClick={() => {
												setShowPublicConfirm(false);
												const evt = {
													preventDefault: () => {},
												} as unknown as React.FormEvent;
												handleSubmit(evt, true);
											}}
											className="flex-1 py-2.5 rounded-xl bg-amber-500 text-white font-semibold text-sm"
										>
											{scheduledAt ? "Confirmar agendamento" : "Confirmar e publicar"}
										</button>
									</div>
								</div>
							</div>
						</div>
					)}
				<div className="px-4">
					<button
						type="submit"
						disabled={!canSubmit || uploading}
						className="ios-btn bg-ios-blue text-white w-full py-3.5 rounded-xl font-semibold text-[17px] disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
					>
						{uploading
							? "Enviando..."
							: isYoutubeChannel
								? youtubeType === "short"
									? `${scheduledAt ? "Agendar" : "Publicar"} Short`
									: `${scheduledAt ? "Agendar" : "Publicar"} na Comunidade`
								: scheduledAt ? "Agendar post" : "Publicar post"}
					</button>
				</div>
			</form>
			{libraryOpen && <MediaLibraryPicker images={Boolean(isYoutubeChannel && youtubeType === "community")} onClose={() => setLibraryOpen(false)} onChoose={chooseLibraryMedia} />}
		</div>
	);
}
