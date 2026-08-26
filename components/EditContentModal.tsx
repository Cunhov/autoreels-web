"use client";
import { useState, useEffect } from "react";
import {
	X,
	Scissors,
	Image as ImageIcon,
	Video as VideoIcon,
} from "lucide-react";
import IOSButton from "./IOSButton";
import { escapeHtml, CAPTION_MAX } from "@/lib/sanitize";

interface ContentItem {
	id: string;
	name: string;
	title?: string;
	caption?: string;
	tags?: string[] | string;
	type: string;
	url?: string;
	video_url?: string;
	path?: string;
	duration?: number;
	thumbnail_url?: string;
}

/** Tags are stored as JSON string in DB; the API may return raw or normalized. */
function normalizeTags(raw: unknown): string[] {
	if (!raw) return [];
	if (Array.isArray(raw)) return raw as string[];
	if (typeof raw === "string") {
		try {
			const parsed = JSON.parse(raw);
			return Array.isArray(parsed) ? parsed : [];
		} catch {
			return [];
		}
	}
	return [];
}

function formatSeconds(total: number): string {
	if (!Number.isFinite(total) || total < 0) return "0:00";
	const m = Math.floor(total / 60);
	const s = Math.floor(total % 60);
	return `${m}:${String(s).padStart(2, "0")}`;
}

interface EditContentModalProps {
	isOpen: boolean;
	onClose: () => void;
	itemsToEdit: ContentItem[];
	onEditComplete: () => void;
}

export default function EditContentModal({
	isOpen,
	onClose,
	itemsToEdit,
	onEditComplete,
}: EditContentModalProps) {
	const [loading, setLoading] = useState(false);

	// Form states
	const [name, setName] = useState("");
	const [title, setTitle] = useState("");
	const [caption, setCaption] = useState("");
	const [tags, setTags] = useState<string[]>([]);
	const [tagInput, setTagInput] = useState("");

	// Video editing states (single video item only)
	const [videoDuration, setVideoDuration] = useState(0);
	const [thumbTime, setThumbTime] = useState(0.5);
	const [trimStart, setTrimStart] = useState(0);
	const [trimEnd, setTrimEnd] = useState(0);
	const [videoBusy, setVideoBusy] = useState(false);
	const [videoMsg, setVideoMsg] = useState<string | null>(null);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [videoMsgType, setVideoMsgType] = useState<"success" | "error">(
		"success",
	);

	const isBulk = itemsToEdit.length > 1;
	const singleItem = isBulk ? null : (itemsToEdit[0] ?? null);
	const isVideoItem = Boolean(singleItem && singleItem.type === "video");
	const videoSrc = singleItem?.video_url || singleItem?.url || "";
	const videoPath =
		singleItem && singleItem.name
			? [singleItem.path, singleItem.name].filter(Boolean).join("/")
			: "";

	useEffect(() => {
		if (isOpen && itemsToEdit.length > 0) {
			if (isBulk) {
				// Clear inputs for bulk edit or leave empty to "keep existing"
				setName("");
				setTitle("");
				setCaption("");
			} else {
				// Single item - prefill
				const item = itemsToEdit[0];
				setName(item.name || "");
				setTitle(item.title || "");
				setCaption(item.caption || "");
				setTags(normalizeTags(item.tags));
				setVideoDuration(item.duration || 0);
				setThumbTime(0.5);
				setTrimStart(0);
				setTrimEnd(item.duration || 0);
			}
				setVideoMsg(null);
			setSaveError(null);
		}
	}, [isOpen, itemsToEdit, isBulk]);

	const handleAddTag = (e: React.KeyboardEvent) => {
		if (e.key === "Enter" || e.key === ",") {
			e.preventDefault();
			// BK-12 split por vírgula e trim cada tag
			const parts = tagInput.split(",").map(t=>t.trim()).filter(Boolean);
			const next = [...tags];
			for (const p of parts) {
				const clean = escapeHtml(p).slice(0,50);
				if (clean && !next.includes(clean)) next.push(clean);
			}
			setTags(next);
			setTagInput("");
		}
	};

	// BK-12 onPaste: cria múltiplas tags em vez de tag única
	const handleTagPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
		e.preventDefault();
		const pasted = e.clipboardData.getData("text");
		const parts = pasted.split(",").map(t=>t.trim()).filter(Boolean);
		if (parts.length <=1) {
			const single = escapeHtml(pasted.trim()).slice(0,50);
			if (single && !tags.includes(single)) setTags([...tags, single]);
		} else {
			const next = [...tags];
			for (const p of parts) {
				const clean = escapeHtml(p).slice(0,50);
				if (clean && !next.includes(clean)) next.push(clean);
			}
			setTags(next);
		}
		setTagInput("");
	};

	const removeTag = (tagToRemove: string) => {
		setTags(tags.filter((tag) => tag !== tagToRemove));
	};

	const handleSave = async () => {
		// Validação client: nome vazio no modo individual seria rejeitado pelo
		// servidor (400 "Invalid name") — mostrar erro inline antes de salvar.
		if (!isBulk && !name.trim()) {
			setSaveError("Informe um nome para o item.");
			return;
		}
		setLoading(true);
		try {
			const updates: Record<string, unknown> = {};

			if (isBulk) {
				if (title.trim()) updates.title = escapeHtml(title.trim()).slice(0,200);
				if (caption.trim()) {
					let cap = caption.trim();
					if (cap.length> CAPTION_MAX) cap = cap.slice(0,CAPTION_MAX);
					updates.caption = escapeHtml(cap);
				}
				if (tags.length > 0) updates.tags = tags.map(t=> escapeHtml(t.trim()).slice(0,50)).filter(Boolean);
			} else {
				updates.name = escapeHtml(name.trim()).slice(0,200);
				let singleTitle = title.trim();
				if (singleTitle) singleTitle = escapeHtml(singleTitle).slice(0,200);
				updates.title = singleTitle;
				let cap = caption.trim();
				if (cap.length> CAPTION_MAX) cap = cap.slice(0,CAPTION_MAX);
				updates.caption = escapeHtml(cap);
				updates.tags = tags.map(t=> escapeHtml(t.trim()).slice(0,50)).filter(Boolean);
			}

			if (Object.keys(updates).length === 0) {
				onClose();
				return;
			}

			const ids = itemsToEdit.map((i) => i.id);

			// Serialize tags as JSON string for Prisma
			const payload: Record<string, unknown> = { ...updates };
			if (payload.tags) payload.tags = JSON.stringify(payload.tags);

			// Parallel PATCH (the bulk API has no 'update' action). If some items
			// fail, report the first error — the rest were already applied.
			const results = await Promise.all(
				ids.map((id) =>
					fetch(`/api/content-items/${id}`, {
						method: "PATCH",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(payload),
					}),
				),
			);
			const failed = results.filter((res) => !res.ok);
			if (failed.length > 0) {
				const first = await failed[0].json().catch(() => ({}));
				throw new Error(
					(first as { error?: string })?.error ||
						`Falha ao atualizar ${failed.length} de ${ids.length} itens`,
				);
			}

			onEditComplete();
			onClose();
		} catch (error) {
			console.error("Error updating items:", error);
			// Erro inline com a mensagem específica do servidor (ex.: "Invalid name")
			setSaveError(
				error instanceof Error && error.message
					? error.message
					: "Falha ao salvar as alterações.",
			);
		} finally {
			setLoading(false);
		}
	};

	const setVideoMessage = (
		msg: string,
		type: "success" | "error" = "success",
	) => {
		setVideoMsg(msg);
		setVideoMsgType(type);
	};

	/** Extract a frame from the video and set it as the item's thumbnail. */
	const handleExtractThumbnail = async () => {
		if (!singleItem || !videoPath || videoBusy) return;
		setVideoBusy(true);
		setVideoMsg(null);
		try {
			const res = await fetch("/api/video/thumbnail", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					item_id: singleItem.id,
					path: videoPath,
					time: thumbTime,
				}),
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok) {
				throw new Error(data?.error || "Falha ao extrair a capa");
			}
			setVideoMessage("Capa atualizada com sucesso");
			onEditComplete(); // refresh the library so the new thumbnail shows
		} catch (error) {
			console.error("Thumbnail extraction error:", error);
			setVideoMessage(
				(error as Error).message || "Erro ao extrair capa",
				"error",
			);
		} finally {
			setVideoBusy(false);
		}
	};

	/** Trim the video and create a NEW content item in the library. */
	const handleTrim = async () => {
		if (!videoPath || videoBusy) return;
		// BK-13 validar Number.isFinite e >=0 antes FFmpeg
		if (!Number.isFinite(trimStart) || !Number.isFinite(trimEnd)) {
			setVideoMessage("Informe valores válidos de início e fim", "error");
			return;
		}
		if (trimStart < 0 || trimEnd < 0) {
			setVideoMessage("Valores de corte devem ser >= 0", "error");
			return;
		}
		if (trimEnd <= trimStart) {
			setVideoMessage("O fim deve ser maior que o início", "error");
			return;
		}
		if (videoDuration > 0 && trimEnd > videoDuration) {
			setVideoMessage(
				`O fim (${formatSeconds(trimEnd)}) excede a duração do vídeo (${formatSeconds(videoDuration)})`,
				"error",
			);
			return;
		}
		setVideoBusy(true);
		setVideoMsg(null);
		try {
			const res = await fetch("/api/video/trim", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					path: videoPath,
					start: trimStart,
					end: trimEnd,
				}),
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok) {
				throw new Error(data?.error || "Falha ao cortar o vídeo");
			}
			setVideoMessage(
				`Corte criado na biblioteca (${formatSeconds(trimEnd - trimStart)})`,
			);
			onEditComplete(); // refresh the library so the new item appears
		} catch (error) {
			console.error("Video trim error:", error);
			setVideoMessage(
				(error as Error).message || "Erro ao cortar vídeo",
				"error",
			);
		} finally {
			setVideoBusy(false);
		}
	};

    useEffect(() => {
        if (!isOpen) return;
        const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('keydown', h);
        return () => document.removeEventListener('keydown', h);
    }, [isOpen, onClose]);

	if (!isOpen) return null;

	return (
		<div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-in fade-in duration-200" role="presentation" onClick={onClose}>
			<div role="dialog" aria-modal="true" aria-labelledby="edit-content-title" tabIndex={-1} onClick={(e)=>e.stopPropagation()} className="bg-white dark:bg-[#1C1C1E] w-full max-w-md rounded-2xl overflow-hidden shadow-2xl flex flex-col max-h-[85dvh] overflow-y-auto scale-100 animate-in zoom-in-95 duration-200">
				{/* Header */}
				<div className="px-5 py-4 border-b border-gray-100 dark:border-white/10 flex items-center justify-between bg-white/50 dark:bg-white/5 backdrop-blur-md">
					<div>
						<h2 id="edit-content-title" className="text-[17px] font-semibold text-gray-900 dark:text-white">
							{isBulk ? `Editar ${itemsToEdit.length} itens` : "Editar item"}
						</h2>
					</div>
					<button
						onClick={onClose}
						className="p-1 rounded-full hover:bg-black/5 dark:hover:bg-white/10 text-gray-500 transition-colors"
					>
						<X size={20} />
					</button>
				</div>

				{/* Content */}
				<div className="p-6 space-y-4 overflow-y-auto custom-scrollbar">
					{!isBulk && (
						<div>
							<label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1.5 uppercase tracking-wide">
								Nome
							</label>
							<input
								type="text"
								value={name}
								onChange={(e) => setName(e.target.value)}
								className="w-full bg-gray-100 dark:bg-white/10 border-0 rounded-xl px-4 py-3 text-[17px] text-gray-900 dark:text-white placeholder-gray-400 focus:ring-2 focus:ring-blue-500 focus:outline-none transition-all"
								placeholder="Nome do item"
							/>
						</div>
					)}

					<div>
						<label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1.5 uppercase tracking-wide">
							Título{" "}
							<span className="text-gray-400 lowercase font-normal">
								(opcional)
							</span>
						</label>
						<input
							type="text"
							value={title}
							onChange={(e) => setTitle(e.target.value)}
							maxLength={200}
							className="w-full bg-gray-100 dark:bg-white/10 border-0 rounded-xl px-4 py-3 text-[17px] text-gray-900 dark:text-white placeholder-gray-400 focus:ring-2 focus:ring-blue-500 focus:outline-none transition-all"
							placeholder={
								isBulk ? "Deixe vazio para manter o atual" : "Título do post"
							}
						/>
						<div className={`text-right text-[11px] tabular-nums ${title.length>200 ? "text-red-500" : "text-gray-400"}`}>{title.length}/200</div>
					</div>

					<div>
						<label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1.5 uppercase tracking-wide">
							Legenda{" "}
							<span className="text-gray-400 lowercase font-normal">
								(opcional)
							</span>
						</label>
						<textarea
							value={caption}
							onChange={(e) => setCaption(e.target.value)}
							maxLength={CAPTION_MAX}
							rows={4}
							className="w-full bg-gray-100 dark:bg-white/10 border-0 rounded-xl px-4 py-3 text-[17px] text-gray-900 dark:text-white placeholder-gray-400 focus:ring-2 focus:ring-blue-500 focus:outline-none resize-none transition-all"
							placeholder={
								isBulk ? "Deixe vazio para manter a atual" : "Escreva uma legenda..."
							}
						/>
						<div className={`text-right text-[11px] tabular-nums ${caption.length> CAPTION_MAX ? "text-red-500" : "text-gray-400"}`}>{caption.length}/{CAPTION_MAX}</div>
					</div>

					<div>
						<label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1.5 uppercase tracking-wide">
							Tags
						</label>
						<div className="w-full bg-gray-100 dark:bg-white/10 border-0 rounded-xl px-4 py-3 min-h-[50px] flex flex-wrap gap-2 items-center focus-within:ring-2 focus-within:ring-blue-500 transition-all">
							{tags.map((tag) => (
								<span
									key={tag}
									className="bg-blue-500/10 text-blue-500 px-2 py-1 rounded-md text-sm flex items-center gap-1"
								>
									{tag}
									<button
										onClick={() => removeTag(tag)}
										className="hover:text-blue-700"
									>
										<X size={12} />
									</button>
								</span>
							))}
							<input
								type="text"
								value={tagInput}
								onChange={(e) => setTagInput(e.target.value)}
								onKeyDown={handleAddTag}
								onPaste={handleTagPaste}
								className="bg-transparent border-none outline-none flex-1 min-w-[100px] text-[15px] text-gray-900 dark:text-white placeholder-gray-400"
								placeholder={
									tags.length === 0 ? "Adicionar tags (pressione Enter)..." : ""
								}
							/>
						</div>
					</div>

					{/* ── Video tools (single video item only) ─────────────────────── */}
					{isVideoItem && (
						<div className="rounded-2xl border border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-white/5 p-4 space-y-4">
							<div className="flex items-center gap-2">
								<VideoIcon size={16} className="text-blue-500" />
								<h3 className="text-[13px] font-semibold text-gray-900 dark:text-white uppercase tracking-wide">
									Vídeo
								</h3>
								{videoDuration > 0 && (
									<span className="text-[11px] text-gray-500 dark:text-gray-400 ml-auto">
										{formatSeconds(videoDuration)}
									</span>
								)}
							</div>

							{/* Preview */}
							{videoSrc && (
								<video
									key={videoSrc}
									src={videoSrc}
									controls
									preload="metadata"
									className="w-full aspect-video bg-black rounded-xl"
									onLoadedMetadata={(e) => {
										const d = e.currentTarget.duration;
										if (Number.isFinite(d) && d > 0) {
											setVideoDuration(d);
											setTrimEnd(d);
										}
									}}
								/>
							)}

							{/* Extract thumbnail */}
							<div className="space-y-2">
								<label className="flex items-center gap-1.5 text-xs font-medium text-gray-500 dark:text-gray-400">
									<ImageIcon size={13} />
									Extrair capa (thumbnail)
								</label>
								<div className="flex items-center gap-3">
									<input
										type="range"
										min={0}
										max={videoDuration > 0 ? videoDuration : 1}
										step={0.1}
										value={Math.min(
											thumbTime,
											videoDuration > 0 ? videoDuration : 1,
										)}
										onChange={(e) => setThumbTime(Number(e.target.value))}
										disabled={videoBusy}
										className="flex-1 accent-blue-500"
									/>
									<span className="text-[12px] text-gray-600 dark:text-gray-300 tabular-nums w-12 text-right">
										{formatSeconds(thumbTime)}
									</span>
								</div>
								<IOSButton
									variant="secondary"
									onClick={handleExtractThumbnail}
									disabled={videoBusy || videoDuration <= 0}
									className="w-full justify-center text-sm py-2"
								>
									{videoBusy ? "Processando..." : "Usar este frame como capa"}
								</IOSButton>
							</div>

							{/* Trim */}
							<div className="space-y-2 pt-1 border-t border-gray-200 dark:border-white/10">
								<label className="flex items-center gap-1.5 text-xs font-medium text-gray-500 dark:text-gray-400">
									<Scissors size={13} />
									Cortar vídeo (segundos)
								</label>
								<div className="flex items-center gap-2">
									<input
										type="number"
										min={0}
										step={0.1}
										value={trimStart}
										onChange={(e) => setTrimStart(Number(e.target.value))}
										disabled={videoBusy}
										placeholder="Início"
										className="w-1/2 bg-white dark:bg-white/10 border border-gray-200 dark:border-white/10 rounded-lg px-3 py-2 text-[14px] text-gray-900 dark:text-white placeholder-gray-400 focus:ring-2 focus:ring-blue-500 focus:outline-none"
									/>
									<input
										type="number"
										min={0}
										step={0.1}
										value={trimEnd}
										onChange={(e) => setTrimEnd(Number(e.target.value))}
										disabled={videoBusy}
										placeholder="Fim"
										className="w-1/2 bg-white dark:bg-white/10 border border-gray-200 dark:border-white/10 rounded-lg px-3 py-2 text-[14px] text-gray-900 dark:text-white placeholder-gray-400 focus:ring-2 focus:ring-blue-500 focus:outline-none"
									/>
								</div>
								<IOSButton
									variant="primary"
									onClick={handleTrim}
									disabled={videoBusy}
									className="w-full justify-center text-sm py-2"
								>
									{videoBusy ? "Processando..." : "Criar corte"}
								</IOSButton>
								<p className="text-[11px] text-gray-400 dark:text-gray-500">
									Cria um novo item na biblioteca com o trecho selecionado.
								</p>
							</div>

							{/* Result message */}
							{videoMsg && (
								<p
									className={`text-[12px] font-medium ${videoMsgType === "success" ? "text-green-600 dark:text-green-400" : "text-red-500 dark:text-red-400"}`}
								>
									{videoMsg}
								</p>
							)}
						</div>
					)}
				</div>

				{/* Footer */}
				<div className="p-4 border-t border-gray-100 dark:border-white/10 bg-gray-50 dark:bg-white/5 space-y-2">
					{saveError && (
						<p className="text-[12px] font-medium text-red-500 dark:text-red-400 text-center">{saveError}</p>
					)}
					<div className="flex gap-3">
					<IOSButton
						variant="secondary"
						onClick={onClose}
						className="flex-1 justify-center"
						disabled={loading}
					>
						Cancelar
					</IOSButton>
					<IOSButton
						variant="primary"
						onClick={handleSave}
						className="flex-1 justify-center"
						disabled={loading}
					>
						{loading ? "Salvando..." : "Salvar alterações"}
					</IOSButton>
					</div>
				</div>
			</div>
		</div>
	);
}
