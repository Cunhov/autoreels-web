"use client";
import { useState, useEffect, useMemo, useRef } from "react";
import { useSession } from "next-auth/react";
import {
	X,
	ChevronRight,
	ChevronLeft,
	Clock,
	Instagram,
	Check,
	Youtube,
} from "lucide-react";
import IOSButton from "@/components/IOSButton";
import MediaUploader from "./MediaUploader";
import ContentLibrary from "./ContentLibrary";
import { useUploadActions } from "@/contexts/UploadContext";
import {
	normalizeYoutubeProductsList,
	resolveCaptionTextForWizard,
	serializeYoutubeProducts,
	type YoutubeProductEntry,
} from "@/lib/planner-config";

const PLANNER_MIX_ERROR = "Planners não podem misturar canais de YouTube e Instagram. Crie planners separados.";

// B1 — produtos afiliados: resultado da busca live (mesmo shape do payload
// GET /api/youtube/products: { item, title, vendor, price, commission_pct }).
interface YoutubeProductSearchResult {
	item?: unknown;
	title?: string;
	vendor?: string;
	price?: string;
	commission_pct?: number;
	[key: string]: unknown;
}

// Entrada da lista dinâmica: digita nome (status name/searching) OU fixa um
// item verbatim da busca (status selected -> config.youtube_products {query,item}).
interface YoutubeProductDraft {
	key: string;
	query: string;
	status: "idle" | "searching" | "selected" | "name" | "error";
	item?: unknown;
	title?: string;
	vendor?: string;
	price?: string;
	commissionPct?: number;
	results: YoutubeProductSearchResult[];
	error?: string;
}

interface Channel {
	id: string;
	name: string;
	account_id: string;
	platform?: string;
	status?: string;
}

/** Dados de edição de um planner existente (carregados do GET /api/planners). */
interface PlannerWizardInitial {
	id?: string;
	name?: string | null;
	config?: unknown; // objeto ou JSON string — parse defensivo abaixo
	channels?: { id?: string }[];
	channel_ids?: string[];
}

/**
 * Rótulo de mídia do preview por plataforma: planners só-YouTube mostram
 * "Short do YouTube"/"Post na Comunidade"; planners mistos IG+YT mostram os
 * dois destinos (o conteúdo vai para ambas as plataformas).
 */
function plannerMediaLabel(
	mediaType: string,
	isCarousel: boolean,
	youtubeMode: "only" | "mixed" | "none",
): string {
	const igLabel = isCarousel
		? "Carrossel"
		: mediaType === "REELS"
			? "Reels"
			: mediaType === "STORIES"
				? "Story"
				: "Imagem";
	if (youtubeMode === "none") return igLabel;
	const ytLabel =
		isCarousel || mediaType === "IMAGE"
			? "Post na Comunidade"
			: "Short do YouTube";
	return youtubeMode === "only" ? ytLabel : `${igLabel} · ${ytLabel}`;
}

interface PlannerWizardProps {
	isOpen: boolean;
	onClose: () => void;
	onSuccess: () => void;
	initialData?: PlannerWizardInitial;
}

const STEPS = [
	{ id: "basics", title: "Basics" },
	{ id: "accounts", title: "Accounts" },
	{ id: "content", title: "Content" },
	{ id: "schedule", title: "Schedule" },
	{ id: "sorting", title: "Sorting" },
];

/** Convert an ISO timestamp to a local 'YYYY-MM-DDTHH:mm' value for <input type="datetime-local">. */
function toLocalDateTimeInput(iso: string | null | undefined): string {
	if (!iso) return "";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Shape of an entry in planner config.content (library items, legacy uploads, carousels).
interface ContentEntry {
	type?: string;
	id?: string;
	folder_id?: string;
	url?: string;
	children_urls?: Array<{ url?: string; id?: string; type?: string }>;
	media_type?: string;
	[key: string]: unknown;
}

// Shape do config de um planner (objeto parseado; `config` chega como JSON
// string do GET /api/planners e é parseado defensivamente no carregamento).
interface PlannerConfigJson {
	frequency?: { value?: number; unit?: string };
	timezone?: string;
	start_time?: string;
	sort_order?: string;
	sleep_schedule?: { start?: string; end?: string } | null;
	content?: ContentEntry[];
	caption_templates?: string[];
	caption_rotation?: string;
	[key: string]: unknown;
}

export default function PlannerWizard({
	isOpen,
	onClose,
	onSuccess,
	initialData,
}: PlannerWizardProps) {
	const { uploadAndWait } = useUploadActions();

	const [step, setStep] = useState(0);
	const [loading, setLoading] = useState(false);
	const { data: session } = useSession();
	// BK-05: debounce 800ms + idempotency planner
	const lastPlannerSubmitRef = useRef<number>(0);
	const plannerIdempotencyRef = useRef<string | null>(null);
	const [uploading, setUploading] = useState(false);
	const [channels, setChannels] = useState<Channel[]>([]);

	// Form State
	const [name, setName] = useState("");
	const [selectedChannels, setSelectedChannels] = useState<string[]>([]);
	const [files, setFiles] = useState<File[]>([]);
	const [selectedContentIds, setSelectedContentIds] = useState<string[]>([]);
	const [contentTab, setContentTab] = useState<"upload" | "library">("upload");
	const [frequencyValue, setFrequencyValue] = useState(1);
	const [frequencyUnit, setFrequencyUnit] = useState("hours"); // minutes, hours, days
	const [timezone, setTimezone] = useState("America/Sao_Paulo");
	const [startTime, setStartTime] = useState("");
	const [sleepEnabled, setSleepEnabled] = useState(false);
	const [sleepStart, setSleepStart] = useState("00:00");
	const [sleepEnd, setSleepEnd] = useState("06:00");
	const [sortOrder, setSortOrder] = useState("random_loop"); // random_loop, old_to_new, new_to_old

	// Advanced Content Settings
	const [mediaType, setMediaType] = useState<
		"REELS" | "STORIES" | "IMAGE" | "CAROUSEL"
	>("REELS");
	const [shareToFeed, setShareToFeed] = useState(true);
	const [isCarousel, setIsCarousel] = useState(false);
	const [caption, setCaption] = useState("");
	const [captionTemplates, setCaptionTemplates] = useState("");
	const [captionRotation, setCaptionRotation] = useState<
		"off" | "sequential" | "random"
	>("off");
	const [location, setLocation] = useState("");
	const [captionFallback, setCaptionFallback] = useState("");
	const [titleFallback, setTitleFallback] = useState("");
	const [collaborators, setCollaborators] = useState("");
	const [userTags, setUserTags] = useState("");
	const [audioId, setAudioId] = useState("");
	const [audioVolume, setAudioVolume] = useState(80);
	const [videoVolume, setVideoVolume] = useState(20);
	// YouTube planner fields (só quando onlyYoutubeSelected)
	const [youtubeTitle, setYoutubeTitle] = useState("");
	const [youtubeDescription, setYoutubeDescription] = useState("");
	// B1: produtos afiliados — lista dinâmica de {query, item?} (nunca CSV cru)
	const [youtubeProductDrafts, setYoutubeProductDrafts] = useState<YoutubeProductDraft[]>([]);
	const youtubeProductKeyRef = useRef(1);
	// timers de debounce por entrada (busca live ~600ms)
	const youtubeProductTimersRef = useRef<Record<string, number>>({});
	const [youtubePrivacy, setYoutubePrivacy] = useState<"PUBLIC"|"PRIVATE"|"UNLISTED">("PUBLIC");
	const [youtubeMadeForKids, setYoutubeMadeForKids] = useState(false);
	const [youtubeMonetizeWithAds, setYoutubeMonetizeWithAds] = useState(false);
	const [youtubeCategoryId, setYoutubeCategoryId] = useState("");
	const [youtubePinnedComment, setYoutubePinnedComment] = useState("");
	const [formError, setFormError] = useState("");
	// Count of existing content items that the UI cannot represent (legacy direct
	// uploads). They are preserved as-is on save so editing a planner never loses them.
	const [preservedCount, setPreservedCount] = useState(0);
	// Original config.content snapshot + per-item post settings, captured when an
	// edit session starts. Used on save to keep heterogeneous items intact and to
	// rebuild the original order (no flattening, no legacy loss, no reordering).
	const [originalContent, setOriginalContent] = useState<ContentEntry[]>([]);
	const [originalItemSettings, setOriginalItemSettings] = useState<
		Record<string, ContentEntry>
	>({});
	// Becomes true the moment the user edits any post setting. While false, each
	// existing item keeps its OWN original settings instead of being flattened to
	// the values of the first item (or of the UI).
	const [settingsTouched, setSettingsTouched] = useState(false);

	const selectedChannelNames = useMemo(() => {
		return selectedChannels
			.map((id) => channels.find((channel) => channel.id === id)?.name)
			.filter(Boolean) as string[];
	}, [channels, selectedChannels]);

	// Algum canal selecionado é do YouTube? (muda o rótulo de mídia no preview)
	const youtubeSelected = useMemo(() => {
		return selectedChannels.some(
			(id) => channels.find((c) => c.id === id)?.platform === "youtube",
		);
	}, [channels, selectedChannels]);

	// TODOS os canais selecionados são YouTube? Oculta campos exclusivos do
	// Instagram (Location/Collabs/Tags/Audio/Share to Feed) e restringe o tipo
	// de mídia (vídeo → Short, imagem/carrossel → Comunidade).
	const onlyYoutubeSelected = useMemo(() => {
		return (
			youtubeSelected &&
			selectedChannels.length > 0 &&
			selectedChannels.every(
				(id) => channels.find((c) => c.id === id)?.platform === "youtube",
			)
		);
	}, [youtubeSelected, channels, selectedChannels]);

	// Planners com canal YouTube não têm "Story": em planners mistos IG+YT o
	// post do canal YT seria classificado como Short sem vídeo (falha permanente
	// no publisher, ciclo após ciclo). Corrige automaticamente para Short.
	// NÃO marca settingsTouched: o auto-fix roda durante o load da edição e
	// marcar aqui faria um save sem edições reais reconstruir todas as entradas
	// com globalSettings, achatando as configurações por-item preservadas.
	useEffect(() => {
		if (youtubeSelected && mediaType === "STORIES") {
			setMediaType("REELS");
		}
	}, [youtubeSelected, mediaType]);

	// Modo YouTube do rótulo de mídia: só-YouTube / misto IG+YT / nenhum.
	const youtubeMode = useMemo<"only" | "mixed" | "none">(() => {
		if (!youtubeSelected) return "none";
		return onlyYoutubeSelected ? "only" : "mixed";
	}, [youtubeSelected, onlyYoutubeSelected]);

	// Isolation: tipo do planner e detecção de mix
	const selectedPlatformType = useMemo<"youtube" | "instagram" | null>(() => {
		if (selectedChannels.length === 0) return null;
		if (onlyYoutubeSelected) return "youtube";
		if (!youtubeSelected) return "instagram";
		return null; // nunca misto quando isolamento ativo (bloqueado antes)
	}, [selectedChannels, onlyYoutubeSelected, youtubeSelected]);

	const isChannelDisabled = (channel: Channel) => {
		if (selectedChannels.length === 0) return false;
		if (selectedChannels.includes(channel.id)) return false;
		const chPlatform = (channel.platform || "").toLowerCase();
		if (selectedPlatformType === "youtube" && chPlatform !== "youtube") return true;
		if (selectedPlatformType === "instagram" && chPlatform === "youtube") return true;
		return false;
	};

	const hasMixSelected = useMemo(() => {
		const platforms = new Set(
			selectedChannels
				.map((id) => (channels.find((c) => c.id === id)?.platform || "").toLowerCase())
				.filter(Boolean),
		);
		return platforms.size > 1;
	}, [selectedChannels, channels]);

	const scheduleSummary = useMemo(() => {
		const frequency = `${frequencyValue} ${frequencyUnit}`;
		const sleep = sleepEnabled ? `${sleepStart} - ${sleepEnd}` : "off";
		const start = startTime
			? new Date(startTime).toLocaleString()
			: "immediately";
		const contentCount =
			files.length + selectedContentIds.length + preservedCount;
		return {
			frequency,
			sleep,
			start,
			contentCount,
			channels: selectedChannelNames.length,
		};
	}, [
		frequencyValue,
		frequencyUnit,
		sleepEnabled,
		sleepStart,
		sleepEnd,
		startTime,
		files.length,
		selectedContentIds.length,
		preservedCount,
		selectedChannelNames.length,
	]);

	// The page re-creates the planner object on every render (it maps and
	// spreads), so [initialData] identity changes mid-edit — the load/reset
	// block below would re-run and RESET the selection the user just loaded
	// (user-reported: edited planners lose their selected posts). Guard by
	// open-key: run the load/reset exactly once per open session.
	const loadedForRef = useRef<string | null>(null);

	useEffect(() => {
		if (!isOpen) {
			loadedForRef.current = null;
			return;
		}
		// Run the load/reset block ONCE per open session. The page re-creates the
		// planner object each render, so [initialData] identity oscillates
		// (null -> planner -> null) mid-edit — without this guard the final
		// null re-run would RESET the selection just loaded (user-reported:
		// edited planners lose their selected posts). The null->planner
		// transition inside an open session is allowed (the mount may see null
		// first); returning to null afterwards is skipped.
		const openKey = initialData?.id ?? "__new__";
		if (loadedForRef.current === openKey) return;
		if (
			loadedForRef.current !== null &&
			!(loadedForRef.current === "__new__" && openKey !== "__new__")
		) {
			return;
		}
		loadedForRef.current = openKey;

		if (isOpen) {
			fetchChannels();
			setStep(0);

			if (initialData) {
				setName(initialData.name || "");
				// The API may expose channels as `channels` (objects) or `channel_ids`;
				// prefer the former so an edit never deselects every channel.
				setSelectedChannels(
					initialData.channels
						?.map((c) => c.id)
						.filter((id): id is string => Boolean(id)) ||
						initialData.channel_ids ||
						[],
				);
				// Defensive parse: config may arrive as a (double) JSON string from the API.
				let rawConfig: unknown = initialData.config || {};
				if (typeof rawConfig === "string") {
					try {
						rawConfig = JSON.parse(rawConfig);
						if (typeof rawConfig === "string") rawConfig = JSON.parse(rawConfig);
					} catch {
						rawConfig = {};
					}
				}
				const config = rawConfig as PlannerConfigJson;
				setFrequencyValue(config.frequency?.value || 1);
				setFrequencyUnit(config.frequency?.unit || "hours");
				setTimezone(config.timezone || "America/Sao_Paulo");
				setStartTime(toLocalDateTimeInput(config.start_time));
				setSortOrder(config.sort_order || "random_loop");

				if (config.sleep_schedule) {
					setSleepEnabled(true);
					setSleepStart(config.sleep_schedule.start || "00:00");
					setSleepEnd(config.sleep_schedule.end || "06:00");
				} else {
					setSleepEnabled(false);
					setSleepStart("00:00");
					setSleepEnd("06:00");
				}

				// Load existing content
				const content = config.content || [];
				if (content.length > 0) {
					// Items the UI can represent: library items and folder-based carousels.
					// Everything else (legacy direct uploads, type:'config') is preserved as-is.
					const libIds: string[] = [];
					let legacyCount = 0;
					for (const c of content) {
						if (c.type === "library_item" || c.folder_id) {
							const libId = c.id || c.folder_id;
							if (libId) libIds.push(libId);
						} else {
							legacyCount++;
						}
					}
					setSelectedContentIds(libIds);
					setFiles([]);
					setPreservedCount(legacyCount);
					setContentTab(libIds.length > 0 ? "library" : "upload");

					// Snapshot the original content list and per-item settings so a
					// later save can rebuild the original order and preserve each
					// item's own settings (heterogeneous planners are never flattened).
					setOriginalContent(Array.isArray(content) ? content : []);
					const settingsMap: Record<string, ContentEntry> = {};
					for (const c of content) {
						const key = c.id || c.folder_id || null;
						if (!key) continue;
						settingsMap[key] = {
							media_type: c.media_type,
							share_to_feed: c.share_to_feed,
							caption: c.caption,
							caption_fallback: c.caption_fallback,
							title_fallback: c.title_fallback,
							location_id: c.location_id,
							collaborators: c.collaborators,
							user_tags: c.user_tags,
							audio_configuration: c.audio_configuration,
						};
					}
					setOriginalItemSettings(settingsMap);
					setSettingsTouched(false);

					const firstItem = content[0];
					if (firstItem?.media_type === "CAROUSEL") {
						setIsCarousel(true);
						setMediaType("CAROUSEL");
						setShareToFeed(true);
					} else {
						setIsCarousel(false);
						setMediaType(
							(firstItem?.media_type as "REELS" | "STORIES" | "IMAGE" | "CAROUSEL") ||
								"REELS",
						);
						setShareToFeed(firstItem?.share_to_feed !== false);
					}
					setCaption((firstItem?.caption as string | undefined) || "");
					setCaptionFallback(
						(firstItem?.caption_fallback as string | undefined) || "",
					);
					setTitleFallback((firstItem?.title_fallback as string | undefined) || "");
					setLocation((firstItem?.location_id as string | undefined) || "");
					// Caption templates (one per line) + rotation mode
					setCaptionTemplates(
						Array.isArray(config.caption_templates)
							? config.caption_templates.join("\n")
							: "",
					);
					setCaptionRotation(
						config.caption_rotation === "sequential" ||
							config.caption_rotation === "random"
							? config.caption_rotation
							: "off",
					);
					// collaborators/user_tags may be stored as arrays (comma input => array of usernames)
					const storedCollabs = firstItem?.collaborators;
					setCollaborators(
						Array.isArray(storedCollabs)
							? (storedCollabs as string[]).join(", ")
							: String(storedCollabs || ""),
					);
					const storedTags = firstItem?.user_tags;
					setUserTags(
						Array.isArray(storedTags)
							? (storedTags as string[]).join(", ")
							: String(storedTags || ""),
					);
					const audioConfig = (firstItem?.audio_configuration || {}) as {
						audio_id?: string;
						audio_volume?: number;
						video_volume?: number;
					};
					setAudioId(audioConfig.audio_id || "");
					setAudioVolume(
						audioConfig.audio_volume !== undefined ? audioConfig.audio_volume : 80,
					);
					setVideoVolume(
						audioConfig.video_volume !== undefined ? audioConfig.video_volume : 20,
					);
					// YouTube fields do config (planner YT)
					setYoutubeTitle(typeof config.youtube_title === "string" ? String(config.youtube_title) : typeof config.youtube_title === "number" ? String(config.youtube_title) : "");
					setYoutubeDescription(typeof config.youtube_description === "string" ? String(config.youtube_description) : "");
					loadYoutubeProductsFromConfig(config.youtube_products);
					setYoutubePrivacy(["PUBLIC","PRIVATE","UNLISTED"].includes(String(config.youtube_privacy || "").toUpperCase()) ? String(config.youtube_privacy).toUpperCase() as "PUBLIC"|"PRIVATE"|"UNLISTED" : "PUBLIC");
					setYoutubeMadeForKids(Boolean(config.youtube_made_for_kids === true || String(config.youtube_made_for_kids).toLowerCase() === "true" || config.youtube_made_for_kids === 1));
					setYoutubeMonetizeWithAds(Boolean(config.youtube_monetize_with_ads === true || String(config.youtube_monetize_with_ads).toLowerCase() === "true" || config.youtube_monetize_with_ads === 1));
					setYoutubeCategoryId(config.youtube_category_id !== undefined && config.youtube_category_id !== null && config.youtube_category_id !== "" ? String(config.youtube_category_id) : "");
					setYoutubePinnedComment(typeof config.youtube_pinned_comment === "string" ? String(config.youtube_pinned_comment) : typeof config.youtube_pinned_comment_text === "string" ? String(config.youtube_pinned_comment_text) : "");
				} else {
					setSelectedContentIds([]);
					setFiles([]);
					setPreservedCount(0);
					setOriginalContent([]);
					setOriginalItemSettings({});
					setSettingsTouched(false);
					setContentTab("upload");
					setIsCarousel(false);
					setMediaType("REELS");
					setShareToFeed(true);
					setCaption("");
					setCaptionTemplates("");
					setCaptionRotation("off");
					setLocation("");
					setCollaborators("");
					setUserTags("");
					setAudioId("");
					setAudioVolume(80);
					setVideoVolume(20);
					setYoutubeTitle("");
					setYoutubeDescription("");
					setYoutubeProductDrafts([]);
					setYoutubePrivacy("PUBLIC");
					setYoutubeMadeForKids(false);
					setYoutubeMonetizeWithAds(false);
					setYoutubeCategoryId("");
					setYoutubePinnedComment("");
				}
			} else {
				// Full reset for new planner
				setName("");
				setSelectedChannels([]);
				setSelectedContentIds([]);
				setFiles([]);
				setPreservedCount(0);
				setOriginalContent([]);
				setOriginalItemSettings({});
				setSettingsTouched(false);
				setYoutubeTitle("");
				setYoutubeDescription("");
				setYoutubeProductDrafts([]);
				setYoutubePrivacy("PUBLIC");
				setYoutubeMadeForKids(false);
				setYoutubeMonetizeWithAds(false);
				setYoutubeCategoryId("");
				setYoutubePinnedComment("");
				setFrequencyValue(1);
				setFrequencyUnit("hours");
				setTimezone("America/Sao_Paulo");
				setStartTime("");
				setSleepEnabled(false);
				setSleepStart("00:00");
				setSleepEnd("06:00");
				setSortOrder("random_loop");
				setCaption("");
				setCaptionTemplates("");
				setCaptionRotation("off");
				setIsCarousel(false);
				setMediaType("REELS");
				setShareToFeed(true);
				setLocation("");
				setCollaborators("");
				setUserTags("");
				setAudioId("");
				setAudioVolume(80);
				setVideoVolume(20);
				setContentTab("upload");
			}
		}
	}, [isOpen, initialData]);

	// When files change, auto-detect media type if simple
	useEffect(() => {
		if (files.length > 0) {
			const hasVideo = files.some((f) => f.type.startsWith("video/"));
			const hasImage = files.some((f) => f.type.startsWith("image/"));

			if (hasVideo && !hasImage) setMediaType("REELS");
			else if (!hasVideo && hasImage) setMediaType("IMAGE");

			if (files.length > 1) {
				// Propose Carousel if multiple images, but user must confirm
			}
		}
	}, [files]);

	async function fetchChannels() {
		try {
			const res = await fetch("/api/channels");
			if (!res.ok) throw new Error("Failed to load channels");
			const data = await res.json();
			setChannels(
				Array.isArray(data)
					? data.filter(
							(c: Channel) =>
								(c.platform ?? "") !== "" &&
								["instagram", "youtube"].includes(c.platform as string) &&
								c.status === "active",
						)
					: [],
			);
		} catch (err) {
			console.error("Failed to fetch channels:", err);
			setChannels([]);
			setFormError(
				"Não foi possível carregar os canais. Verifique sua conexão e tente novamente.",
			);
		}
	}

	const handleNext = () => {
		if (step < STEPS.length - 1) setStep(step + 1);
	};

	const handleBack = () => {
		if (step > 0) setStep(step - 1);
	};

	const toggleChannel = (id: string) => {
		if (selectedChannels.includes(id)) {
			setSelectedChannels(selectedChannels.filter((c) => c !== id));
		} else {
			setSelectedChannels([...selectedChannels, id]);
		}
	};

	// Upload direct files through the global upload queue (chunked, resumable,
	// with automatic thumbnail extraction). Returns the same shape the planner
	// config expects ({ url, type, thumbnail_url }).
	const uploadFiles = async (): Promise<
		{ url: string; type: string; thumbnail_url?: string | null }[]
	> => {
		if (files.length === 0) return [];

		const results = await uploadAndWait(files, {});
		const uploadedItems: {
			url: string;
			type: string;
			thumbnail_url?: string | null;
		}[] = [];

		for (const result of results) {
			if (result.error || !result.item?.url) {
				console.error(
					`Upload failed for ${result.name}:`,
					result.error || "no url returned",
				);
				continue;
			}
			const item = result.item;
			uploadedItems.push({
				url: item.url as string,
				type:
					item.type ||
					(/\\.(mp4|mov|mkv|webm|m4v)(\?.*)?$/i.test(item.url || "")
						? "video"
						: "image"),
				thumbnail_url: item.thumbnail_url || null,
			});
		}
		return uploadedItems;
	};

	// ── Produtos afiliados (B1): lista dinâmica + busca live debounce ────────

	const updateYoutubeProductDraft = (key: string, patch: Partial<YoutubeProductDraft>) => {
		setYoutubeProductDrafts((prev) =>
			prev.map((d) => (d.key === key ? { ...d, ...patch } : d)),
		);
	};

	const addYoutubeProduct = () => {
		const key = `yp-${youtubeProductKeyRef.current++}`;
		setYoutubeProductDrafts((prev) => [
			...prev,
			{ key, query: "", status: "idle", results: [], error: undefined },
		]);
	};

	const removeYoutubeProduct = (key: string) => {
		const timer = youtubeProductTimersRef.current[key];
		if (timer) window.clearTimeout(timer);
		delete youtubeProductTimersRef.current[key];
		setYoutubeProductDrafts((prev) => prev.filter((d) => d.key !== key));
	};

	/** Busca live no catálogo do canal. O videoId NÃO é derivado de título/item
	 *  (isso fabricava um id falso — B3/F3): a rota /api/youtube/products
	 *  resolve sozinha o último Short publicado do canal quando videoId vem
	 *  vazio. Se a rota responde 400 (canal sem nenhum vídeo publicado),
	 *  mensagem amigável e a entrada continua como nome p/ auto-select na
	 *  publicação. */
	const searchYoutubeProduct = async (key: string, rawQuery: string) => {
		const query = rawQuery.trim();
		if (!query) {
			updateYoutubeProductDraft(key, { status: "idle", results: [], error: undefined });
			return;
		}
		if (!onlyYoutubeSelected || selectedChannels.length === 0) {
			updateYoutubeProductDraft(key, {
				status: "error",
				error: "Selecione um canal YouTube primeiro.",
			});
			return;
		}
		updateYoutubeProductDraft(key, { status: "searching", error: undefined });
		try {
			const params = new URLSearchParams({
				channelId: selectedChannels[0],
				query,
				suggestions: "false",
				limit: "20",
			});
			const res = await fetch(`/api/youtube/products?${params.toString()}`);
			let data: Record<string, unknown> | null = null;
			const ct = res.headers.get("content-type") || "";
			if (ct.includes("application/json")) {
				data = (await res.json()) as Record<string, unknown>;
			} else {
				const text = await res.text();
				if (
					text.trim().startsWith("<!DOCTYPE") ||
					text.trim().startsWith("<html")
				) {
					throw new Error(
						res.status === 401
							? "Sessão expirada — faça login novamente."
							: `Erro ${res.status}: resposta não-JSON do servidor. Verifique se o canal YouTube está conectado.`,
					);
				}
				try {
					data = JSON.parse(text) as Record<string, unknown>;
				} catch {
					throw new Error(text.slice(0, 200) || `Erro ${res.status}`);
				}
			}
			if (!res.ok) {
				// B3/F3: rota responde 400 só quando o canal não tem NENHUM Short
				// publicado (sem videoId explícito e sem fallback). Deixa a entrada
				// como NOME p/ auto-select na publicação (POST /api/shorts/auto
				// busca no momento da publicação, com o vídeo real).
				if (res.status === 400) {
					// guard anti-race (mesma convenção do path de sucesso): só aplica
					// se o input ainda é o query que disparou esta busca.
					setYoutubeProductDrafts((prev) =>
						prev.map((d) =>
							d.key === key && d.query.trim() === query
								? {
										...d,
										status: "name" as const,
										error:
											"Nenhum vídeo publicado ainda — publique um Short primeiro para buscar o catálogo. Você ainda pode deixar só o nome: a publicação auto-seleciona o melhor produto.",
										results: [],
								  }
								: d,
						),
					);
					return;
				}
				updateYoutubeProductDraft(key, {
					status: "error",
					error: (data?.error as string) || `Falha ao buscar produtos (${res.status})`,
					results: [],
				});
				return;
			}
			const products: YoutubeProductSearchResult[] =
				data && typeof data === "object" && Array.isArray(data.products)
					? ((data.products as unknown[]) as YoutubeProductSearchResult[])
					: [];
			// guard anti-race: só aplica resultado se o query ainda é o atual
			setYoutubeProductDrafts((prev) =>
					prev.map((d) =>
					d.key === key && d.query.trim() === query
						? {
								...d,
								status: "name",
								results: products,
								error:
									products.length > 0
										? undefined
										: "Nenhum produto encontrado para este termo.",
						  }
						: d,
				),
			);
		} catch (e) {
			updateYoutubeProductDraft(key, {
				status: "error",
				error: e instanceof Error ? e.message : String(e),
			});
		} finally {
			// status "searching" → "name"/"error" acima; aqui limpa o timer ref
			delete youtubeProductTimersRef.current[key];
		}
	};

	/** Input de nome com busca live (debounce ~600ms). Digitar limpa o item fixo. */
	const handleYoutubeProductQueryChange = (key: string, value: string) => {
		const trimmed = value.trim();
		updateYoutubeProductDraft(key, {
			query: value,
			item: undefined,
			title: undefined,
			vendor: undefined,
			price: undefined,
			commissionPct: undefined,
			status: trimmed ? "searching" : "idle",
			error: undefined,
		});
		const existing = youtubeProductTimersRef.current[key];
		if (existing) window.clearTimeout(existing);
		youtubeProductTimersRef.current[key] = window.setTimeout(() => {
			void searchYoutubeProduct(key, value);
		}, 600);
	};

	/** Clicou num resultado: fixa o item verbatim (status selected). */
	const selectYoutubeProduct = (key: string, product: YoutubeProductSearchResult) => {
		updateYoutubeProductDraft(key, {
			status: "selected",
			item: product.item,
			title: typeof product.title === "string" ? product.title : undefined,
			vendor: typeof product.vendor === "string" ? product.vendor : undefined,
			price: typeof product.price === "string" ? product.price : undefined,
			commissionPct:
				typeof product.commission_pct === "number"
					? product.commission_pct
					: undefined,
			results: [],
			error: undefined,
		});
	};

	/** Desfaz a fixação (volta a nome-only — auto-select na publicação). */
	const unselectYoutubeProduct = (key: string) => {
		updateYoutubeProductDraft(key, {
			status: "name",
			item: undefined,
			title: undefined,
			vendor: undefined,
			price: undefined,
			commissionPct: undefined,
			results: [],
			error: undefined,
		});
	};

	/** Load (edição): aceita {query,item?} array, array de strings e CSV legacy. */
	const loadYoutubeProductsFromConfig = (raw: unknown) => {
		const entries = normalizeYoutubeProductsList(raw);
		if (!entries) {
			setYoutubeProductDrafts([]);
			return;
		}
		setYoutubeProductDrafts(
			entries.map((e) => ({
				key: `yp-${youtubeProductKeyRef.current++}`,
				query: e.query,
				status: e.item !== undefined ? "selected" : "name",
				...(e.item !== undefined ? { item: e.item } : {}),
				...(e.title !== undefined ? { title: e.title } : {}),
				...(e.vendor !== undefined ? { vendor: e.vendor } : {}),
				...(e.price !== undefined ? { price: e.price } : {}),
				...(e.commission_pct !== undefined
					? { commissionPct: e.commission_pct }
					: {}),
				results: [],
				error: undefined,
			})),
		);
	};

	// limpa timers de busca ao desmontar
	useEffect(() => {
		return () => {
			for (const t of Object.values(youtubeProductTimersRef.current)) {
				window.clearTimeout(t);
			}
		};
	}, []);

	/**
	 * O item de biblioteca tem nome/título que o buildPostData usaria como
	 * fallback de título do Short (cadeia: título do item → title_fallback →
	 * caption → nome do arquivo)? Consulta a biblioteca do usuário (mesma
	 * fonte do runtime) e responde se TODOS os itens selecionados têm um.
	 * Em falha de rede responde `false` — conservador: bloqueia o save em vez
	 * de arriscar um Short sem título na publicação.
	 */
	const selectedLibraryItemsHaveTitles = async (): Promise<boolean> => {
		if (selectedContentIds.length === 0) return false;
		try {
			const params = new URLSearchParams({ limit: "500" });
			const res = await fetch(`/api/content-items?${params.toString()}`);
			if (!res.ok) return false;
			const payload = await res.json();
			const items: { id?: string; name?: string | null; title?: string | null }[] =
				Array.isArray(payload) ? payload : payload.items || [];
			const hasTitle = new Map<string, boolean>();
			for (const it of items) {
				hasTitle.set(
					String(it.id || ""),
					Boolean(String(it.name || "").trim() || String(it.title || "").trim()),
				);
			}
			return selectedContentIds.every((id) => hasTitle.get(String(id)));
		} catch {
			return false;
		}
	};

	const handleSubmit = async () => {
		if (loading) return;
		// BK-05: debounce 800ms (duplo clique)
		const nowMs = Date.now();
		if (nowMs - lastPlannerSubmitRef.current < 800) return;
		lastPlannerSubmitRef.current = nowMs;
		if (!plannerIdempotencyRef.current)
			plannerIdempotencyRef.current =
				typeof crypto !== "undefined" && "randomUUID" in crypto
					? crypto.randomUUID()
					: String(Date.now()) + Math.random();
		setFormError("");

		// Validate sleep schedule: a zero-length window silently disables the timer.
		if (sleepEnabled && sleepStart === sleepEnd) {
			setFormError("O início e o fim do descanso devem ser horários diferentes.");
			return;
		}

		// Validate frequency: NaN/0/negative would spam or silently kill the planner.
		const freqValue =
			Number.isFinite(frequencyValue) && frequencyValue >= 1 ? frequencyValue : 10;

		// Short do YouTube exige título: com planner só-YouTube e mídia em vídeo,
		// exige que a legenda resolvida tenha texto (ou Título reserva). Usa o
		// valor RESOLVIDO (após templates) — uma caption exclusivamente-template
		// (ex.: "{post_caption}" de item de biblioteca sem caption) resolve vazia
		// na publicação e o Short falharia permanentemente no publisher.
		// Alinhado à cadeia de 4 fallbacks do buildPostData (título do item de
		// biblioteca → title_fallback → caption → nome do arquivo): só bloqueia
		// quando NENHUM item selecionado pode suprir título — o wizard não
		// conhece o nome/título do item de biblioteca, então consulta a
		// biblioteca como o runtime faz (ex.: caption "{post_title}" com item
		// cujo ContentItem.title está preenchido publica bem via runtime).
		// M23/W2: youtube_title (campo VISÍVEL do box YT) supre o título — o
		// runtime usa rawYtTitle como 1ª fonte (planner-runtime.ts:452-474); com
		// título preenchido o upload direto não depende de caption oculta.
		if (
			youtubeSelected &&
			!isCarousel &&
			mediaType === "REELS" &&
			!youtubeTitle.trim() &&
			!resolveCaptionTextForWizard({
				caption,
				captionTemplates,
				captionRotation,
				captionFallback,
				titleFallback,
			}).trim() &&
			!titleFallback.trim()
		) {
			const libraryTitlesAvailable = await selectedLibraryItemsHaveTitles();
			if (!libraryTitlesAvailable) {
				setFormError(
					"Shorts do YouTube exigem um título — preencha o campo \"Título\" em Configurações YouTube, ou informe uma legenda com texto literal.",
				);
				return;
			}
		}

		// Post na Comunidade exige texto: sem isso o publisher falharia
		// permanentemente (mesma validação do servidor, aplicada cedo aqui). O
		// texto precisa existir na legenda RESOLVIDA: captionFallback só ajuda
		// quando referenciada via {post_caption} — caption vazia com fallback
		// preenchido ainda resolveria vazio na publicação. M7/P0-B0: no planner
		// só-YouTube o campo VISÍVEL é "Texto da Publicação" (grava no MESMO
		// content[].caption); a mensagem aponta para ele em vez de citar campos
		// IG ocultos (isolamento b3d5d56).
		if (
			youtubeSelected &&
			(isCarousel || mediaType === "IMAGE") &&
			!resolveCaptionTextForWizard({
				caption,
				captionTemplates,
				captionRotation,
				captionFallback,
				titleFallback,
			}).trim()
		) {
			setFormError(
				onlyYoutubeSelected
					? "Posts na Comunidade do YouTube exigem texto — preencha o campo \"Texto da Publicação\" em Configurações YouTube."
					: "Posts na Comunidade do YouTube exigem um texto — informe uma legenda com texto literal, a Legenda reserva (via {post_caption}), ou um template com conteúdo fixo.",
			);
			return;
		}

		// Carousel posts are built from FOLDERS only (the cron resolves each
		// folder's children). Reject non-folder selections early with a clear error.
		if (isCarousel && selectedContentIds.length > 0) {
			try {
				const params = new URLSearchParams({
					types: "carousel_folder",
					limit: "500",
				});
				const res = await fetch(`/api/content-items?${params.toString()}`);
				if (res.ok) {
					const payload = await res.json();
					const folders = Array.isArray(payload) ? payload : payload.items || [];
					const folderIds = new Set(
						folders.map((f: { id?: string }) => f?.id).filter(Boolean),
					);
					const invalid = selectedContentIds.filter((id) => !folderIds.has(id));
					if (invalid.length > 0) {
						setFormError(
							`Carrossel exige pastas — ${invalid.length} item(ns) selecionado(s) não são pastas. Remova-os e tente novamente.`,
						);
						return;
					}
				}
			} catch {
				/* best-effort: the server still validates */
			}
		}

		setLoading(true);
		setUploading(true);
		try {
			if (!session?.user) throw new Error("Not authenticated");

			// 1. Upload New Files
			const uploadedItems = await uploadFiles();

			// Comma-separated usernames => array of username strings (the cron
			// converts this to the Instagram Graph API object format).
			const collaboratorsList = collaborators
				? collaborators
						.split(",")
						.map((s) => s.trim())
						.filter(Boolean)
				: null;
			const userTagsList = userTags
				? userTags
						.split(",")
						.map((s) => s.trim())
						.filter(Boolean)
				: null;

			// Post settings to apply. When the user has NOT touched any setting,
			// existing items keep their OWN original settings (heterogeneous
			// planners are preserved, not flattened). New items always get the
			// current UI settings.
			const globalSettings = {
				media_type: isCarousel ? "CAROUSEL" : mediaType,
				share_to_feed: shareToFeed,
				caption,
				caption_fallback: captionFallback,
				title_fallback: titleFallback,
				location_id: location,
				collaborators: collaboratorsList,
				user_tags: mediaType === "IMAGE" || isCarousel ? userTagsList : null,
				audio_configuration:
					mediaType === "REELS" && audioId
						? {
								audio_id: audioId,
								audio_volume: audioVolume,
								video_volume: videoVolume,
							}
						: null,
			};

			// 2. Build the UI-generated content entries
			let generated: ContentEntry[] = [];

			// Itens PRESERVADOS podem conter media_type "STORIES" gravado antes de
			// o planner ter canal YouTube — o auto-fix do seletor (useEffect
			// STORIES→REELS) não alcança os itens preservados quando
			// settingsTouched=false (eles seriam gravados com a config original e
			// o runtime classificaria o post YT como Short sem vídeo → falha
			// definitiva no publisher). Normaliza aqui no save, espelhando o
			// auto-fix: STORIES → REELS (nunca publica Story em canal YT).
			const normalizePreservedMediaType = (
				v: string | undefined,
			): string | undefined => {
				if (!youtubeSelected) return v;
				return v === "STORIES" ? "REELS" : v;
			};

			if (isCarousel && selectedContentIds.length > 0) {
				// Carousel from folders: each folder becomes its own carousel post
				for (const folderId of selectedContentIds) {
					const orig = originalItemSettings[folderId];
					generated.push(
						orig && !settingsTouched
							? {
									type: "library_item",
									id: folderId,
									...orig,
									media_type: normalizePreservedMediaType(orig.media_type),
								}
							: { type: "library_item", id: folderId, ...globalSettings },
					);
				}
				// If we also have direct uploads that form a carousel
				if (uploadedItems.length >= 2) {
					generated.push({
						type: "config",
						children_urls: uploadedItems,
						...globalSettings,
						media_type: "CAROUSEL",
					});
				}
			} else if (isCarousel && uploadedItems.length >= 2) {
				// Carousel from direct uploads
				generated = [
					{
						type: "config",
						children_urls: uploadedItems,
						...globalSettings,
						media_type: "CAROUSEL",
					},
				];
			} else {
				// Separate Posts (Reels, Images, etc)
				generated = [
					...uploadedItems.map((item) => ({ ...item, ...globalSettings })),
					...selectedContentIds.map((id) => {
						const orig = originalItemSettings[id];
						return orig && !settingsTouched
							? {
									type: "library_item",
									id,
									...orig,
									media_type: normalizePreservedMediaType(orig.media_type),
								}
							: { type: "library_item", id, ...globalSettings };
					}),
				];
			}

			// 3. When editing, rebuild the ORIGINAL order — replacing the items the
			// UI represents with the generated entries, keeping legacy entries
			// (type:'config' uploads) exactly where they were, and appending any
			// genuinely new entries at the end. Deselected items are dropped.
			let content: ContentEntry[];
			const plannerId = initialData?.id;
			if (plannerId && originalContent.length > 0) {
				const used = new Set<number>();
				const merged: ContentEntry[] = [];
				for (const orig of originalContent) {
					const key = orig.id || orig.folder_id || null;
					if (!key || (orig.type !== "library_item" && !orig.folder_id)) {
						// Legacy upload/config entry: preserve exactly as-is.
						merged.push(orig);
						continue;
					}
					const idx = generated.findIndex(
						(e, i) => !used.has(i) && (e.id || e.folder_id) === key,
					);
					if (idx >= 0) {
						merged.push(generated[idx]);
						used.add(idx);
					}
					// else: item deselected during this edit — dropped on purpose.
				}
				generated.forEach((e, i) => {
					if (!used.has(i)) merged.push(e);
				});
				content = merged;
			} else {
				content = generated;
			}

			// 4. Content identity (WHICH items, ignoring settings) compared as an
			// ORDERED MULTISET — reordering existing items or editing a caption
			// alone does NOT reset publish state; only adding/removing items does.
			const identity = (list: ContentEntry[]) =>
				list
					.map((c) => {
						if (c.type === "library_item") return `lib:${c.id}`;
						if (c.folder_id) return `lib:${c.folder_id}`;
						if (c.url) return `url:${c.url}`;
						if (c.children_urls)
							return `carousel:${c.children_urls.map((u) => u.url || u.id).join("|")}`;
						return JSON.stringify(c);
					})
					.sort()
					.join("|");
			const contentChanged = plannerId
				? identity(content) !== identity(originalContent)
				: content.length > 0;

			// 5. Prepare Config in JSON. NOTE: publish state now lives in its own
			// column (Planner.state) — it is NEVER sent from the client. The
			// reset_state flag below tells the server to clear it only when the
			// item composition really changed.
			// YouTube fields: produtos afiliados serializados via helper único
			// (formato canônico Array<{query,item?}> — B1; nunca CSV).
			const productEntries: YoutubeProductEntry[] = youtubeProductDrafts
				.filter((d) => d.query.trim() || d.item !== undefined)
				.map((d) => ({
					query: d.query.trim() || String(d.title || "").trim(),
					...(d.item !== undefined ? { item: d.item } : {}),
					...(d.title !== undefined ? { title: d.title } : {}),
					...(d.vendor !== undefined ? { vendor: d.vendor } : {}),
					...(d.price !== undefined ? { price: d.price } : {}),
					...(d.commissionPct !== undefined
						? { commission_pct: d.commissionPct }
						: {}),
				}));
			const serializedProducts = serializeYoutubeProducts(productEntries);
			const ytFields: Record<string, unknown> = {};
			if (onlyYoutubeSelected) {
				if (youtubeTitle.trim()) ytFields.youtube_title = youtubeTitle.trim().slice(0, 100);
				if (youtubeDescription.trim() || youtubeDescription === "") {
					// só envia se preenchido ou se usuário limpou explicitamente (permite vazio)
					if (youtubeDescription) ytFields.youtube_description = youtubeDescription.slice(0, 5000);
				}
				if (serializedProducts && serializedProducts.length)
					ytFields.youtube_products = serializedProducts;
				if (youtubePrivacy) ytFields.youtube_privacy = youtubePrivacy;
				if (youtubeMadeForKids) ytFields.youtube_made_for_kids = true;
				else ytFields.youtube_made_for_kids = false;
				if (youtubeMonetizeWithAds) ytFields.youtube_monetize_with_ads = true;
				else ytFields.youtube_monetize_with_ads = false;
				if (youtubeCategoryId.trim()) ytFields.youtube_category_id = Number(youtubeCategoryId);
				if (youtubePinnedComment.trim()) {
					ytFields.youtube_pinned_comment = youtubePinnedComment.trim().slice(0, 10000);
					ytFields.youtube_pinned_comment_text = youtubePinnedComment.trim().slice(0, 10000);
				}
			}
			const plannerConfig = {
				frequency: {
					value: freqValue,
					unit: frequencyUnit,
				},
				timezone,
				// Convert local datetime string to an absolute ISO timestamp so the
				// server (UTC) interprets the user's local wall-clock correctly.
				start_time: startTime ? new Date(startTime).toISOString() : "",
				sleep_schedule: sleepEnabled ? { start: sleepStart, end: sleepEnd } : null,
				sort_order: sortOrder,
				caption_templates: captionTemplates
					.split("\n")
					.map((s) => s.trim())
					.filter(Boolean),
				caption_rotation: captionRotation,
				...ytFields,
				content,
			};

			// Isolation: bloquear submit misto no client (defesa além do server 400)
			if (hasMixSelected) {
				setFormError(PLANNER_MIX_ERROR);
				setLoading(false);
				setUploading(false);
				return;
			}
			// 6. Update or Insert Planner
			const res = await fetch(
				plannerId ? `/api/planners/${plannerId}` : "/api/planners",
				{
					method: plannerId ? "PATCH" : "POST",
					headers: {
						"Content-Type": "application/json",
						"x-idempotency-key": plannerIdempotencyRef.current || "",
					},
					body: JSON.stringify({
						name,
						channel_ids: selectedChannels,
						config: plannerConfig,
						...(plannerId ? { reset_state: contentChanged } : { status: "active" }),
						_idempotencyKey: plannerIdempotencyRef.current,
					}),
				},
			);

			if (!res.ok) {
				let message = "Failed to save planner";
				try {
					const errBody = await res.json();
					if (errBody?.error) message = errBody.error;
				} catch {
					/* keep default */
				}
				throw new Error(message);
			}

			plannerIdempotencyRef.current = null;
			onSuccess();
			onClose();
		} catch (error) {
			console.error(error);
			setFormError(
				error instanceof Error ? error.message : "Failed to save planner",
			);
		} finally {
			setLoading(false);
			setUploading(false);
		}
	};

	useEffect(() => {
		if (!isOpen) return;
		const h = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		document.addEventListener("keydown", h);
		return () => document.removeEventListener("keydown", h);
	}, [isOpen, onClose]);

	if (!isOpen) return null;

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
			role="presentation"
			onClick={onClose}
		>
			<div
				role="dialog"
				aria-modal="true"
				aria-labelledby="planner-wizard-title"
				tabIndex={-1}
				onClick={(e) => e.stopPropagation()}
				className="bg-ios-card w-full max-w-2xl rounded-2xl overflow-hidden shadow-2xl flex flex-col max-h-[85dvh]"
			>
				{/* Header */}
				<div className="px-6 py-4 border-b border-ios-separator flex items-center justify-between bg-ios-background">
					<div>
						<div className="flex items-center gap-2">
							<h2
								id="planner-wizard-title"
								className="text-[17px] font-semibold text-ios-text"
							>
								{initialData?.id ? "Editar Planner" : "Novo Planner"}
							</h2>
							{selectedPlatformType === "youtube" && (
								<span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-500 text-white text-[10px] font-bold uppercase tracking-wide">
									<Youtube size={10} /> Planner YouTube
								</span>
							)}
							{selectedPlatformType === "instagram" && (
								<span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gradient-to-r from-purple-500 to-pink-500 text-white text-[10px] font-bold uppercase tracking-wide">
									<Instagram size={10} /> Planner Instagram
								</span>
							)}
							{hasMixSelected && (
								<span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500 text-white text-[10px] font-bold uppercase tracking-wide">
									Misto — bloqueado
								</span>
							)}
						</div>
						<div className="flex items-center gap-2 text-xs text-ios-secondary mt-1">
							{STEPS.map((s, idx) => (
								<div
									key={s.id}
									className={`flex items-center gap-1 ${step === idx ? "text-ios-blue font-bold" : ""}`}
								>
									<span
										className={`w-4 h-4 rounded-full flex items-center justify-center ${step === idx ? "bg-ios-blue text-white" : step > idx ? "bg-green-500 text-white" : "bg-gray-200 text-gray-500"}`}
									>
										{step > idx ? <Check size={10} /> : idx + 1}
									</span>
									{s.title}
								</div>
							))}
						</div>
					</div>
					<button
						onClick={onClose}
						className="p-1 rounded-full hover:bg-black/5 text-ios-secondary transition-colors"
					>
						<X size={20} />
					</button>
				</div>

				{/* Content */}
				<div className="flex-1 overflow-y-auto p-6 bg-ios-background/50">
					{/* Global error banner — visible on every step */}
					{formError && (
						<div className="mb-4 p-3 rounded-xl bg-ios-red/10 border border-ios-red/30 text-ios-red text-sm">
							{formError}
						</div>
					)}

					{/* Step 0: Basics */}
					{step === 0 && (
						<div className="space-y-4 animate-in fade-in slide-in-from-right-4 duration-300">
							<label className="block text-[13px] font-medium text-ios-secondary uppercase tracking-wide">
								Planner Name
							</label>
							<input
								type="text"
								autoFocus
								value={name}
								onChange={(e) => setName(e.target.value)}
								placeholder="My Awesome Scheduler"
								className="w-full bg-ios-card border border-ios-separator rounded-xl px-4 py-3 text-[17px] focus:outline-none focus:border-ios-blue focus:ring-1 focus:ring-ios-blue"
							/>
							<label className="block text-[13px] font-medium text-ios-secondary uppercase tracking-wide mt-4">
								Start When?
							</label>
							<input
								type="datetime-local"
								value={startTime}
								onChange={(e) => setStartTime(e.target.value)}
								className="w-full bg-ios-card border border-ios-separator rounded-xl px-4 py-3 text-[17px] focus:outline-none focus:border-ios-blue focus:ring-1 focus:ring-ios-blue"
							/>
						</div>
					)}

					{/* Step 1: Accounts */}
					{step === 1 && (
						<div className="space-y-4 animate-in fade-in slide-in-from-right-4 duration-300">
							<div className="grid grid-cols-1 gap-3">
								{channels.map((channel) => {
									const disabled = isChannelDisabled(channel);
									return (
									<div
										key={channel.id}
										onClick={() => {
											if (disabled) return;
											toggleChannel(channel.id);
										}}
										title={disabled ? PLANNER_MIX_ERROR : undefined}
										aria-disabled={disabled}
										className={`p-4 rounded-xl border flex items-center gap-4 transition-all ${
											disabled
												? "bg-gray-100 border-gray-200 opacity-50 cursor-not-allowed"
												: selectedChannels.includes(channel.id)
													? "bg-ios-blue/10 border-ios-blue cursor-pointer"
													: "bg-ios-card border-ios-separator hover:border-ios-blue/30 cursor-pointer"
										}`}
									>
										<div
											className={`w-6 h-6 rounded-full border flex items-center justify-center ${
												selectedChannels.includes(channel.id)
													? "bg-ios-blue border-ios-blue text-white"
													: "bg-transparent border-gray-300"
											}`}
										>
											{selectedChannels.includes(channel.id) && <Check size={14} />}
										</div>
										{channel.platform === "youtube" ? (
											<div className="w-10 h-10 rounded-full bg-ios-red/10 flex items-center justify-center">
												<Youtube size={20} className="text-ios-red" />
											</div>
										) : (
											<div className="w-10 h-10 rounded-full bg-gradient-to-tr from-yellow-400 via-red-500 to-purple-500 p-[2px]">
												<div className="w-full h-full rounded-full bg-white flex items-center justify-center">
													<Instagram size={20} className="text-black" />
												</div>
											</div>
										)}
										<div>
											<h4 className="font-semibold text-ios-text">{channel.name}</h4>
											<p className="text-xs text-ios-secondary font-mono">
												{channel.account_id}
											</p>
										</div>
									{disabled && (
											<div className="ml-auto text-[10px] text-amber-600 font-medium hidden sm:block">
												{PLANNER_MIX_ERROR}
											</div>
										)}
									</div>
								);
								})}
								{channels.length === 0 && (
									<div className="text-center py-10 text-ios-secondary">
										Nenhum canal conectado — adicione uma conta do Instagram ou YouTube em
										Canais.
									</div>
								)}
								{hasMixSelected && (
									<div className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-700 text-sm">
										{PLANNER_MIX_ERROR}
									</div>
								)}
								{selectedChannels.length > 0 && selectedPlatformType && (
									<div className="text-xs text-ios-secondary">
										Tipo detectado:{" "}
										<span className="font-semibold">
											{selectedPlatformType === "youtube" ? "YouTube" : "Instagram"}
										</span>{" "}
										— apenas canais desse tipo podem ser adicionados.
									</div>
								)}
							</div>
						</div>
					)}

					{/* Step 2: Content */}
					{step === 2 && (
						<div className="animate-in fade-in slide-in-from-right-4 duration-300 flex flex-col h-full space-y-4">
							{/* Tabs */}
							<div className="flex gap-2 p-1 bg-ios-separator/50 rounded-lg shrink-0">
								<button
									onClick={() => setContentTab("upload")}
									className={`flex-1 py-1.5 px-3 rounded-md text-sm font-medium transition-all ${
										contentTab === "upload"
											? "bg-white shadow-sm text-ios-text"
											: "text-ios-secondary hover:text-ios-text"
									}`}
								>
									Upload New
								</button>
								<button
									onClick={() => setContentTab("library")}
									className={`flex-1 py-1.5 px-3 rounded-md text-sm font-medium transition-all ${
										contentTab === "library"
											? "bg-white shadow-sm text-ios-text"
											: "text-ios-secondary hover:text-ios-text"
									}`}
								>
									From Library
								</button>
							</div>

							{/* Uploader / Library */}
							<div className="flex-1 overflow-hidden min-h-[300px]">
								{contentTab === "upload" ? (
									<MediaUploader files={files} onFilesChange={setFiles} />
								) : (
									<div className="h-full border border-ios-separator rounded-xl overflow-hidden min-h-[300px]">
										{isCarousel && (
											<div className="bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 text-xs p-2 border-b border-blue-100 dark:border-blue-900/30">
												📂 Select folders to post as carousels. Each folder becomes one
												carousel post.
											</div>
										)}
										{isCarousel && youtubeMode !== "none" && (
											<div className="bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300 text-xs p-2 border-b border-amber-100 dark:border-amber-900/30">
												⚠️ Pastas de carrossel com SÓ vídeos não podem ser publicadas na
												Comunidade do YouTube (ela não suporta vídeos) — o post falharia na
												publicação. Certifique-se de que cada pasta tenha ao menos uma
												imagem.
											</div>
										)}
										<ContentLibrary
											mode="select"
											initialSelection={selectedContentIds}
											onSelectionChange={setSelectedContentIds}
											allowedTypes={
												isCarousel
													? ["carousel_folder"]
													: ["video", "image", "carousel_folder"]
											}
											disableUrlNavigation={true}
										/>
									</div>
								)}
							</div>

							<p className="text-xs text-ios-secondary">
								{isCarousel
									? `${selectedContentIds.length} folder(s) selected for carousel.`
									: `${files.length} new files, ${selectedContentIds.length} library items selected.`}
								{preservedCount > 0 && (
									<span className="text-amber-600 dark:text-amber-400">
										{" "}
										· {preservedCount} legacy upload item(s) will be preserved on save.
									</span>
								)}
							</p>

							{/* Post Configuration */}
							<div className="bg-ios-card border border-ios-separator rounded-xl p-4 space-y-4 shadow-sm">
								<div className="flex items-center justify-between">
									<h3 className="text-[13px] font-bold text-ios-secondary uppercase tracking-wide">
										Post Configuration
									</h3>
									{files.length + selectedContentIds.length > 1 && (
										<div
											onClick={() => {
												const next = !isCarousel;
												setIsCarousel(next);
												setMediaType(next ? "CAROUSEL" : "REELS");
												setSettingsTouched(true);
											}}
											className="flex items-center gap-2 cursor-pointer"
										>
											<div
												className={`w-8 h-5 rounded-full relative transition-colors ${isCarousel ? "bg-ios-blue" : "bg-gray-300"}`}
											>
												<div
													className={`absolute top-1 w-3 h-3 bg-white rounded-full transition-transform ${isCarousel ? "translate-x-[14px]" : "translate-x-1"}`}
												/>
											</div>
											<span className="text-xs text-ios-text font-medium">
												Group as Carousel
											</span>
										</div>
									)}
								</div>

								<div className="grid grid-cols-2 gap-4">
									<div className={mediaType === "REELS" ? "" : "col-span-2"}>
										<label className="text-xs font-medium text-ios-text mb-1.5 block">
											Media Type
										</label>
										<select
											value={mediaType}
											onChange={(e) => {
												const v = e.target.value as typeof mediaType;
												setMediaType(v);
												setIsCarousel(v === "CAROUSEL");
												setSettingsTouched(true);
											}}
											className="w-full bg-ios-background border border-ios-separator rounded-lg px-2 py-2 text-sm focus:border-ios-blue outline-none"
										>
											<option value="REELS">
												{onlyYoutubeSelected ? "Short do YouTube" : "Reels"}
											</option>
											<option value="IMAGE">
												{onlyYoutubeSelected ? "Post na Comunidade" : "Post / Image"}
											</option>
											<option value="CAROUSEL">
												{onlyYoutubeSelected
													? "Carrossel · Post na Comunidade"
													: "Carousel"}
											</option>
											{!youtubeSelected && <option value="STORIES">Story</option>}
										</select>
									</div>
									{mediaType === "REELS" && !isCarousel && !onlyYoutubeSelected && (
										<div className="flex flex-col justify-center">
											<label className="text-xs font-medium text-ios-text mb-1.5 block">
												Options
											</label>
											<div
												onClick={() => {
													setShareToFeed(!shareToFeed);
													setSettingsTouched(true);
												}}
												className="flex items-center gap-2 cursor-pointer"
											>
												<div
													className={`w-4 h-4 border rounded flex items-center justify-center ${shareToFeed ? "bg-ios-blue border-ios-blue" : "border-gray-300"}`}
												>
													{shareToFeed && <Check size={10} className="text-white" />}
												</div>
												<span className="text-sm text-ios-text">Share to Feed</span>
											</div>
										</div>
									)}
								</div>

								{!onlyYoutubeSelected && (
								<div>
									<div className="flex justify-between items-center mb-1.5">
										<label className="text-xs font-medium text-ios-text block">
											Caption
										</label>
										<div className="flex gap-2">
											<button
												onClick={() => setCaption((prev) => prev + " {post_title}")}
												className="text-[10px] bg-ios-blue/10 text-ios-blue px-2 py-0.5 rounded-full hover:bg-ios-blue/20 transition-colors"
											>
												+ Title
											</button>
											<button
												onClick={() => setCaption((prev) => prev + " {post_caption}")}
												className="text-[10px] bg-ios-blue/10 text-ios-blue px-2 py-0.5 rounded-full hover:bg-ios-blue/20 transition-colors"
											>
												+ Caption
											</button>
										</div>
									</div>
									<textarea
										value={caption}
										onChange={(e) => {
											setCaption(e.target.value);
											setSettingsTouched(true);
										}}
										className="w-full bg-ios-background border border-ios-separator rounded-lg p-2 text-sm h-24 resize-none focus:border-ios-blue outline-none placeholder:text-gray-400 font-mono"
										placeholder="Write a caption... Use tags for dynamic content."
									/>
								</div>
								)}

								{!onlyYoutubeSelected && (
								<div className="space-y-3 pt-4 border-t border-ios-separator">
									<div className="flex items-center justify-between">
										<label className="text-xs font-medium text-ios-text block">
											Caption Templates
										</label>
										<select
											value={captionRotation}
											onChange={(e) =>
												setCaptionRotation(
													e.target.value as "off" | "sequential" | "random",
												)
											}
											className="bg-ios-background border border-ios-separator rounded-lg px-2 py-1 text-xs focus:border-ios-blue outline-none"
										>
											<option value="off">Rotation: Off</option>
											<option value="sequential">Rotation: Sequential</option>
											<option value="random">Rotation: Random</option>
										</select>
									</div>
									<textarea
										value={captionTemplates}
										onChange={(e) => {
											setCaptionTemplates(e.target.value);
											// Templates with rotation "off" are silently ignored by
											// the runtime (bug report: "templates don't work"). When
											// the user types a template, default the rotation to
											// sequential so it actually applies — they can still pick
											// random or off from the selector.
											if (e.target.value.trim() && captionRotation === "off") {
												setCaptionRotation("sequential");
											}
										}}
										className="w-full bg-ios-background border border-ios-separator rounded-lg p-2 text-sm h-20 resize-none focus:border-ios-blue outline-none placeholder:text-gray-400 font-mono"
										placeholder={"One template per line\nTemplate 1\nTemplate 2"}
									/>
									<div>
										<p className="text-[11px] text-gray-400 mb-1">Available variables:</p>
										<div className="flex flex-wrap gap-1">
											{[
												"{post_title}",
												"{post_caption}",
												"{date}",
												"{channel_name}",
												"{hashtags}",
											].map((v) => (
												<button
													key={v}
													onClick={() =>
														setCaptionTemplates(
															(prev) => prev + (prev && !prev.endsWith("\n") ? "\n" : "") + v,
														)
													}
													className="text-[10px] bg-ios-blue/10 text-ios-blue px-2 py-0.5 rounded-full hover:bg-ios-blue/20 transition-colors"
												>
													+ {v}
												</button>
											))}
										</div>
									</div>
									<p className="text-[11px] text-gray-400">
										When rotation is active, templates replace the caption above.{" "}
										{"{date}"} uses the post date; {"{hashtags}"} is empty unless the
										selected content has tags.
									</p>
								</div>
								)}

								{!onlyYoutubeSelected && (
								<div className="space-y-4 pt-4 border-t border-ios-separator">
									<div>
										<label className="text-xs font-medium text-ios-text mb-1.5 block">
											Fallback Title
										</label>
										<p className="text-[11px] text-gray-400 mb-2">
											Used if the selected content has an empty title and {"{post_title}"}{" "}
											is used.
										</p>
										<input
											value={titleFallback}
											onChange={(e) => {
												setTitleFallback(e.target.value);
												setSettingsTouched(true);
											}}
											className="w-full bg-ios-background border border-ios-separator rounded-lg p-2 text-sm focus:border-ios-blue outline-none placeholder:text-gray-400"
											placeholder="Example: AutoReels Magic"
										/>
									</div>
									<div>
										<label className="text-xs font-medium text-ios-text mb-1.5 block">
											Fallback Caption
										</label>
										<p className="text-[11px] text-gray-400 mb-2">
											Used if the selected content has an empty caption and{" "}
											{"{post_caption}"} is used.
										</p>
										<textarea
											value={captionFallback}
											onChange={(e) => {
												setCaptionFallback(e.target.value);
												setSettingsTouched(true);
											}}
											className="w-full bg-ios-background border border-ios-separator rounded-lg p-2 text-sm h-16 resize-none focus:border-ios-blue outline-none placeholder:text-gray-400"
											placeholder="Example: Check out this amazing content!"
										/>
									</div>
								</div>
								)}

								<div className="space-y-4">
									{!onlyYoutubeSelected && (
										<div>
											<label className="text-xs font-medium text-ios-text mb-1.5 block">
												Location ID (Optional)
											</label>
											<input
												value={location}
												onChange={(e) => {
													setLocation(e.target.value);
													setSettingsTouched(true);
												}}
												className="w-full bg-ios-background border border-ios-separator rounded-lg p-2 text-sm focus:border-ios-blue outline-none placeholder:text-gray-400"
												placeholder="Instagram Location ID"
											/>
										</div>
									)}

									{mediaType !== "STORIES" && !onlyYoutubeSelected && (
										<div>
											<label className="text-xs font-medium text-ios-text mb-1.5 block">
												Collaborators (Optional)
											</label>
											<input
												value={collaborators}
												onChange={(e) => {
													setCollaborators(e.target.value);
													setSettingsTouched(true);
												}}
												className="w-full bg-ios-background border border-ios-separator rounded-lg p-2 text-sm focus:border-ios-blue outline-none placeholder:text-gray-400"
												placeholder="e.g. user1, user2"
											/>
											<p className="text-[10px] text-gray-400 mt-1">
												Comma-separated Instagram usernames to invite as collaborators.
											</p>
										</div>
									)}

									{(mediaType === "IMAGE" || mediaType === "CAROUSEL") &&
										!onlyYoutubeSelected && (
											<div>
												<label className="text-xs font-medium text-ios-text mb-1.5 block">
													User Tags (Optional)
												</label>
												<input
													value={userTags}
													onChange={(e) => {
														setUserTags(e.target.value);
														setSettingsTouched(true);
													}}
													className="w-full bg-ios-background border border-ios-separator rounded-lg p-2 text-sm focus:border-ios-blue outline-none placeholder:text-gray-400"
													placeholder="e.g. user1, user2"
												/>
												<p className="text-[10px] text-gray-400 mt-1">
													Comma-separated Instagram usernames to tag on the image.
												</p>
											</div>
										)}

									{onlyYoutubeSelected &&
										(isCarousel || mediaType === "IMAGE") && (
											<div className="space-y-4 p-4 bg-red-50 dark:bg-red-900/10 rounded-xl border border-red-200 dark:border-red-900/30">
												<h4 className="text-xs font-bold text-ios-text uppercase tracking-wide flex items-center gap-2">
													<Youtube size={14} className="text-ios-red" />
													Configurações YouTube
												</h4>
												<div>
													<div className="flex justify-between items-center mb-1.5">
														<label className="text-xs font-medium text-ios-text block">
															Texto da Publicação <span className="text-ios-red">*</span>
														</label>
														<span className="text-[11px] text-gray-400">
															{caption.length}/5000
														</span>
													</div>
													<textarea
														value={caption}
														onChange={(e) => {
															setCaption(e.target.value.slice(0, 5000));
															setSettingsTouched(true);
														}}
														className="w-full bg-white dark:bg-ios-card border border-ios-separator rounded-lg p-2 text-sm h-28 resize-none focus:border-ios-blue outline-none"
														placeholder="Escreva o texto do post na Comunidade..."
														maxLength={5000}
													/>
													<p className="text-[10px] text-gray-400 mt-1">
														Este texto é a mensagem publicada na Comunidade do
														YouTube (a Comunidade não recebe produtos afiliados).
													</p>
												</div>
											</div>
										)}
										{onlyYoutubeSelected &&
											!isCarousel &&
											mediaType === "REELS" && (
												<div className="space-y-4 p-4 bg-red-50 dark:bg-red-900/10 rounded-xl border border-red-200 dark:border-red-900/30">
											<h4 className="text-xs font-bold text-ios-text uppercase tracking-wide flex items-center gap-2">
												<Youtube size={14} className="text-ios-red" />
												Configurações YouTube
											</h4>
											<div>
												<div className="flex justify-between items-center mb-1.5">
													<label className="text-xs font-medium text-ios-text block">Título <span className="text-ios-red">*</span></label>
													<span className="text-[11px] text-gray-400">{youtubeTitle.length}/100</span>
												</div>
												<input
													value={youtubeTitle}
													onChange={(e) => setYoutubeTitle(e.target.value.slice(0,100))}
													className="w-full bg-white dark:bg-ios-card border border-ios-separator rounded-lg p-2 text-sm focus:border-ios-blue outline-none"
													placeholder="Título do Short (máx 100 caracteres)"
													maxLength={100}
												/>
											</div>
											<div>
												<div className="flex justify-between items-center mb-1.5">
													<label className="text-xs font-medium text-ios-text block">Descrição</label>
													<span className="text-[11px] text-gray-400">{youtubeDescription.length}/5000</span>
												</div>
												<textarea
													value={youtubeDescription}
													onChange={(e) => setYoutubeDescription(e.target.value.slice(0,5000))}
													className="w-full bg-white dark:bg-ios-card border border-ios-separator rounded-lg p-2 text-sm h-24 resize-none focus:border-ios-blue outline-none"
													placeholder="Descrição do vídeo (máx 5000 caracteres). Suporta templates {post_title}, {post_caption}..."
													maxLength={5000}
												/>
											</div>
											<div>
												<label className="text-xs font-medium text-ios-text mb-1.5 block">Produtos Afiliados</label>
												<div className="flex justify-end mb-1.5">
													<button
														type="button"
														onClick={addYoutubeProduct}
														className="text-[11px] text-ios-blue font-medium hover:underline"
													>
														+ Adicionar Produto Afiliado
													</button>
												</div>
												{youtubeProductDrafts.length === 0 && (
													<p className="text-[10px] text-gray-400 mb-1">
														Nenhum produto. Adicione para buscar no catálogo do canal ou deixar
														só o nome (auto-seleção na publicação).
													</p>
												)}
												<div className="space-y-2">
													{youtubeProductDrafts.map((draft) => (
														<div
															key={draft.key}
														className="border border-ios-separator rounded-lg p-2 bg-white dark:bg-ios-card"
														>
															<div className="flex items-center gap-2">
																<input
																	value={draft.query}
																	onChange={(e) =>
																		handleYoutubeProductQueryChange(draft.key, e.target.value)
																	}
																	className="flex-1 bg-white dark:bg-ios-card border border-ios-separator rounded-lg p-2 text-sm focus:border-ios-blue outline-none"
																	placeholder="Nome do produto (ex.: smartwatch)"
																/>
																<button
																	type="button"
																	onClick={() => removeYoutubeProduct(draft.key)}
																	className="p-1.5 text-gray-400 hover:text-ios-red"
																	title="Remover produto"
																>
																	<X size={16} />
																</button>
															</div>
															{draft.status === "searching" && (
																<p className="text-[11px] text-gray-400 mt-1">Buscando...</p>
															)}
															{draft.status === "selected" && draft.item !== undefined && (
																<div className="mt-1.5 flex items-center gap-1.5 text-[11px]">
																	<Check size={13} className="text-green-600 shrink-0" />
																	<span className="text-green-700 dark:text-green-400 font-medium truncate">
																		{draft.title || "Produto selecionado"}
																	</span>
																	<span className="text-gray-400 whitespace-nowrap">
																		{draft.vendor || "?"}
																		{draft.price ? ` — ${draft.price}` : ""}
																		{draft.commissionPct != null ? ` · ${draft.commissionPct}%` : ""}
																	</span>
																	<button
																		type="button"
																		onClick={() => unselectYoutubeProduct(draft.key)}
																		className="text-ios-blue hover:underline"
																	>
																		trocar
																	</button>
																</div>
															)}
															{draft.status === "name" &&
																draft.results.length === 0 &&
																draft.error && (
																	<p className="text-[11px] text-amber-600 mt-1">{draft.error}</p>
																)}
															{draft.status === "error" && draft.error && (
																<p className="text-[11px] text-ios-red mt-1">{draft.error}</p>
															)}
															{(draft.status === "searching" || draft.status === "name") &&
																draft.results.length > 0 && (
																	<div className="mt-1.5 border border-ios-separator rounded-lg bg-white dark:bg-ios-card max-h-40 overflow-y-auto">
																		{draft.results.map((pr, idx) => {
																			const title =
																				String(pr.title || "Produto sem título");
																			const vendor = pr.vendor ? String(pr.vendor) : "";
																			const price = pr.price ? String(pr.price) : "";
																			const pct =
																				typeof pr.commission_pct === "number"
																					? pr.commission_pct
																					: null;
																			return (
																				<button
																					key={idx}
																					type="button"
																					onClick={() =>
																						selectYoutubeProduct(draft.key, pr)
																					}
																					className="w-full text-left px-2.5 py-1.5 hover:bg-ios-blue/10 border-b border-ios-separator last:border-0 flex items-start justify-between gap-2"
																				>
																					<span className="text-[11px] leading-tight">
																						<span className="font-medium">{title}</span>
																						{vendor && (
																							<span className="text-gray-400"> — {vendor}</span>
																						)}
																					</span>
																					<span className="text-[10px] text-gray-400 whitespace-nowrap">
																						{price || "—"}
																						{pct != null ? ` · ${pct}%` : ""}
																					</span>
																				</button>
																			);
																		})}
																	</div>
																)}
																{draft.status === "name" && draft.results.length > 0 && (
																	<p className="text-[10px] text-gray-400 mt-1">
																		Selecione um item acima para fixar (verbatim) ou deixe só o nome —
																		a publicação auto-seleciona o melhor produto.
																	</p>
																)}
																{draft.status === "idle" && (
																	<p className="text-[10px] text-gray-400 mt-1">
																		Digite um termo para buscar no catálogo do canal.
																	</p>
																)}
															</div>
															))}
												</div>
												<p className="text-[10px] text-gray-400 mt-1">
													Item fixado vai verbatim na tagagem (POST /api/shorts); só nome usa
													auto-select (POST /api/shorts/auto) — sem vírgulas na conta, sem JSON cru.
												</p>
											</div>
											<div className="grid grid-cols-2 gap-3">
												<div>
													<label className="text-xs font-medium text-ios-text mb-1.5 block">Privacidade</label>
													<select
														value={youtubePrivacy}
														onChange={(e) => setYoutubePrivacy(e.target.value as typeof youtubePrivacy)}
														className="w-full bg-white dark:bg-ios-card border border-ios-separator rounded-lg p-2 text-sm"
													>
														<option value="PUBLIC">Público</option>
														<option value="UNLISTED">Não listado</option>
														<option value="PRIVATE">Privado</option>
													</select>
												</div>
												<div>
													<label className="text-xs font-medium text-ios-text mb-1.5 block">Categoria ID</label>
													<input
														value={youtubeCategoryId}
														onChange={(e) => setYoutubeCategoryId(e.target.value.replace(/[^0-9]/g,""))}
														className="w-full bg-white dark:bg-ios-card border border-ios-separator rounded-lg p-2 text-sm"
														placeholder="22 (People & Blogs)"
													/>
												</div>
											</div>
											<div className="flex flex-col gap-2">
												<label className="flex items-center gap-2 cursor-pointer">
													<input type="checkbox" checked={youtubeMadeForKids} onChange={(e)=>setYoutubeMadeForKids(e.target.checked)} className="rounded" />
													<span className="text-xs font-medium">Feito para crianças</span>
												</label>
												<label className="flex items-center gap-2 cursor-pointer">
													<input type="checkbox" checked={youtubeMonetizeWithAds} onChange={(e)=>setYoutubeMonetizeWithAds(e.target.checked)} className="rounded" />
													<span className="text-xs font-medium">Monetizar com anúncios</span>
												</label>
											</div>
											<div>
												<label className="text-xs font-medium text-ios-text mb-1.5 block">Comentário fixado</label>
												<textarea
													value={youtubePinnedComment}
													onChange={(e)=>setYoutubePinnedComment(e.target.value.slice(0,10000))}
													className="w-full bg-white dark:bg-ios-card border border-ios-separator rounded-lg p-2 text-sm h-16 resize-none"
													placeholder="Texto do comentário fixado (opcional)"
													maxLength={10000}
												/>
											</div>
										</div>
									)}
									{mediaType === "REELS" && !onlyYoutubeSelected && (
										<div className="space-y-3 p-3 bg-ios-gray-6 rounded-xl border border-ios-separator">
											<span className="text-xs font-semibold text-ios-text block">
												Meta Audio Settings (Optional)
											</span>
											<div>
												<label className="text-[11px] font-medium text-ios-text mb-1 block">
													Audio ID
												</label>
												<input
													value={audioId}
													onChange={(e) => {
														setAudioId(e.target.value);
														setSettingsTouched(true);
													}}
													className="w-full bg-ios-background border border-ios-separator rounded-lg p-2 text-xs focus:border-ios-blue outline-none placeholder:text-gray-400"
													placeholder="Meta Audio Track ID"
												/>
											</div>
											{audioId && (
												<div className="grid grid-cols-2 gap-3">
													<div>
														<label className="text-[10px] font-medium text-ios-text mb-1 block">
															Music Volume ({audioVolume}%)
														</label>
														<input
															type="range"
															min="0"
															max="100"
															value={audioVolume}
															onChange={(e) => {
																setAudioVolume(parseInt(e.target.value));
																setSettingsTouched(true);
															}}
															className="w-full h-1 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-ios-blue"
														/>
													</div>
													<div>
														<label className="text-[10px] font-medium text-ios-text mb-1 block">
															Video Volume ({videoVolume}%)
														</label>
														<input
															type="range"
															min="0"
															max="100"
															value={videoVolume}
															onChange={(e) => {
																setVideoVolume(parseInt(e.target.value));
																setSettingsTouched(true);
															}}
															className="w-full h-1 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-ios-blue"
														/>
													</div>
												</div>
											)}
										</div>
									)}
								</div>
							</div>
						</div>
					)}

					{/* Step 3: Schedule */}
					{step === 3 && (
						<div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-300">
							{/* ... Configs ... */}
							<div>
								<label className="block text-[13px] font-medium text-ios-secondary uppercase tracking-wide mb-2">
									Posting Interval
								</label>
								<div className="flex gap-4">
									<input
										type="number"
										min="1"
										value={frequencyValue}
										onChange={(e) => {
											const v = parseInt(e.target.value, 10);
											// Clamp: NaN / < 1 would silently break or spam the planner.
											setFrequencyValue(Number.isFinite(v) && v >= 1 ? v : 1);
										}}
										className="w-24 bg-ios-card border border-ios-separator rounded-xl px-4 py-3 text-[17px] focus:outline-none focus:border-ios-blue"
									/>
									<select
										value={frequencyUnit}
										onChange={(e) => setFrequencyUnit(e.target.value)}
										className="flex-1 bg-ios-card border border-ios-separator rounded-xl px-4 py-3 text-[17px] focus:outline-none focus:border-ios-blue"
									>
										<option value="minutes">Minutes</option>
										<option value="hours">Hours</option>
										<option value="days">Days</option>
										<option value="weeks">Weeks</option>
									</select>
								</div>
							</div>

							<div>
								<label className="block text-[13px] font-medium text-ios-secondary uppercase tracking-wide mb-2">
									Timezone
								</label>
								<select
									value={timezone}
									onChange={(e) => setTimezone(e.target.value)}
									className="w-full bg-ios-card border border-ios-separator rounded-xl px-4 py-3 text-[17px] focus:outline-none focus:border-ios-blue"
								>
									{Intl.supportedValuesOf("timeZone").map((tz) => (
										<option key={tz} value={tz}>
											{tz}
										</option>
									))}
								</select>
							</div>

							<div className="pt-4 border-t border-ios-separator">
								<div className="flex items-center justify-between mb-4">
									<label className="text-[17px] font-medium text-ios-text flex items-center gap-2">
										<Clock size={18} className="text-ios-blue" />
										Sleep Timer
									</label>
									<div
										onClick={() => setSleepEnabled(!sleepEnabled)}
										className={`w-12 h-7 rounded-full transition-colors cursor-pointer relative ${sleepEnabled ? "bg-green-500" : "bg-gray-300"}`}
									>
										<div
											className={`absolute top-1 w-5 h-5 bg-white rounded-full transition-transform shadow-sm ${sleepEnabled ? "translate-x-6" : "translate-x-1"}`}
										/>
									</div>
								</div>

								{sleepEnabled && (
									<div className="grid grid-cols-2 gap-4 animate-in slide-in-from-top-2">
										<div>
											<span className="text-xs text-ios-secondary mb-1 block">From</span>
											<input
												type="time"
												value={sleepStart}
												onChange={(e) => {
													setSleepStart(e.target.value);
													setFormError("");
												}}
												className="w-full bg-ios-card border border-ios-separator rounded-xl px-4 py-2"
											/>
										</div>
										<div>
											<span className="text-xs text-ios-secondary mb-1 block">To</span>
											<input
												type="time"
												value={sleepEnd}
												onChange={(e) => {
													setSleepEnd(e.target.value);
													setFormError("");
												}}
												className="w-full bg-ios-card border border-ios-separator rounded-xl px-4 py-2"
											/>
										</div>
										{sleepEnabled && sleepStart === sleepEnd && (
											<p className="col-span-2 text-xs text-ios-red">
												O início e o fim do descanso devem ser horários diferentes.
											</p>
										)}
									</div>
								)}
							</div>
						</div>
					)}

					{/* Step 4: Sorting */}
					{step === 4 && (
						<div className="animate-in fade-in slide-in-from-right-4 duration-300">
							<label className="block text-[13px] font-medium text-ios-secondary uppercase tracking-wide mb-3">
								Sort Order
							</label>
							<div className="grid grid-cols-1 gap-2">
								{[
									{
										id: "random_loop",
										label: "Infinite Random",
										desc:
											"Posts randomly without duplicates. Repeats automatically once all items are posted.",
									},
									{
										id: "old_to_new",
										label: "Oldest to Newest",
										desc:
											"Posts items in chronological order. Repeats once the end is reached.",
									},
									{
										id: "new_to_old",
										label: "Newest to Oldest",
										desc:
											"Posts items in reverse chronological order. Repeats once the end is reached.",
									},
								].map((option) => (
									<div
										key={option.id}
										onClick={() => setSortOrder(option.id)}
										className={`p-4 rounded-xl border cursor-pointer transition-all ${
											sortOrder === option.id
												? "bg-ios-blue/10 border-ios-blue ring-1 ring-ios-blue"
												: "bg-ios-card border-ios-separator hover:border-ios-blue/30"
										}`}
									>
										<div className="flex items-center justify-between mb-1">
											<span className="font-semibold text-ios-text">{option.label}</span>
											{sortOrder === option.id && (
												<Check size={18} className="text-ios-blue" />
											)}
										</div>
										<p className="text-xs text-ios-secondary">{option.desc}</p>
									</div>
								))}
							</div>

							<div className="mt-6 bg-ios-card border border-ios-separator rounded-xl p-4 space-y-3">
								<h3 className="text-[13px] font-bold text-ios-secondary uppercase tracking-wide">
									Preview
								</h3>
								<div className="grid gap-2 text-sm text-ios-text">
									<div className="flex items-center justify-between gap-4">
										<span className="text-ios-secondary">Name</span>
										<span className="font-medium truncate text-right">
											{name || "Untitled planner"}
										</span>
									</div>
									<div className="flex items-center justify-between gap-4">
										<span className="text-ios-secondary">Channels</span>
										<span className="font-medium text-right">
											{selectedChannelNames.length > 0
												? selectedChannelNames.join(", ")
												: `${scheduleSummary.channels} selected`}
										</span>
									</div>
									<div className="flex items-center justify-between gap-4">
										<span className="text-ios-secondary">Content</span>
										<span className="font-medium text-right">
											{scheduleSummary.contentCount} item(s)
										</span>
									</div>
									<div className="flex items-center justify-between gap-4">
										<span className="text-ios-secondary">Frequency</span>
										<span className="font-medium text-right">
											Every {scheduleSummary.frequency}
										</span>
									</div>
									<div className="flex items-center justify-between gap-4">
										<span className="text-ios-secondary">Start</span>
										<span className="font-medium text-right">
											{scheduleSummary.start}
										</span>
									</div>
									<div className="flex items-center justify-between gap-4">
										<span className="text-ios-secondary">Sleep</span>
										<span className="font-medium text-right">
											{scheduleSummary.sleep}
										</span>
									</div>
									<div className="flex items-center justify-between gap-4">
										<span className="text-ios-secondary">Media</span>
										<span className="font-medium text-right">
											{plannerMediaLabel(mediaType, isCarousel, youtubeMode)}
											{youtubeMode !== "only" && mediaType === "REELS" && !shareToFeed
												? " · sem feed"
												: ""}
										</span>
									</div>
								</div>
								{location ? (
									<p className="text-[11px] text-ios-secondary">
										Location ID configured.
									</p>
								) : null}
							</div>
						</div>
					)}
				</div>

				{/* Footer Buttons */}
				<div className="p-4 border-t border-ios-separator bg-ios-background flex justify-between items-center">
					<IOSButton
						variant="secondary"
						onClick={handleBack}
						disabled={step === 0 || loading}
						className={step === 0 ? "invisible" : ""}
					>
						<ChevronLeft size={18} className="mr-1" /> Back
					</IOSButton>

					{step === STEPS.length - 1 ? (
						<IOSButton
							variant="primary"
							onClick={handleSubmit}
							disabled={loading}
							className="bg-green-600 hover:bg-green-700 min-w-[120px] justify-center"
						>
							{loading ? (uploading ? "Uploading..." : "Creating...") : "Finish"}
						</IOSButton>
					) : (
						<IOSButton
							variant="primary"
							onClick={handleNext}
							className="min-w-[120px] justify-center"
							disabled={
								(step === 0 && !name) ||
								(step === 1 && selectedChannels.length === 0) ||
								(step === 2 &&
									files.length === 0 &&
									selectedContentIds.length === 0 &&
									preservedCount === 0) ||
								(step === 3 && sleepEnabled && sleepStart === sleepEnd)
							}
						>
							Next <ChevronRight size={18} className="ml-1" />
						</IOSButton>
					)}
				</div>
			</div>
		</div>
	);
}
