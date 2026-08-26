"use client";
import { useState, useEffect, useMemo, useRef } from "react";
import {
	Sliders,
	Plus,
	Play,
	Pause,
	Trash2,
	Calendar,
	Terminal,
	Eye,
	X,
	RefreshCw,
	Zap,
	CheckCircle2,
	XCircle,
	Clock,
	Instagram,
	Copy,
	Layers,
	Youtube,
} from "lucide-react";
import IOSButton from "@/components/IOSButton";
import IOSCard from "@/components/IOSComponents";
import PlannerWizard from "@/components/PlannerWizard";
import type { PlannerStatus } from "@/lib/planner-status";
import { formatDateTime, formatRelativeTime } from "@/lib/format";

interface Planner {
	id: string;
	name: string;
	config: unknown; // string do banco OU objeto já parseado (depende da origem)
	status: PlannerStatus;
	channels: { platform?: string; name?: string | null; id?: string }[];
	channel_ids?: string[];
	last_run?: string;
	created_at: string;
	stats?: { total: number; published: number; failed: number };
}

interface PlannerLogItem {
	id: string;
	level: string;
	message: string;
	details?: string | null;
	created_at: string;
}

interface LogsResponse {
	logs?: PlannerLogItem[];
	// A rota retorna snake_case: { logs, total, next_cursor }
	next_cursor?: string | null;
	total?: number;
}

/** Shape do preview carregado de GET /api/planners/[id]/preview (só o usado). */
interface PlannerPreviewData {
	error?: string;
	channels?: {
		id?: string;
		name?: string | null;
		platform?: string | null;
		account_id?: string | null;
		health?: { ok?: boolean; warnings?: string[] };
	}[];
	runtime?: {
		warnings?: string[];
		selectedContent?: { id?: string } | null;
		mediaType?: string;
		mediaUrl?: string | null;
		caption?: string | null;
	};
	gating?: { gated?: string | null; next_run_at?: string | null };
}

function frequencyText(config: unknown): string {
	const freq = (config as Record<string, unknown> | null | undefined)
		?.frequency as { value?: unknown; unit?: unknown } | undefined;
	if (!freq) return "Sem frequência (manual)";
	const v = freq.value;
	const u = freq.unit;
	if (v === 1) {
		const s: Record<string, string> = {
			minutes: "A cada minuto",
			hours: "A cada hora",
			days: "A cada dia",
			weeks: "A cada semana",
		};
		return s[String(u)] ?? `A cada ${v} ${String(u)}`;
	}
	return `A cada ${v} ${String(u)}`;
}

function relativeTime(dateStr?: string): string {
	if (!dateStr) return "Never";
	const diff = Date.now() - new Date(dateStr).getTime();
	const s = Math.floor(diff / 1000);
	if (s < 60) return `${s}s ago`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	return `${Math.floor(h / 24)}d ago`;
}

/**
 * Format a PlannerLog `details` column for display.
 * The cron stores it as a JSON string; older versions may have stored objects.
 * Returns pretty-printed JSON when parseable, otherwise the raw value.
 */
function formatLogDetails(details: unknown): string {
	if (details === null || details === undefined) return "";
	let parsed: unknown = details;
	if (typeof details === "string") {
		try {
			parsed = JSON.parse(details);
			// Some legacy rows are double-stringified
			if (typeof parsed === "string") parsed = JSON.parse(parsed);
		} catch {
			return details;
		}
	}
	try {
		return JSON.stringify(parsed, null, 2);
	} catch {
		return typeof details === "string" ? details : String(details);
	}
}

// Config is persisted as a JSON string (possibly double-stringified by legacy
// versions). Parse it once, defensively, so callers always get an object.
function parsePlannerConfig(config: unknown): Record<string, unknown> {
	if (config === null || config === undefined) return {};
	if (typeof config !== "string") return config as Record<string, unknown>;
	try {
		const parsed = JSON.parse(config) as unknown;
		return typeof parsed === "string"
			? parsePlannerConfig(parsed)
			: (parsed as Record<string, unknown>);
	} catch {
		return {};
	}
}

// ── Next-run helpers ──────────────────────────────────────────────────────────
function isInSleepWindow(config: unknown, now: Date): boolean {
	const cfg = config as Record<string, unknown> | null | undefined;
	const sleep = cfg?.sleep_schedule as
		| { start?: unknown; end?: unknown }
		| undefined;
	if (!sleep?.start || !sleep?.end) return false;
	const tz =
		typeof cfg?.timezone === "string" ? cfg.timezone : "America/Sao_Paulo";
	const local = new Date(now.toLocaleString("en-US", { timeZone: tz }));
	const hhmm = `${String(local.getHours()).padStart(2, "0")}:${String(local.getMinutes()).padStart(2, "0")}`;
	const s = String(sleep.start);
	const e = String(sleep.end);
	if (s <= e) return hhmm >= s && hhmm < e;
	return hhmm >= s || hhmm < e;
}

function formatNextRun(d: Date): string {
	const diff = d.getTime() - Date.now();
	if (diff <= 0) return "Agora";
	const m = Math.round(diff / 60000);
	if (m < 60) return `em ${m}min`;
	const h = Math.floor(m / 60);
	if (h < 24) return `em ${h}h ${m % 60}min`;
	return d.toLocaleDateString("pt-BR", {
		day: "2-digit",
		month: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	});
}

/** Local estimate of the next run. The backend preview returns the authoritative value. */
function computeNextRun(planner: Planner): { label: string; due: boolean } {
	if (planner.status === "paused") return { label: "Pausado", due: false };
	const cfg = planner.config as Record<string, unknown> | undefined;
	const freq = cfg?.frequency as { value?: unknown; unit?: unknown } | undefined;
	const val = Number(freq?.value);
	if (!freq || !Number.isFinite(val) || val <= 0)
		return { label: "Manual (sob demanda)", due: false };
	if (isInSleepWindow(cfg, new Date()))
		return { label: "Em pausa (sleep)", due: false };
	if (cfg?.start_time) {
		const st = new Date(String(cfg.start_time));
		if (!Number.isNaN(st.getTime()) && st.getTime() > Date.now())
			return { label: formatNextRun(st), due: false };
	}
	if (!planner.last_run) return { label: "Agora", due: true };
	const unit =
		freq.unit === "hours"
			? 3600e3
			: freq.unit === "days"
				? 86400e3
				: freq.unit === "weeks"
					? 7 * 86400e3
					: 60e3;
	const next = new Date(new Date(planner.last_run).getTime() + val * unit);
	return next.getTime() <= Date.now()
		? { label: "Agora", due: true }
		: { label: formatNextRun(next), due: false };
}

const LOGS_PAGE_SIZE = 50;
const LOGS_AUTO_REFRESH_MS = 15000;

export default function PlannersPage() {
	const [planners, setPlanners] = useState<Planner[]>([]);
	const [loading, setLoading] = useState(true);
	const [isWizardOpen, setIsWizardOpen] = useState(false);
	const [editingPlanner, setEditingPlanner] = useState<Planner | null>(null);
	const [viewingLogs, setViewingLogs] = useState<Planner | null>(null);
	const [logs, setLogs] = useState<PlannerLogItem[]>([]);
	const [logFilter, setLogFilter] = useState<"all" | "info" | "error">("all");
	const [loadingLogs, setLoadingLogs] = useState(false);
	const [logCursor, setLogCursor] = useState<string | null>(null);
	const [logTotal, setLogTotal] = useState<number | null>(null);
	const [hasMoreLogs, setHasMoreLogs] = useState(false);
	const [clearingLogs, setClearingLogs] = useState(false);
	// Timer de desarme do two-tap confirm — limpo ao fechar o modal/trocar de
	// planner para não deixar "confirmado" um clique imediato após reabrir.
	const clearLogsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const disarmClearLogs = () => {
		if (clearLogsTimerRef.current) clearTimeout(clearLogsTimerRef.current);
		clearLogsTimerRef.current = null;
		setClearingLogs(false);
	};
	const [viewingPreview, setViewingPreview] = useState<Planner | null>(null);
	const [previewData, setPreviewData] = useState<PlannerPreviewData | null>(null);
	const [loadingPreview, setLoadingPreview] = useState(false);
	const [runningId, setRunningId] = useState<string | null>(null);
	const [duplicatingId, setDuplicatingId] = useState<string | null>(null);
	const [deletingId, setDeletingId] = useState<string | null>(null);
	useEffect(() => {
		const h = (e: KeyboardEvent) => { if (e.key === 'Escape') { setDeletingId(null); setViewingLogs(null); setViewingPreview(null); } };
		document.addEventListener('keydown', h);
		return () => document.removeEventListener('keydown', h);
	}, []);
	const [toast, setToast] = useState<{
		msg: string;
		type: "ok" | "err";
	} | null>(null);
	const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const showToast = (msg: string, type: "ok" | "err" = "ok") => {
		// A stale timer from a previous toast would dismiss the NEW one early —
		// clear it first (same fix as settings/analytics, gauntlet module 06).
		if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
		setToast({ msg, type });
		toastTimerRef.current = setTimeout(() => setToast(null), 3000);
	};

	useEffect(() => {
		fetchData();
	}, []);

	async function fetchData() {
		setLoading(true);
		try {
			const pr = await fetch("/api/planners");
			if (pr.ok) setPlanners(await pr.json());
			else showToast("Falha ao carregar planners", "err");
		} catch (e: unknown) {
			console.error("Error fetching planners:", e);
			showToast("Falha ao carregar planners", "err");
		} finally {
			setLoading(false);
		}
	}

	async function toggleStatus(planner: Planner) {
		const newStatus = planner.status === "active" ? "paused" : "active";
		try {
			const res = await fetch(`/api/planners/${planner.id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ status: newStatus }),
			});
			if (!res.ok) throw new Error();
			showToast(newStatus === "paused" ? "Planner pausado" : "Planner ativado");
			fetchData();
		} catch {
			showToast("Falha ao atualizar status", "err");
		}
	}

	async function duplicatePlanner(planner: Planner) {
		setDuplicatingId(planner.id);
		try {
			const res = await fetch(`/api/planners/${planner.id}/duplicate`, {
				method: "POST",
			});
			if (!res.ok) throw new Error();
			showToast("Planner duplicado");
			fetchData();
		} catch {
			showToast("Falha ao duplicar planner", "err");
		} finally {
			setDuplicatingId(null);
		}
	}

	async function runNow(planner: Planner) {
		setRunningId(planner.id);
		try {
			const res = await fetch(`/api/planners/${planner.id}/run`, {
				method: "POST",
			});
			const data: { error?: string; created?: number; posts_created?: number } =
				await res.json().catch(() => ({}));
			if (!res.ok) {
				if (res.status === 409) {
					showToast("Planner pausado — ative antes de executar", "err");
				} else {
					showToast(data.error || "Falha ao executar", "err");
				}
				return;
			}
			const n = data.created ?? data.posts_created ?? "N";
			showToast(`${planner.name} — ${n} post(s) enfileirados ✓`);
			fetchData();
		} catch (e: unknown) {
			showToast(
				`Falha ao executar: ${e instanceof Error ? e.message : String(e)}`,
				"err",
			);
		} finally {
			setRunningId(null);
		}
	}

	async function confirmDelete() {
		if (!deletingId) return;
		try {
			const res = await fetch(`/api/planners/${deletingId}`, {
				method: "DELETE",
			});
			if (!res.ok) throw new Error();
			setDeletingId(null);
			fetchData();
		} catch {
			showToast("Falha ao excluir planner", "err");
			setDeletingId(null);
		}
	}

	// ── Logs (server-side pagination + level filter + auto-refresh) ────────────
	async function fetchLogs(
		plannerId: string,
		mode: "refresh" | "more" = "refresh",
		level?: string,
	) {
		setLoadingLogs(true);
		try {
			const lv = level ?? logFilter;
			const params = new URLSearchParams({ take: String(LOGS_PAGE_SIZE) });
			if (lv && lv !== "all") params.set("level", lv);
			if (mode === "more" && logCursor) params.set("cursor", logCursor);

			const res = await fetch(
				`/api/planners/logs/${plannerId}?${params.toString()}`,
			);
			if (!res.ok) throw new Error("Failed to load logs");
			const data: LogsResponse | PlannerLogItem[] = await res.json();

			const items: PlannerLogItem[] = Array.isArray(data)
				? data
				: (data.logs ?? []);
			setLogs((prev) => (mode === "more" ? [...prev, ...items] : items));
			if (!Array.isArray(data)) {
				setLogCursor(data.next_cursor ?? null);
				setLogTotal(data.total ?? items.length);
				setHasMoreLogs(Boolean(data.next_cursor));
			} else {
				// Legacy array response — no pagination info
				setLogCursor(null);
				setLogTotal(items.length);
				setHasMoreLogs(false);
			}
		} catch (e: unknown) {
			console.error("Error fetching logs:", e);
			showToast("Falha ao carregar logs", "err");
		} finally {
			setLoadingLogs(false);
		}
	}

	useEffect(() => {
		if (!viewingLogs) return;
		// Reset pagination state for the newly opened planner
		setLogs([]);
		setLogCursor(null);
		setLogTotal(null);
		setHasMoreLogs(false);
		fetchLogs(viewingLogs.id, "refresh", logFilter);
		const t = setInterval(
			() => fetchLogs(viewingLogs.id, "refresh", logFilter),
			LOGS_AUTO_REFRESH_MS,
		);
		return () => clearInterval(t);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [viewingLogs, logFilter]);

	// Fecha/troca o modal de logs ⇒ desarma o two-tap confirm de "Limpar logs".
	useEffect(() => {
		return () => disarmClearLogs();
	}, [viewingLogs]);

	async function clearLogs(plannerId: string) {
		// Two-tap confirm: first tap arms, second tap executes (3s window)
		if (!clearingLogs) {
			setClearingLogs(true);
			if (clearLogsTimerRef.current) clearTimeout(clearLogsTimerRef.current);
			clearLogsTimerRef.current = setTimeout(() => {
				clearLogsTimerRef.current = null;
				setClearingLogs(false);
			}, 3000);
			return;
		}
		disarmClearLogs();
		try {
			const res = await fetch(`/api/planners/logs/${plannerId}`, {
				method: "DELETE",
			});
			if (!res.ok) throw new Error();
			showToast("Logs apagados");
			setClearingLogs(false);
			fetchLogs(plannerId, "refresh", logFilter);
		} catch {
			showToast("Falha ao limpar logs", "err");
			setClearingLogs(false);
		}
	}

	// ── Preview ────────────────────────────────────────────────────────────────
	async function fetchPreview(plannerId: string) {
		setLoadingPreview(true);
		try {
			const res = await fetch(`/api/planners/${plannerId}/preview`);
			const data: PlannerPreviewData = await res.json().catch(() => ({}));
			setPreviewData(
				res.ok ? data : { error: data.error || "Falha ao carregar preview" },
			);
		} catch (e: unknown) {
			console.error("Error fetching preview:", e);
			setPreviewData({ error: "Falha ao carregar preview" });
		} finally {
			setLoadingPreview(false);
		}
	}

	useEffect(() => {
		if (viewingPreview) fetchPreview(viewingPreview.id);
	}, [viewingPreview]);

	return (
		<div className="space-y-6 pb-8">
			{/* Toast */}
			{toast && (
				<div
					className={`fixed top-4 right-4 z-[200] flex items-center gap-2 px-4 py-3 rounded-xl text-white text-[14px] font-medium shadow-xl slide-in-from-top-2 ${toast.type === "ok" ? "bg-ios-green" : "bg-ios-red"}`}
				>
					{toast.type === "ok" ? (
						<CheckCircle2 size={16} />
					) : (
						<XCircle size={16} />
					)}
					{toast.msg}
				</div>
			)}

			{/* Header */}
			<div className="flex items-start justify-between">
				<div>
					<h1 className="text-[34px] font-bold text-ios-text">Planners</h1>
					<p className="text-ios-text-secondary text-sm">
						Automatize sua agenda de publicações
					</p>
				</div>
				<IOSButton
					variant="primary"
					className="!py-2 !px-4 flex items-center gap-1"
					onClick={() => {
						setEditingPlanner(null);
						setIsWizardOpen(true);
					}}
				>
					<Plus size={18} />
					Novo planner
				</IOSButton>
			</div>

			{/* Content */}
			{loading ? (
				<div className="flex justify-center p-12">
					<div className="w-8 h-8 border-2 border-ios-blue border-t-transparent rounded-full animate-spin" />
				</div>
			) : planners.length === 0 ? (
				<IOSCard className="p-12 text-center text-ios-text-secondary">
					<Sliders
						size={48}
						className="mx-auto mb-4 opacity-30"
						strokeWidth={1}
					/>
					<h3 className="text-xl font-semibold mb-2 text-ios-text">
						Nenhum planner ainda
					</h3>
					<p className="max-w-xs mx-auto mb-6">
						Crie um planner para agendar publicações automaticamente em um
						ciclo recorrente.
					</p>
					<IOSButton
						variant="primary"
						className="mx-auto"
						onClick={() => setIsWizardOpen(true)}
					>
						Criar meu primeiro planner
					</IOSButton>
				</IOSCard>
			) : (
				<div className="space-y-3">
					{planners.map((p) => {
						// Ensure config is parsed if it's a string from DB
						const planner = { ...p, config: parsePlannerConfig(p.config) };

						const stats = planner.stats ?? {
							total: 0,
							published: 0,
							failed: 0,
						};
						const isRunning = runningId === planner.id;
						const isDuplicating = duplicatingId === planner.id;
						const nextRun = computeNextRun(planner);
						return (
							<IOSCard key={planner.id} className="p-5">
								<div className="flex items-center gap-3">
									{/* Status toggle (one-tap pause/resume) */}
									<button
										onClick={() => toggleStatus(planner)}
										title={
											planner.status === "active"
												? "Pause planner"
												: "Activate planner"
										}
										className={`w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 transition-all hover:opacity-80 ${
											planner.status === "active"
												? "bg-ios-green/15 text-ios-green"
												: "bg-ios-gray-5 text-ios-text-secondary"
										}`}
									>
										{planner.status === "active" ? (
											<Play size={22} fill="currentColor" />
										) : (
											<Pause size={22} fill="currentColor" />
										)}
									</button>

									{/* Info */}
									<div className="flex-1 min-w-0">
										<div className="flex items-center gap-2 flex-wrap">
											<h4 className="font-bold text-[16px] text-ios-text">
												{planner.name}
											</h4>
											<span
												className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full uppercase tracking-wide ${
													planner.status === "active"
														? "bg-ios-green/15 text-ios-green"
														: "bg-ios-gray-5 text-ios-text-secondary"
												}`}
											>
												{planner.status}
											</span>
										</div>

										<div className="flex flex-wrap gap-x-4 gap-y-1 mt-1.5 text-[12px] text-ios-text-secondary">
											<span className="flex items-center gap-1">
												<Calendar size={11} />
												{frequencyText(planner.config)}
											</span>
											<span className="flex items-center gap-1">
												<Clock size={11} />
												Last: {relativeTime(planner.last_run)}
											</span>
											<span className="flex items-center gap-1">
												{(() => {
													const chans = planner.channels || [];
													const isYt = (c: { platform?: string }) =>
														(c.platform || "").toLowerCase() === "youtube";
													const isIg = (c: { platform?: string }) =>
														(c.platform || "").toLowerCase() === "instagram";
													const ChanIcon = chans.length > 0 && chans.every(isYt)
														? Youtube
														: chans.length > 0 && chans.every(isIg)
															? Instagram
															: Layers;
													return <ChanIcon size={11} />;
												})()}
												{(planner.channels || []).length} canais
											</span>
											<span
												className={`flex items-center gap-1 ${nextRun.due ? "text-ios-green font-semibold" : ""}`}
											>
												<Zap size={11} />
												Next: {nextRun.label}
											</span>
										</div>

										{/* Post counts */}
										{stats.total > 0 && (
											<div className="flex gap-3 mt-2 text-[11px]">
												<span className="text-ios-green font-semibold">
													✓ {stats.published} publicados
												</span>
												{stats.failed > 0 && (
													<span className="text-ios-red font-semibold">
														✗ {stats.failed} falharam
													</span>
												)}
												<span className="text-ios-text-secondary">
													{stats.total} total
												</span>
											</div>
										)}
									</div>

									{/* Actions — always visible (touch-friendly) */}
									<div className="flex gap-1 shrink-0">
										<button
											onClick={() => runNow(planner)}
											disabled={isRunning}
											title="Run now"
											className="p-1.5 rounded-lg text-ios-blue bg-ios-blue/5 hover:bg-ios-blue/10 transition-colors disabled:opacity-50"
										>
											{isRunning ? (
												<RefreshCw size={16} className="animate-spin" />
											) : (
												<Zap size={16} />
											)}
										</button>
										<button
											onClick={() => duplicatePlanner(planner)}
											disabled={isDuplicating}
											title="Duplicate planner"
											className="p-1.5 rounded-lg text-ios-text-secondary bg-ios-gray-5/40 hover:bg-ios-gray-5 transition-colors disabled:opacity-50"
										>
											{isDuplicating ? (
												<RefreshCw size={16} className="animate-spin" />
											) : (
												<Copy size={16} />
											)}
										</button>
										<button
											onClick={() => setViewingLogs(planner)}
											title="View logs"
											className="p-1.5 rounded-lg text-ios-text-secondary bg-ios-gray-5/40 hover:bg-ios-gray-5 transition-colors"
										>
											<Terminal size={16} />
										</button>
										<button
											onClick={() => setViewingPreview(planner)}
											title="Preview next run"
											className="p-1.5 rounded-lg text-ios-text-secondary bg-ios-gray-5/40 hover:bg-ios-gray-5 transition-colors"
										>
											<Eye size={16} />
										</button>
										<button
											onClick={() => {
												setEditingPlanner(planner);
												setIsWizardOpen(true);
											}}
											title="Edit planner"
											className="p-1.5 rounded-lg text-ios-blue bg-ios-blue/5 hover:bg-ios-blue/10 transition-colors"
										>
											<Sliders size={16} />
										</button>
										<button
											onClick={() => setDeletingId(planner.id)}
											title="Delete planner"
											className="p-1.5 rounded-lg text-ios-red bg-ios-red/5 hover:bg-ios-red/10 transition-colors"
										>
											<Trash2 size={16} />
										</button>
									</div>
								</div>
							</IOSCard>
						);
					})}
				</div>
			)}

			{/* Wizard */}
			<PlannerWizard
				isOpen={isWizardOpen}
				onClose={() => {
					setIsWizardOpen(false);
					setEditingPlanner(null);
				}}
				onSuccess={fetchData}
				initialData={editingPlanner ?? undefined}
			/>

			{/* Delete Confirmation Modal */}
			{deletingId && (
				<div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm fade-in" role="presentation" onClick={()=>setDeletingId(null)}>
					<div role="dialog" aria-modal="true" aria-labelledby="delete-planner-title" tabIndex={-1} onClick={(e)=>e.stopPropagation()} className="bg-ios-card w-80 rounded-2xl shadow-2xl overflow-hidden zoom-in-95">
						<div className="p-6 text-center">
							<div className="w-12 h-12 rounded-full bg-ios-red/15 flex items-center justify-center mx-auto mb-4">
								<Trash2 size={22} className="text-ios-red" />
							</div>
							<h3 id="delete-planner-title" className="text-[17px] font-bold text-ios-text mb-1">
								Excluir planner?
							</h3>
							<p className="text-[14px] text-ios-text-secondary">
								Esta ação não pode ser desfeita.
							</p>
						</div>
						<div className="border-t border-ios-separator flex">
							<button
								onClick={() => setDeletingId(null)}
								className="flex-1 py-3.5 text-[17px] text-ios-blue font-medium border-r border-ios-separator hover:bg-ios-gray-6 transition-colors"
							>
								Cancelar
							</button>
							<button
								onClick={confirmDelete}
								className="flex-1 py-3.5 text-[17px] text-ios-red font-semibold hover:bg-ios-red/10 transition-colors"
							>
								Excluir
							</button>
						</div>
					</div>
				</div>
			)}

			{/* Logs Modal */}
			{viewingLogs && (
				<div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm fade-in" role="presentation" onClick={()=>setViewingLogs(null)}>
					<div role="dialog" aria-modal="true" aria-labelledby="logs-modal-title" tabIndex={-1} onClick={(e)=>e.stopPropagation()} className="bg-ios-card w-full max-w-2xl max-h-[85dvh] rounded-3xl shadow-2xl flex flex-col overflow-hidden zoom-in-95">
						<div className="p-5 border-b border-ios-separator flex items-center justify-between">
							<div>
								<h2 id="logs-modal-title" className="text-[17px] font-bold text-ios-text">
									Logs: {viewingLogs.name}
								</h2>
								<p className="text-[12px] text-ios-text-secondary">
									{logTotal !== null
										? `${logTotal} logs · auto-refresh 15s`
										: "Execution history"}
								</p>
							</div>
							<div className="flex items-center gap-2">
								{/* Level filter */}
								<div className="flex rounded-lg border border-ios-separator overflow-hidden">
									{(["all", "info", "error"] as const).map((lv) => (
										<button
											key={lv}
											onClick={() => setLogFilter(lv)}
											className={`px-2 py-1 text-[10px] font-bold uppercase tracking-wide transition-colors ${logFilter === lv ? "bg-ios-blue text-white" : "text-ios-text-secondary hover:bg-ios-gray-5"}`}
										>
											{lv}
										</button>
									))}
								</div>
								<button
									onClick={() => clearLogs(viewingLogs.id)}
									title="Clear logs (tap twice to confirm)"
									className={`px-2 py-1.5 text-[11px] font-bold rounded-lg transition-colors ${clearingLogs ? "bg-ios-red text-white" : "text-ios-red bg-ios-red/5 hover:bg-ios-red/10"}`}
								>
									{clearingLogs ? "Confirmar?" : "Limpar"}
								</button>
								<button
									onClick={() =>
										fetchLogs(viewingLogs.id, "refresh", logFilter)
									}
									className="p-2 text-ios-blue hover:bg-ios-blue/10 rounded-full transition-colors"
									disabled={loadingLogs}
									title="Refresh logs"
								>
									<RefreshCw
										size={18}
										className={loadingLogs ? "animate-spin" : ""}
									/>
								</button>
								<button
									onClick={() => setViewingLogs(null)}
									className="p-2 text-ios-text-secondary hover:bg-ios-gray-5 rounded-full transition-colors"
								>
									<X size={20} />
								</button>
							</div>
						</div>
						<div className="flex-1 overflow-y-auto p-4 space-y-2 custom-scrollbar bg-ios-background">
							{logs.length === 0 ? (
								<div className="text-center py-12 text-ios-text-secondary">
									<Terminal size={32} className="mx-auto mb-2 opacity-20" />
									<p>
										{loadingLogs
											? "Carregando logs..."
											: `Nenhum log ${logFilter === "all" ? "" : logFilter} encontrado.`}
									</p>
								</div>
							) : (
								logs.map((log: PlannerLogItem) => (
									<div
										key={log.id}
										className="bg-ios-card p-3 rounded-xl border border-ios-separator text-sm"
									>
										<div className="flex items-center justify-between mb-1">
											<span
												className={`font-bold uppercase text-[10px] px-1.5 py-0.5 rounded ${log.level === "error" ? "bg-ios-red/10 text-ios-red" : "bg-ios-blue/10 text-ios-blue"}`}
											>
												{log.level}
											</span>
											<span className="text-[10px] text-ios-text-secondary">
												{new Date(log.created_at).toLocaleString()}
											</span>
										</div>
										<p className="text-ios-text font-medium break-words">
											{log.message}
										</p>
										{formatLogDetails(log.details) && (
											<pre className="mt-2 text-[10px] bg-ios-background p-2 rounded border border-ios-separator overflow-x-auto text-ios-text-secondary max-h-32 whitespace-pre-wrap break-words">
												{formatLogDetails(log.details)}
											</pre>
										)}
									</div>
								))
							)}
						</div>
						{/* Pagination footer */}
						<div className="border-t border-ios-separator p-3 flex items-center justify-between bg-ios-card">
							<span className="text-[11px] text-ios-text-secondary">
								{logs.length}
								{logTotal !== null && logTotal > logs.length
									? ` de ${logTotal}`
									: ""}{" "}
								logs
							</span>
							<button
								onClick={() => fetchLogs(viewingLogs.id, "more", logFilter)}
								disabled={!hasMoreLogs || loadingLogs}
								className="px-3 py-1.5 text-[12px] font-semibold rounded-lg text-ios-blue bg-ios-blue/5 hover:bg-ios-blue/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
							>
								{loadingLogs ? "Carregando..." : "Mais antigos"}
							</button>
						</div>
					</div>
				</div>
			)}

			{/* Preview Modal */}
			{viewingPreview && (
				<div className="fixed inset-0 z-[90] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm fade-in" role="presentation" onClick={()=>setViewingPreview(null)}>
					<div role="dialog" aria-modal="true" aria-labelledby="preview-modal-title" tabIndex={-1} onClick={(e)=>e.stopPropagation()} className="bg-ios-card w-full max-w-2xl max-h-[85dvh] rounded-3xl shadow-2xl flex flex-col overflow-hidden zoom-in-95">
						<div className="p-5 border-b border-ios-separator flex items-center justify-between">
							<div>
								<h2 id="preview-modal-title" className="text-[17px] font-bold text-ios-text">
									Preview: {viewingPreview.name}
								</h2>
								<p className="text-[12px] text-ios-text-secondary">
									Próxima execução sem criar posts
								</p>
							</div>
							<div className="flex items-center gap-2">
								<button
									onClick={() => fetchPreview(viewingPreview.id)}
									className="p-2 text-ios-blue hover:bg-ios-blue/10 rounded-full transition-colors"
									disabled={loadingPreview}
								>
									<RefreshCw
										size={18}
										className={loadingPreview ? "animate-spin" : ""}
									/>
								</button>
								<button
									onClick={() => setViewingPreview(null)}
									className="p-2 text-ios-text-secondary hover:bg-ios-gray-5 rounded-full transition-colors"
								>
									<X size={20} />
								</button>
							</div>
						</div>
						<div className="flex-1 overflow-y-auto p-4 space-y-3 bg-ios-background">
							{loadingPreview ? (
								<div className="flex items-center justify-center py-12 text-ios-text-secondary">
									<RefreshCw size={18} className="animate-spin mr-2" />
									Carregando preview...
								</div>
							) : previewData?.error ? (
								<div className="p-4 rounded-xl bg-ios-red/10 text-ios-red text-sm">
									{previewData.error}
								</div>
							) : (
								<>
									{(() => {
										const warnings = previewData?.runtime?.warnings || [];
										return warnings.length > 0 ? (
											<div className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-sm space-y-1">
												{warnings.map((warning: string) => (
													<div key={warning}>{warning}</div>
												))}
											</div>
										) : null;
									})()}
									{previewData?.gating?.next_run_at && (
										<div className="bg-ios-card border border-ios-separator rounded-xl p-4 flex items-center gap-2">
											<Zap size={16} className="text-ios-blue" />
											<div>
												<div className="text-xs uppercase tracking-wide text-ios-text-secondary mb-0.5">
													Próxima execução
												</div>
												<div className="font-semibold text-ios-text">
													{new Date(
														previewData.gating.next_run_at,
													).toLocaleString("pt-BR")}
												</div>
											</div>
											{previewData?.gating?.gated && (
												<span className="ml-auto text-[10px] font-bold px-2 py-0.5 rounded-full uppercase bg-amber-100 text-amber-800">
													Gated
												</span>
											)}
										</div>
									)}
									<div className="grid gap-2">
										<div className="bg-ios-card border border-ios-separator rounded-xl p-4">
											<div className="text-xs uppercase tracking-wide text-ios-text-secondary mb-1">
												Conteúdo selecionado
											</div>
											<div className="font-semibold text-ios-text">
												{previewData?.runtime?.selectedContent?.id ||
													"Sem conteúdo"}
											</div>
											<div className="text-sm text-ios-text-secondary mt-1">
												{(() => {
												// Preview diferencia "Short do YouTube"/"Post na Comunidade".
												// Em planners mistos IG+YT o conteúdo vai para as duas
												// plataformas — rotula as duas em vez de sugerir só YouTube.
												const channels: Array<{ platform?: string | null }> =
													previewData?.channels || [];
												const mediaType = String(
													previewData?.runtime?.mediaType || "",
												).toUpperCase();
												const hasYt = channels.some(
													(c) => (c.platform || "").toLowerCase() === "youtube",
												);
												if (hasYt) {
													const ytLabel =
														mediaType === "IMAGE" || mediaType === "CAROUSEL"
															? "Post na Comunidade"
															: "Short do YouTube";
													const onlyYt = channels.every(
														(c) => (c.platform || "").toLowerCase() === "youtube",
													);
													if (onlyYt) return ytLabel;
													const igLabel =
														mediaType === "CAROUSEL"
															? "Carrossel"
															: mediaType === "IMAGE"
																? "Imagem"
																: "Reels";
													return `${igLabel} · ${ytLabel}`;
												}
												return previewData?.runtime?.mediaType || "Desconhecido";
											})()}{" "}
												{previewData?.runtime?.mediaUrl
													? "Mídia pronta"
													: "Sem mídia"}
											</div>
										</div>
										<div className="bg-ios-card border border-ios-separator rounded-xl p-4">
											<div className="text-xs uppercase tracking-wide text-ios-text-secondary mb-1">
												Caption
											</div>
											<p className="text-sm text-ios-text whitespace-pre-wrap">
												{previewData?.runtime?.caption || "Sem legenda"}
											</p>
										</div>
										<div className="bg-ios-card border border-ios-separator rounded-xl p-4">
											<div className="text-xs uppercase tracking-wide text-ios-text-secondary mb-2">
												Canais
											</div>
											<div className="space-y-2">
												{(previewData?.channels || []).map(
												(channel: NonNullable<PlannerPreviewData["channels"]>[number]) => (
													<div
														key={channel.id}
														className="flex items-start justify-between gap-4 text-sm"
													>
														<div>
															<div className="font-medium text-ios-text">
																{channel.name}
															</div>
															<div className="text-ios-text-secondary text-xs">
																{channel.account_id}
															</div>
														</div>
														<div className="text-right">
															<div
																className={
																	channel.health?.ok
																		? "text-ios-green"
																		: "text-ios-red"
																}
															>
																{channel.health?.ok ? "Pronto" : "Bloqueado"}
															</div>
															{(channel.health?.warnings || []).length > 0 && (
																<div className="text-[11px] text-amber-700">
																	{(channel.health?.warnings || []).join(", ")}
																</div>
															)}
														</div>
													</div>
												))}
											</div>
										</div>
									</div>
								</>
							)}
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
