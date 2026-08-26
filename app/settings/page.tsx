"use client";
import { useState, useEffect, useCallback, useRef } from "react";
import {
	Bell,
	Clock,
	Database,
	HardDrive,
	RefreshCw,
	Save,
	XCircle,
	CheckCircle2,
	Trash2,
	RotateCcw,
	Youtube,
} from "lucide-react";
import IOSButton from "@/components/IOSButton";
import IOSCard from "@/components/IOSComponents";

// ─── Types ───────────────────────────────────────────────────────────────────

interface SensitiveField {
	set: boolean;
	masked: string;
}

interface SettingsResponse {
	TELEGRAM_BOT_TOKEN: SensitiveField;
	TELEGRAM_CHAT_ID: string;
	NOTIFY_WEBHOOK_URL: SensitiveField;
	PUBLISH_MIN_INTERVAL_SECONDS: number | null;
	RETENTION_POSTS_DAYS: number | null;
	RETENTION_LOGS_DAYS: number | null;
}

interface BackupInfo {
	name: string;
	size: number;
	mtime: string;
}

/** Resposta de GET /api/youtube/health (status da integração YouTube). */
interface YoutubeHealthResponse {
	configured: boolean;
	base_url_configured?: boolean;
	api_key_configured?: boolean;
	ok?: boolean;
	sessions_active?: number;
	db_connected?: boolean;
	version?: string;
	error?: string;
}

type ToastState = { msg: string; type: "ok" | "err" } | null;

function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "—";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function errMsg(e: unknown, fallback: string): string {
	return e instanceof Error && e.message ? e.message : fallback;
}

/** Traduz erros conhecidos do servidor (validações chegam em inglês cru). */
function translateSettingsError(message: string): string {
	return message
		.replace(/([A-Z_]+) must be a non-negative number/gi, (_m, key) => `${key} deve ser um número não negativo`)
		.replace(/([A-Z_]+) must be a string/gi, (_m, key) => `${key} deve ser um texto`)
		.replace(/Invalid payload/i, "Dados inválidos")
		.replace(/Internal server error/i, "Erro interno do servidor");
}

function Field({
	label,
	value,
	onChange,
	placeholder,
	hint,
	type = "text",
	mono,
}: {
	label: string;
	value: string;
	onChange: (v: string) => void;
	placeholder?: string;
	hint?: string;
	type?: string;
	mono?: boolean;
}) {
	return (
		<div>
			<label className="text-xs font-medium text-ios-text mb-1.5 block">
				{label}
			</label>
			<input
				type={type}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder={placeholder}
				className={`w-full bg-ios-background border border-ios-separator rounded-lg p-2 text-sm focus:border-ios-blue outline-none placeholder:text-gray-400 ${mono ? "font-mono" : ""}`}
			/>
			{hint && (
				<p className="text-[11px] text-ios-text-secondary mt-1">{hint}</p>
			)}
		</div>
	);
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function SettingsPage() {
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [toast, setToast] = useState<ToastState>(null);

	// Form state (inputs always hold raw text; sensitive fields only sent when non-empty)
	const [botToken, setBotToken] = useState("");
	const [chatId, setChatId] = useState("");
	const [webhook, setWebhook] = useState("");
	const [minInterval, setMinInterval] = useState("");
	const [retPosts, setRetPosts] = useState("");
	const [retLogs, setRetLogs] = useState("");

	// Display-only hints for sensitive fields
	const [botTokenState, setBotTokenState] = useState<SensitiveField>({
		set: false,
		masked: "",
	});
	const [webhookState, setWebhookState] = useState<SensitiveField>({
		set: false,
		masked: "",
	});

	// Backups
	const [backups, setBackups] = useState<BackupInfo[]>([]);
	const [loadingBackups, setLoadingBackups] = useState(false);
	const [creatingBackup, setCreatingBackup] = useState(false);
	const [restoringName, setRestoringName] = useState<string | null>(null);

	// Integração YouTube (leitura)
	const [ytHealth, setYtHealth] = useState<YoutubeHealthResponse | null>(null);
	const [ytLoading, setYtLoading] = useState(true);

	const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const showToast = useCallback((msg: string, type: "ok" | "err" = "ok") => {
		// A stale timer from a previous toast would dismiss the NEW one early —
		// clear it first (found by the module-06 gauntlet, S6).
		if (toastTimer.current) clearTimeout(toastTimer.current);
		setToast({ msg, type });
		toastTimer.current = setTimeout(() => setToast(null), 3000);
	}, []);

	const loadSettings = useCallback(async () => {
		try {
			const res = await fetch("/api/settings");
			if (!res.ok) throw new Error("Falha ao carregar configurações");
			const data = (await res.json()) as SettingsResponse;
			setBotTokenState(data.TELEGRAM_BOT_TOKEN);
			setChatId(data.TELEGRAM_CHAT_ID ?? "");
			setWebhookState(data.NOTIFY_WEBHOOK_URL);
			setMinInterval(
				data.PUBLISH_MIN_INTERVAL_SECONDS === null
					? ""
					: String(data.PUBLISH_MIN_INTERVAL_SECONDS),
			);
			setRetPosts(
				data.RETENTION_POSTS_DAYS === null
					? ""
					: String(data.RETENTION_POSTS_DAYS),
			);
			setRetLogs(
				data.RETENTION_LOGS_DAYS === null
					? ""
					: String(data.RETENTION_LOGS_DAYS),
			);
		} catch (e: unknown) {
			console.error("Error loading settings:", e);
			showToast(errMsg(e, "Falha ao carregar configurações"), "err");
		} finally {
			setLoading(false);
		}
	}, [showToast]);

	const loadBackups = useCallback(async () => {
		setLoadingBackups(true);
		try {
			const res = await fetch("/api/admin/backups");
			if (!res.ok) throw new Error("Falha ao carregar backups");
			const data = await res.json();
			setBackups(Array.isArray(data.backups) ? data.backups : []);
		} catch (e: unknown) {
			console.error("Error loading backups:", e);
			showToast(errMsg(e, "Failed to load backups"), "err");
		} finally {
			setLoadingBackups(false);
		}
	}, [showToast]);

	const loadYoutubeHealth = useCallback(async () => {
		setYtLoading(true);
		try {
			const res = await fetch("/api/youtube/health");
			// Um 502 da rota pode vir com corpo útil (configured:true + error) —
			// nesse caso usamos o diagnóstico do backend em vez de descartá-lo.
			let data: YoutubeHealthResponse | null = null;
			if (!res.ok) {
				data = (await res.json().catch(() => null)) as YoutubeHealthResponse | null;
				if (!data || data.configured !== true) {
					// 401/500 sem corpo `configured` — diagnóstico enganoso tratar
					// como "Não configurada no servidor".
					throw new Error(`Falha ao verificar o status (HTTP ${res.status})`);
				}
			} else {
				data = (await res.json().catch(() => null)) as YoutubeHealthResponse | null;
			}
			if (!data) throw new Error("Resposta inválida");
			setYtHealth(data);
		} catch (e: unknown) {
			console.error("Error loading YouTube health:", e);
			setYtHealth(null);
		} finally {
			setYtLoading(false);
		}
	}, []);

	useEffect(() => {
		loadSettings();
		loadBackups();
	}, [loadSettings, loadBackups]);

	useEffect(() => {
		loadYoutubeHealth();
	}, [loadYoutubeHealth]);

	async function saveSettings() {
		setSaving(true);
		try {
			const payload: Record<string, string> = {};
			// Sensitive fields: only send when the user typed something (empty = keep current)
			if (botToken.trim() !== "") payload.TELEGRAM_BOT_TOKEN = botToken.trim();
			if (webhook.trim() !== "") payload.NOTIFY_WEBHOOK_URL = webhook.trim();
			// Plain / numeric fields: always send (empty clears)
			payload.TELEGRAM_CHAT_ID = chatId.trim();
			payload.PUBLISH_MIN_INTERVAL_SECONDS = minInterval.trim();
			payload.RETENTION_POSTS_DAYS = retPosts.trim();
			payload.RETENTION_LOGS_DAYS = retLogs.trim();

			const res = await fetch("/api/settings", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});
			if (!res.ok) {
				const err = (await res.json().catch(() => ({}))) as { error?: string };
				throw new Error(translateSettingsError(err.error || "Falha ao salvar configurações"));
			}
			setBotToken("");
			setWebhook("");
			await loadSettings();
			showToast("Configurações salvas ✓");
		} catch (e: unknown) {
			console.error("Error saving settings:", e);
			showToast(errMsg(e, "Falha ao salvar configurações"), "err");
		} finally {
			setSaving(false);
		}
	}

	async function clearSensitive(
		key: "TELEGRAM_BOT_TOKEN" | "NOTIFY_WEBHOOK_URL",
	) {
		const label = key === "TELEGRAM_BOT_TOKEN" ? "Bot token" : "Webhook";
		const ok = window.confirm(`Remover o valor salvo de ${label}?`);
		if (!ok) return;
		try {
			const res = await fetch("/api/settings", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ [key]: "" }),
			});
			if (!res.ok) throw new Error("Falha ao limpar");
			if (key === "TELEGRAM_BOT_TOKEN") setBotToken("");
			else setWebhook("");
			await loadSettings();
			showToast(
				`${key === "TELEGRAM_BOT_TOKEN" ? "Bot token" : "Webhook"} removido`,
			);
		} catch (e: unknown) {
			console.error(e);
			showToast(errMsg(e, "Falha ao limpar o valor"), "err");
		}
	}

	async function createBackup() {
		setCreatingBackup(true);
		try {
			const res = await fetch("/api/admin/backups", { method: "POST" });
			if (!res.ok) throw new Error("Failed to create backup");
			await loadBackups();
			showToast("Backup criado ✓");
		} catch (e: unknown) {
			console.error(e);
			showToast(errMsg(e, "Falha ao criar backup"), "err");
		} finally {
			setCreatingBackup(false);
		}
	}

	async function restoreBackup(filename: string) {
		const ok = window.confirm(
			`Restaurar ${filename}?\n\nIsso SUBSTITUI o banco atual por este backup e reinicia o app. Uma cópia de segurança do banco atual é criada primeiro.`,
		);
		if (!ok) return;
		setRestoringName(filename);
		try {
			const res = await fetch("/api/admin/restore", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ filename }),
			});
			const data = (await res.json().catch(() => ({}))) as {
				error?: string;
				restarted?: boolean;
			};
			if (!res.ok) throw new Error(data.error || "Falha ao restaurar");
			showToast("Restaurado — o app será reiniciado agora");
		} catch (e: unknown) {
			console.error(e);
			showToast(errMsg(e, "Falha ao restaurar"), "err");
		} finally {
			setRestoringName(null);
		}
	}

	if (loading) {
		return (
			<div className="flex justify-center p-20">
				<div className="w-8 h-8 border-2 border-ios-blue border-t-transparent rounded-full animate-spin" />
			</div>
		);
	}

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
					<h1 className="text-[34px] font-bold text-ios-text">Configurações</h1>
					<p className="text-ios-text-secondary text-sm">
						Notificações, limites de publicação, retenção e backups
					</p>
				</div>
			</div>

			{/* ── Notifications ── */}
			<IOSCard className="p-5">
				<div className="flex items-center gap-2 mb-4">
					<div className="w-9 h-9 rounded-xl bg-ios-blue/10 flex items-center justify-center text-ios-blue">
						<Bell size={18} />
					</div>
					<h3 className="text-[17px] font-bold text-ios-text">Notificações</h3>
				</div>
				<div className="space-y-4">
					<div>
						<div className="flex items-center justify-between">
							<label className="text-xs font-medium text-ios-text mb-1.5 block">
								Telegram Bot Token
							</label>
							{botTokenState.set && (
								<button
									onClick={() => clearSensitive("TELEGRAM_BOT_TOKEN")}
									className="text-[10px] text-ios-red flex items-center gap-1 hover:underline"
								>
									<Trash2 size={10} /> Limpar ({botTokenState.masked})
								</button>
							)}
						</div>
						<input
							value={botToken}
							onChange={(e) => setBotToken(e.target.value)}
							type="password"
							placeholder={
								botTokenState.set
									? `Definido — deixe vazio para manter (${botTokenState.masked})`
									: "Cole o token do bot vindo do @BotFather"
							}
							className="w-full bg-ios-background border border-ios-separator rounded-lg p-2 text-sm focus:border-ios-blue outline-none placeholder:text-gray-400 font-mono"
						/>
						<p className="text-[11px] text-ios-text-secondary mt-1">
							Usado para alertar você quando um post falha ou a execução
							termina com erros.
						</p>
					</div>

					<Field
						label="Telegram Chat ID"
						value={chatId}
						onChange={setChatId}
						placeholder="e.g. 123456789 or @yourusername"
						hint="ID numérico ou @username do chat que receberá os alertas."
					/>

					<div>
						<div className="flex items-center justify-between">
							<label className="text-xs font-medium text-ios-text mb-1.5 block">
								Webhook URL (alternative)
							</label>
							{webhookState.set && (
								<button
									onClick={() => clearSensitive("NOTIFY_WEBHOOK_URL")}
									className="text-[10px] text-ios-red flex items-center gap-1 hover:underline"
								>
									<Trash2 size={10} /> Limpar ({webhookState.masked})
								</button>
							)}
						</div>
						<input
							value={webhook}
							onChange={(e) => setWebhook(e.target.value)}
							type="url"
							placeholder={
								webhookState.set
									? `Definido — deixe vazio para manter (${webhookState.masked})`
									: "https://hooks.example.com/..."
							}
							className="w-full bg-ios-background border border-ios-separator rounded-lg p-2 text-sm focus:border-ios-blue outline-none placeholder:text-gray-400 font-mono"
						/>
						<p className="text-[11px] text-ios-text-secondary mt-1">
							Se definido, recebe POST JSON {"{text, ts}"} de cada alerta
							(usado quando o Telegram não está configurado).
						</p>
					</div>
				</div>
			</IOSCard>

			{/* ── Publishing ── */}
			<IOSCard className="p-5">
				<div className="flex items-center gap-2 mb-4">
					<div className="w-9 h-9 rounded-xl bg-ios-green/10 flex items-center justify-center text-ios-green">
						<Clock size={18} />
					</div>
					<h3 className="text-[17px] font-bold text-ios-text">Publicação</h3>
				</div>
				<Field
					label="Intervalo mínimo entre posts (mesmo canal, segundos)"
					value={minInterval}
					onChange={setMinInterval}
					type="number"
					placeholder="e.g. 300"
					hint="O cron pula o post se o canal publicou há menos que este intervalo (em segundos). 0 ou vazio = sem limite. Ajuda a evitar limites de taxa (429)."
				/>
			</IOSCard>

			{/* ── Retention ── */}
			<IOSCard className="p-5">
				<div className="flex items-center gap-2 mb-4">
					<div className="w-9 h-9 rounded-xl bg-purple-500/10 flex items-center justify-center text-purple-500">
						<Database size={18} />
					</div>
					<h3 className="text-[17px] font-bold text-ios-text">
						Retenção de dados
					</h3>
				</div>
				<div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
					<Field
						label="Manter posts por (dias)"
						value={retPosts}
						onChange={setRetPosts}
						type="number"
						placeholder="90"
						hint="Posts publicados/falhados/cancelados mais antigos que isso são excluídos pela manutenção diária. Vazio = padrão 90."
					/>
					<Field
						label="Manter logs de planners por (dias)"
						value={retLogs}
						onChange={setRetLogs}
						type="number"
						placeholder="30"
						hint="Logs de planners mais antigos que isso são excluídos. Vazio = padrão 30."
					/>
				</div>
			</IOSCard>

			{/* ── Backups ── */}
			<IOSCard className="p-5">
				<div className="flex items-center justify-between mb-4">
					<div className="flex items-center gap-2">
						<div className="w-9 h-9 rounded-xl bg-amber-500/10 flex items-center justify-center text-amber-600">
							<HardDrive size={18} />
						</div>
						<h3 className="text-[17px] font-bold text-ios-text">Backups</h3>
					</div>
					<IOSButton
						variant="secondary"
						className="!py-2 !px-3 flex items-center gap-1"
						onClick={createBackup}
						disabled={creatingBackup}
					>
						<RefreshCw
							size={14}
							className={creatingBackup ? "animate-spin" : ""}
						/>
						Criar agora
					</IOSButton>
				</div>
				<p className="text-[12px] text-ios-text-secondary mb-3">
					Backups diários são gravados em /app/data/backups (mantidos os 7 mais
					recentes). Restaurar substitui o banco atual e reinicia o app.
				</p>
				{loadingBackups ? (
					<div className="flex justify-center py-6 text-ios-text-secondary">
						<RefreshCw size={16} className="animate-spin mr-2" /> Carregando
						backups...
					</div>
				) : backups.length === 0 ? (
					<div className="py-6 text-center text-ios-text-secondary text-sm">
						<Database size={28} className="mx-auto mb-2 opacity-20" />
						Nenhum backup ainda — o job diário criará o primeiro.
					</div>
				) : (
					<div className="divide-y divide-ios-separator rounded-xl border border-ios-separator overflow-hidden">
						{backups.map((b) => (
							<div
								key={b.name}
								className="flex items-center gap-3 px-3 py-2.5 bg-ios-background"
							>
								<div className="flex-1 min-w-0">
									<p className="text-[13px] font-medium text-ios-text font-mono truncate">
										{b.name}
									</p>
									<p className="text-[10px] text-ios-text-secondary">
										{formatBytes(b.size)} ·{" "}
										{b.mtime ? new Date(b.mtime).toLocaleString() : ""}
									</p>
								</div>
								<button
									onClick={() => restoreBackup(b.name)}
									disabled={restoringName === b.name}
									className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[12px] font-semibold text-ios-red hover:bg-ios-red/10 transition-colors disabled:opacity-50"
								>
									{restoringName === b.name ? (
										<RefreshCw size={12} className="animate-spin" />
									) : (
										<RotateCcw size={12} />
									)}
									Restaurar
								</button>
							</div>
						))}
					</div>
				)}
			</IOSCard>

			{/* ── Integração YouTube ── */}
			<IOSCard className="p-5">
				<div className="flex items-center justify-between mb-4">
					<div className="flex items-center gap-2">
						<div className="w-9 h-9 rounded-xl bg-ios-red/10 flex items-center justify-center text-ios-red">
							<Youtube size={18} />
						</div>
						<h3 className="text-[17px] font-bold text-ios-text">Integração YouTube</h3>
					</div>
					<IOSButton
						variant="secondary"
						className="!py-2 !px-3 flex items-center gap-1"
						onClick={loadYoutubeHealth}
						disabled={ytLoading}
					>
						<RefreshCw size={14} className={ytLoading ? "animate-spin" : ""} />
						Atualizar
					</IOSButton>
				</div>
				{ytLoading ? (
					<div className="flex justify-center py-6">
						<div className="w-6 h-6 border-2 border-ios-blue border-t-transparent rounded-full animate-spin" />
					</div>
				) : !ytHealth ? (
					<div className="py-4 text-center text-ios-text-secondary text-sm">
						Não foi possível verificar o status da integração.
					</div>
				) : !ytHealth.configured ? (
					<div className="space-y-2">
						<p className="text-sm font-medium text-ios-orange flex items-center gap-1.5">
							<XCircle size={15} /> Não configurada no servidor
						</p>
						<ul className="text-[12px] text-ios-text-secondary space-y-1 list-disc list-inside">
							<li>YOUTUBE_API_BASE_URL: {ytHealth.base_url_configured ? "configurada ✓" : "ausente"}</li>
							<li>YOUTUBE_API_KEY: {ytHealth.api_key_configured ? "configurada ✓" : "ausente"}</li>
						</ul>
						<p className="text-[11px] text-ios-text-secondary mt-1">
							Defina as variáveis no .env do servidor e reinicie o app.
						</p>
					</div>
				) : ytHealth.ok ? (
					<div className="space-y-2">
						<p className="text-sm font-medium text-ios-green flex items-center gap-1.5">
							<CheckCircle2 size={15} /> API externa online
						</p>
						<div className="grid grid-cols-3 gap-2 text-center pt-1">
							<div className="rounded-xl bg-ios-background border border-ios-separator p-2">
								<p className="text-[17px] font-bold text-ios-text tabular-nums">{ytHealth.sessions_active ?? 0}</p>
								<p className="text-[10px] text-ios-text-secondary uppercase tracking-wide">Sessões ativas</p>
							</div>
							<div className="rounded-xl bg-ios-background border border-ios-separator p-2">
								<p className={`text-[17px] font-bold ${ytHealth.db_connected ? "text-ios-green" : "text-ios-red"}`}>
									{ytHealth.db_connected ? "OK" : "Falha"}
								</p>
								<p className="text-[10px] text-ios-text-secondary uppercase tracking-wide">Banco remoto</p>
							</div>
							<div className="rounded-xl bg-ios-background border border-ios-separator p-2">
								<p className="text-[13px] font-bold text-ios-text truncate" title={ytHealth.version}>{ytHealth.version || "—"}</p>
								<p className="text-[10px] text-ios-text-secondary uppercase tracking-wide">Versão</p>
							</div>
						</div>
					</div>
				) : (
					<div className="space-y-1">
						<p className="text-sm font-medium text-ios-red flex items-center gap-1.5">
							<XCircle size={15} /> API externa inacessível
						</p>
						<p className="text-[12px] text-ios-text-secondary">
							{ytHealth.error || "A API respondeu com erro — verifique YOUTUBE_API_BASE_URL."}
						</p>
					</div>
				)}
			</IOSCard>

			{/* ── Save bar ── */}
			<div className="sticky bottom-4 flex justify-end">
				<IOSButton
					variant="primary"
					className="flex items-center gap-2"
					onClick={saveSettings}
					disabled={saving}
				>
					{saving ? (
						<RefreshCw size={16} className="animate-spin" />
					) : (
						<Save size={16} />
					)}
					Salvar configurações
				</IOSButton>
			</div>
		</div>
	);
}
