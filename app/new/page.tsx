"use client";
import { useState, useEffect, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { Upload, X, Radio, Calendar as CalendarIcon, Youtube, Film, MessageSquare, ImagePlus } from "lucide-react";
import { useUploadActions } from "@/contexts/UploadContext";

interface Channel {
	id: string;
	name: string;
	platform: string;
}

type YoutubeType = "short" | "community";

const MAX_TITLE_LENGTH = 100;
const MAX_COMMUNITY_IMAGES = 10;

export default function NewPost() {
	const router = useRouter();
	const { data: session } = useSession();
	const { uploadAndWait } = useUploadActions();
	const [channels, setChannels] = useState<Channel[]>([]);
	const [selectedChannel, setSelectedChannel] = useState("");
	const [scheduledAt, setScheduledAt] = useState("");
	const [file, setFile] = useState<File | null>(null);
	const [previewUrl, setPreviewUrl] = useState<string | null>(null);
	const [caption, setCaption] = useState("");
	const [uploading, setUploading] = useState(false);
	const [error, setError] = useState("");
	// Falha ao carregar canais: estado distinto de vazio (DoD #5) — sem isso o
	// usuário vê só "Default Account" e não sabe por que o canal YouTube some.
	const [channelsError, setChannelsError] = useState("");

	// ── YouTube ──
	const isYoutubeChannel =
		channels.find((c) => c.id === selectedChannel)?.platform === "youtube";
	const [youtubeType, setYoutubeType] = useState<YoutubeType>("short");
	// Opções do Short (salvas em Post.youtube_options)
	const [ytTitle, setYtTitle] = useState("");
	const [ytDescription, setYtDescription] = useState("");
	const [ytPrivacy, setYtPrivacy] = useState<"PUBLIC" | "UNLISTED" | "PRIVATE">("PRIVATE");
	const [ytMadeForKids, setYtMadeForKids] = useState(false);
	const [ytMonetize, setYtMonetize] = useState(false);
	const [ytPinnedComment, setYtPinnedComment] = useState("");
	// Imagens da Comunidade (até 10)
	interface CommunityImage {
		file: File;
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
		try {
			const res = await fetch("/api/channels");
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			setChannels(data);
		} catch (err) {
			console.error("Failed to load channels:", err);
			setChannels([]);
			setChannelsError("Não foi possível carregar os canais. Verifique sua conexão e tente novamente.");
		}
	}

	const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const selected = e.target.files?.[0] || null;
		if (previewUrl) URL.revokeObjectURL(previewUrl);
		setFile(selected);
		setPreviewUrl(selected ? URL.createObjectURL(selected) : null);
		// Reset so selecting the same file again re-triggers onChange
		e.target.value = "";
	};

	/** Seleção de imagens para o post da Comunidade (máx. 10). */
	const handleCommunityImagesChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const selected = Array.from(e.target.files || []).map((file) => ({
			file,
			url: URL.createObjectURL(file),
		}));
		// Merge/descartes calculados FORA do updater (updaters devem ser puros;
		// em StrictMode são invocados duas vezes).
		const merged = [...communityImages, ...selected].slice(0, MAX_COMMUNITY_IMAGES);
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

	const titleExceeds = ytTitle.length > MAX_TITLE_LENGTH;
	const canSubmit = useMemo(() => {
		if (isYoutubeChannel) {
			if (youtubeType === "short") {
				return Boolean(file) && ytTitle.trim().length > 0 && !titleExceeds;
			}
			return communityImages.length > 0 && caption.trim().length > 0;
		}
		return Boolean(file);
	}, [isYoutubeChannel, youtubeType, file, ytTitle, titleExceeds, communityImages.length, caption]);

	// Upload the file via the global upload queue (chunked, resumable).
	// uploadAndWait enqueues the file and resolves when the task finishes.
	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!canSubmit) return;

		setUploading(true);
		setError("");

		try {
			if (!session?.user)
				throw new Error("Você precisa estar logado para criar uma publicação.");

			let videoUrl: string | null = null;
			let imageUrl: string | null = null;
			let childrenUrls: string | null = null;

			if (isYoutubeChannel && youtubeType === "community") {
				// Comunidade: sobe as imagens (1..10) e guarda em children_urls —
				// é exatamente o campo que o publisher lê para montar o multipart.
				const results = await uploadAndWait(
					communityImages.map((img) => img.file),
					{ folderId: null },
				);
				const urls: string[] = [];
				for (const r of results) {
					if (r.error || !r.item?.url) {
						throw new Error(r.error || "Falha ao enviar uma das imagens");
					}
					urls.push(r.item.url as string);
				}
				imageUrl = urls[0];
				childrenUrls = JSON.stringify(urls.map((url) => ({ url, type: "image" })));
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
				caption: caption,
				status: "pending",
				channel_id: selectedChannel || null,
				// Convert local datetime string to absolute ISO so the server (UTC)
				// interprets the user's local wall-clock correctly. If empty, the
				// cron publisher picks it up on the next tick (it treats NULL as due).
				scheduled_at: scheduledAt
					? new Date(scheduledAt).toISOString()
					: null,
			};
			if (videoUrl) body.video_url = videoUrl;
			if (imageUrl) body.image_url = imageUrl;
			if (childrenUrls) body.children_urls = childrenUrls;

			if (isYoutubeChannel) {
				body.media_type = youtubeType === "community" ? "IMAGE" : "VIDEO";
				body.youtube_type = youtubeType;
				if (youtubeType === "short") {
					body.youtube_options = JSON.stringify({
						title: ytTitle.trim(),
						description: ytDescription,
						privacy: ytPrivacy,
						made_for_kids: ytMadeForKids,
						monetize_with_ads: ytMonetize,
						...(ytPinnedComment.trim() ? { pinned_comment_text: ytPinnedComment.trim() } : {}),
					});
				}
			} else {
				body.media_type = "REELS";
			}

			const res = await fetch("/api/posts", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
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
					<div className="flex items-center justify-between p-4 bg-ios-card">
						<label className="text-[17px] text-ios-text font-medium flex items-center gap-2">
							<Radio size={18} className="text-ios-blue" />
							Canal
						</label>
						<select
							title="Canal"
							value={selectedChannel}
							onChange={(e) => setSelectedChannel(e.target.value)}
							className="bg-transparent text-[17px] text-ios-blue text-right focus:outline-none max-w-[60%]"
						>
							<option value="">Default Account</option>
							{channels.map((c) => (
								<option key={c.id} value={c.id}>
									{c.platform === "youtube" ? "▶ " : ""}
									{c.name}
								</option>
							))}
						</select>
					</div>

					<div className="flex items-center justify-between p-4 bg-ios-card">
						<label className="text-[17px] text-ios-text font-medium flex items-center gap-2">
							<CalendarIcon size={18} className="text-ios-blue" />
							Agendar
						</label>
						<input
							title="Agendamento"
							type="datetime-local"
							value={scheduledAt}
							onChange={(e) => setScheduledAt(e.target.value)}
							className="bg-transparent text-[17px] text-ios-blue text-right focus:outline-none"
						/>
					</div>
				</div>

				{/* ── Escolha do tipo de conteúdo YouTube ─────────────────────── */}
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
					<div className="px-4">
						<div className="grid grid-cols-2 gap-2 p-1 bg-ios-separator/50 rounded-xl">
							<button
								type="button"
								onClick={() => setYoutubeType("short")}
								className={`py-2.5 rounded-lg text-sm font-semibold flex items-center justify-center gap-1.5 ${youtubeType === "short" ? "bg-ios-card text-ios-red shadow-sm" : "text-ios-secondary"}`}
							>
								<Film size={15} /> Short
							</button>
							<button
								type="button"
								onClick={() => setYoutubeType("community")}
								className={`py-2.5 rounded-lg text-sm font-semibold flex items-center justify-center gap-1.5 ${youtubeType === "community" ? "bg-ios-card text-ios-red shadow-sm" : "text-ios-secondary"}`}
							>
								<MessageSquare size={15} /> Comunidade
							</button>
						</div>
					</div>
				)}

				{/* ── Mídia ── */}
				{(!isYoutubeChannel || youtubeType === "short") ? (
					/* Vídeo: Reels do Instagram OU Short do YouTube */
					<div className="px-4">
						<label
							htmlFor="file-upload"
							className={`block w-full aspect-[9/16] max-w-[200px] mx-auto rounded-xl border-2 border-dashed transition-all relative overflow-hidden bg-ios-card ${file ? "border-ios-blue" : "border-ios-separator hover:border-ios-blue/50"}`}
						>
							{file ? (
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
											{file.name}
										</span>
									</div>
									<button
										type="button"
										onClick={(e) => {
											e.preventDefault();
											if (previewUrl) URL.revokeObjectURL(previewUrl);
											setFile(null);
											setPreviewUrl(null);
										}}
										className="absolute top-2 right-2 bg-white/20 backdrop-blur-md p-1 rounded-full text-white"
									>
										<X size={16} />
									</button>
								</div>
							) : (
								<div className="w-full h-full flex flex-col items-center justify-center text-ios-text-secondary gap-2 cursor-pointer">
									<Upload size={32} />
									<span className="text-sm font-medium">{isYoutubeChannel ? "Selecionar vídeo do Short" : "Selecionar vídeo"}</span>
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
								required={!file && (!isYoutubeChannel || youtubeType === "short")}
							/>
						</label>
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
								<span className="text-sm font-medium">Adicionar imagens</span>
								<span className="text-[10px]">JPEG, PNG, GIF ou WebP · até {MAX_COMMUNITY_IMAGES}</span>
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
								Limite de {MAX_COMMUNITY_IMAGES} imagens — {imagesDropped} descartada(s). Remova uma imagem para adicionar outra.
							</p>
						)}
						{communityImages.length > 0 && (
							<div className="grid grid-cols-5 gap-2">
								{communityImages.map((img, i) => (
								<div key={`${img.file.name}-${i}`} className="relative aspect-square rounded-lg overflow-hidden bg-ios-gray-6 border border-ios-separator">
									{/* eslint-disable-next-line @next/next/no-img-element -- preview local de blob URL */}
									<img src={img.url} alt={img.file.name} className="w-full h-full object-cover" />
									<button
										type="button"
										onClick={() => removeCommunityImage(i)}
										className="absolute top-1 right-1 bg-black/50 backdrop-blur p-0.5 rounded-full text-white"
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
								<label htmlFor="yt-title" className="text-[15px] text-ios-text font-medium flex items-center gap-2">
									<Youtube size={17} className="text-ios-red" />
									Título <span className="text-ios-red">*</span>
								</label>
								<span className={`text-[11px] tabular-nums ${titleExceeds ? "text-ios-red font-semibold" : "text-ios-text-secondary"}`}>
									{ytTitle.length}/{MAX_TITLE_LENGTH}
								</span>
							</div>
							<input
								id="yt-title"
								type="text"
								value={ytTitle}
								onChange={(e) => setYtTitle(e.target.value)}
								maxLength={MAX_TITLE_LENGTH + 20}
								placeholder="Título do Short (obrigatório)"
								className="w-full bg-transparent text-[16px] text-ios-text placeholder:text-ios-text-secondary focus:outline-none"
							/>
							{titleExceeds && (
								<p className="text-[11px] text-ios-red mt-1">O título excede o limite de {MAX_TITLE_LENGTH} caracteres do YouTube.</p>
							)}
						</div>

						<div className="p-4 bg-ios-card">
							<label htmlFor="yt-description" className="text-[15px] text-ios-text font-medium block mb-1.5">
								Descrição
							</label>
							<textarea
								id="yt-description"
								rows={3}
								value={ytDescription}
								onChange={(e) => setYtDescription(e.target.value)}
								placeholder="Descrição do vídeo (opcional)"
								className="block w-full bg-transparent text-[16px] text-ios-text placeholder:text-ios-text-secondary focus:outline-none resize-none"
							/>
						</div>

						<div className="flex items-center justify-between p-4 bg-ios-card">
							<span className="text-[17px] text-ios-text font-medium">Privacidade</span>
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

						<label className="flex items-center justify-between p-4 bg-ios-card cursor-pointer">
							<span className="text-[17px] text-ios-text font-medium">Feito para crianças</span>
							<button
								type="button"
								role="switch"
								aria-checked={ytMadeForKids}
								onClick={() => setYtMadeForKids((v) => !v)}
								className={`w-[51px] h-[31px] rounded-full p-[2px] transition-colors ${ytMadeForKids ? "bg-ios-green" : "bg-ios-separator"}`}
							>
								<span className={`block w-[27px] h-[27px] rounded-full bg-white shadow transition-transform ${ytMadeForKids ? "translate-x-[20px]" : ""}`} />
							</button>
						</label>

						<label className="flex items-center justify-between p-4 bg-ios-card cursor-pointer">
							<span className="text-[17px] text-ios-text font-medium">Monetizar com anúncios</span>
							<button
								type="button"
								role="switch"
								aria-checked={ytMonetize}
								onClick={() => setYtMonetize((v) => !v)}
								className={`w-[51px] h-[31px] rounded-full p-[2px] transition-colors ${ytMonetize ? "bg-ios-green" : "bg-ios-separator"}`}
							>
								<span className={`block w-[27px] h-[27px] rounded-full bg-white shadow transition-transform ${ytMonetize ? "translate-x-[20px]" : ""}`} />
							</button>
						</label>

						<div className="p-4 bg-ios-card">
							<label htmlFor="yt-pinned" className="text-[15px] text-ios-text font-medium block mb-1.5">
								Comentário fixado <span className="text-ios-text-secondary font-normal">(opcional)</span>
							</label>
							<input
								id="yt-pinned"
								type="text"
								value={ytPinnedComment}
								onChange={(e) => setYtPinnedComment(e.target.value)}
								placeholder="Comentário criado e fixado automaticamente após publicar"
								className="w-full bg-transparent text-[16px] text-ios-text placeholder:text-ios-text-secondary focus:outline-none"
							/>
						</div>
					</div>
				)}

				{/* Legenda / texto do post */}
				<div className="ios-inset-grouped bg-ios-card divide-y divide-ios-separator">
					<div className="bg-ios-card">
						<textarea
							id="caption"
							rows={4}
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
					</div>
				</div>

				{error && (
					<div className="mx-4 p-3 bg-red-50 dark:bg-red-900/20 text-ios-red text-sm rounded-xl text-center">
						{error}
					</div>
				)}

				<div className="px-4">
					<button
						type="submit"
						disabled={!canSubmit || uploading}
						className="ios-btn bg-ios-blue text-white w-full py-3.5 rounded-xl font-semibold text-[17px] disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
					>
						{uploading ? "Enviando..." : isYoutubeChannel ? (youtubeType === "short" ? "Agendar Short" : "Agendar post na Comunidade") : "Compartilhar"}
					</button>
				</div>
			</form>
		</div>
	);
}
