"use client";
import { useCallback, useEffect, useState } from "react";
import {
    AlertTriangle,
    Check,
    CheckCircle2,
    ChevronDown,
    ChevronUp,
    Copy,
    KeyRound,
    Loader2,
    Plus,
    RefreshCw,
    Send,
    Trash2,
    Webhook,
    X,
    XCircle,
} from "lucide-react";
import IOSButton from "@/components/IOSButton";
import IOSCard from "@/components/IOSComponents";
import IOSSwitch from "@/components/IOSSwitch";
import IOSToast from "@/components/IOSToast";
import type {
    ChannelLite,
    IgOutboundWebhook,
    IgSettings,
    WebhookStatus,
} from "./types";
import {
    OUTBOUND_EVENTS,
    apiFetch,
    asString,
    channelLabel,
    extractItems,
    formatDateTime,
    isRecord,
    normalizeChannel,
    normalizeOutboundWebhook,
    normalizeSettings,
    normalizeWebhookStatus,
} from "./types";

const inputCls =
    "w-full bg-ios-background border border-ios-separator rounded-lg p-2 text-sm focus:border-ios-blue outline-none placeholder:text-gray-400";

const STATUS_META: Record<
    string,
    { label: string; cls: string; icon: typeof CheckCircle2 }
> = {
    ok: {
        label: "Assinado",
        cls: "bg-ios-green/15 text-ios-green",
        icon: CheckCircle2,
    },
    partial: {
        label: "Parcial",
        cls: "bg-ios-orange/15 text-ios-orange",
        icon: AlertTriangle,
    },
    missing: {
        label: "Não assinado",
        cls: "bg-ios-red/15 text-ios-red",
        icon: XCircle,
    },
    token_invalid: {
        label: "Token inválido",
        cls: "bg-ios-red/15 text-ios-red",
        icon: XCircle,
    },
    error: {
        label: "Erro",
        cls: "bg-ios-red/15 text-ios-red",
        icon: XCircle,
    },
    unknown: {
        label: "Desconhecido",
        cls: "bg-ios-gray-5 text-ios-text-secondary",
        icon: AlertTriangle,
    },
};

function CopyButton({
    value,
    label,
    onCopied,
}: {
    value: string;
    label: string;
    onCopied?: (msg: string) => void;
}) {
    const [copied, setCopied] = useState(false);
    async function copy() {
        try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            onCopied?.(`${label} copiado ✓`);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            onCopied?.("Não foi possível copiar — copie manualmente.");
        }
    }
    return (
        <button
            type="button"
            onClick={copy}
            aria-label={`Copiar ${label}`}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[12px] font-semibold text-ios-blue bg-ios-blue/10 hover:bg-ios-blue/20 transition-colors shrink-0"
        >
            {copied ? <Check size={13} /> : <Copy size={13} />}
            {copied ? "Copiado" : "Copiar"}
        </button>
    );
}

interface WebhookPanelProps {
    compact?: boolean;
}

/**
 * Status do webhook por canal + configuração Meta + toggles globais.
 * Usado no header do dashboard e na aba Config.
 */
export default function WebhookPanel({ compact = false }: WebhookPanelProps) {
    const [statuses, setStatuses] = useState<WebhookStatus[]>([]);
    const [statusLoading, setStatusLoading] = useState(true);
    const [statusError, setStatusError] = useState("");
    const [resubscribing, setResubscribing] = useState<string | null>(null);

    const [settings, setSettings] = useState<IgSettings | null>(null);
    const [settingsError, setSettingsError] = useState("");
    const [settingsLoading, setSettingsLoading] = useState(true);
    const [showToken, setShowToken] = useState(false);
    const [regenerating, setRegenerating] = useState(false);
    const [toggling, setToggling] = useState(false);
    const [metaOpen, setMetaOpen] = useState(!compact);

    const [toast, setToast] = useState<{
        msg: string;
        type: "success" | "error";
    } | null>(null);
    const closeToast = useCallback(() => setToast(null), []);
    const showToast = useCallback(
        (msg: string, type: "success" | "error" = "success") =>
            setToast({ msg, type }),
        [],
    );

    const loadSettings = useCallback(async () => {
        setSettingsLoading(true);
        try {
            const raw = await apiFetch<unknown>("/api/ig/settings");
            setSettings(normalizeSettings(raw));
            setSettingsError("");
        } catch (e: unknown) {
            setSettings(null);
            setSettingsError(
                e instanceof Error
                    ? e.message
                    : "Configuração indisponível.",
            );
        } finally {
            setSettingsLoading(false);
        }
    }, []);

    const loadStatuses = useCallback(async () => {
        setStatusLoading(true);
        try {
            const raw = await apiFetch<unknown>("/api/ig/webhook-status");
            setStatuses(
                extractItems(raw, ["channels", "items", "statuses"]).map(
                    normalizeWebhookStatus,
                ),
            );
            setStatusError("");
        } catch (e: unknown) {
            setStatuses([]);
            setStatusError(
                e instanceof Error
                    ? e.message
                    : "Status do webhook indisponível.",
            );
        } finally {
            setStatusLoading(false);
        }
    }, []);

    useEffect(() => {
        loadStatuses();
        loadSettings();
    }, [loadStatuses, loadSettings]);

    async function resubscribe(channelId: string) {
        setResubscribing(channelId);
        try {
            await apiFetch<unknown>("/api/ig/webhook-status", {
                method: "POST",
                body: JSON.stringify({ channelId }),
            });
            showToast("Webhook re-assinado ✓");
            await loadStatuses();
        } catch (e: unknown) {
            showToast(
                e instanceof Error
                    ? e.message
                    : "Falha ao re-assinar o webhook.",
                "error",
            );
        } finally {
            setResubscribing(null);
        }
    }

    async function regenerateToken() {
        if (
            !window.confirm(
                "Gerar um novo verify token? Você precisará atualizar o valor no painel Meta.",
            )
        )
            return;
        setRegenerating(true);
        try {
            const raw = await apiFetch<unknown>("/api/ig/settings", {
                method: "POST",
                body: JSON.stringify({ action: "regenerate-token" }),
            });
            const rec = isRecord(raw) ? raw : {};
            const newToken = asString(
                rec.verifyToken ?? rec.verify_token ?? rec.token,
            );
            if (newToken && settings) {
                setSettings({ ...settings, verifyToken: newToken });
                setShowToken(true);
            } else {
                await loadSettings();
            }
            showToast("Novo verify token gerado ✓");
        } catch (e: unknown) {
            showToast(
                e instanceof Error
                    ? e.message
                    : "Falha ao gerar novo token.",
                "error",
            );
        } finally {
            setRegenerating(false);
        }
    }

    async function toggleEnabled() {
        if (!settings) return;
        setToggling(true);
        try {
            await apiFetch<unknown>("/api/ig/settings", {
                method: "POST",
                body: JSON.stringify({ action: "toggle-enabled" }),
            });
            const next = !settings.enabled;
            setSettings({ ...settings, enabled: next });
            showToast(
                next
                    ? "Automações ativadas globalmente ✓"
                    : "Automações desativadas globalmente",
            );
        } catch (e: unknown) {
            showToast(
                e instanceof Error ? e.message : "Falha ao alternar.",
                "error",
            );
        } finally {
            setToggling(false);
        }
    }

    async function toggleDryRun(next: boolean) {
        if (!settings) return;
        setToggling(true);
        try {
            await apiFetch<unknown>("/api/ig/settings", {
                method: "PUT",
                body: JSON.stringify({ dryRun: next }),
            });
            setSettings({ ...settings, dryRun: next });
            showToast(
                next
                    ? "Dry-run ativado — ações serão apenas registradas"
                    : "Dry-run desativado",
            );
        } catch (e: unknown) {
            showToast(
                e instanceof Error ? e.message : "Falha ao salvar dry-run.",
                "error",
            );
        } finally {
            setToggling(false);
        }
    }

    return (
        <div className="space-y-4">
            <IOSToast
                message={toast?.msg ?? ""}
                type={toast?.type}
                isVisible={toast !== null}
                onClose={closeToast}
            />

            {/* Toggles globais */}
            <IOSCard className="p-4">
                <div className="flex flex-col sm:flex-row sm:items-center gap-4">
                    <div className="flex items-center justify-between gap-4 flex-1">
                        <div>
                            <p className="text-[14px] font-semibold text-ios-text flex items-center gap-1.5">
                                <Webhook size={15} className="text-ios-blue" />
                                Automações globais
                            </p>
                            <p className="text-[11px] text-ios-text-secondary">
                                Desligar mantém o webhook gravando eventos sem
                                processar.
                            </p>
                        </div>
                        {settingsLoading ? (
                            <Loader2
                                size={18}
                                className="animate-spin text-ios-text-secondary"
                            />
                        ) : (
                            <IOSSwitch
                                checked={settings?.enabled ?? true}
                                disabled={toggling || !settings}
                                onChange={toggleEnabled}
                                ariaLabel="Ativar automações globalmente"
                            />
                        )}
                    </div>
                    <div className="hidden sm:block w-px h-10 bg-ios-separator" />
                    <div className="flex items-center justify-between gap-4 flex-1">
                        <div>
                            <p className="text-[14px] font-semibold text-ios-text">
                                Dry-run
                            </p>
                            <p className="text-[11px] text-ios-text-secondary">
                                Loga as ações sem chamar a API do Instagram.
                            </p>
                        </div>
                        {settingsLoading ? (
                            <Loader2
                                size={18}
                                className="animate-spin text-ios-text-secondary"
                            />
                        ) : (
                            <IOSSwitch
                                checked={settings?.dryRun ?? false}
                                disabled={toggling || !settings}
                                onChange={(next) => toggleDryRun(next)}
                                ariaLabel="Ativar dry-run"
                            />
                        )}
                    </div>
                </div>
            </IOSCard>

            {/* Status por canal */}
            <IOSCard className="p-4">
                <div className="flex items-center justify-between mb-3">
                    <h3 className="text-[15px] font-bold text-ios-text">
                        Saúde do webhook por canal
                    </h3>
                    <button
                        type="button"
                        onClick={loadStatuses}
                        disabled={statusLoading}
                        aria-label="Atualizar status do webhook"
                        className="p-1.5 rounded-lg text-ios-blue hover:bg-ios-blue/10 disabled:opacity-40"
                    >
                        <RefreshCw
                            size={15}
                            className={statusLoading ? "animate-spin" : ""}
                        />
                    </button>
                </div>

                {statusLoading ? (
                    <div className="flex items-center justify-center py-6 text-ios-text-secondary text-[13px]">
                        <Loader2 size={16} className="animate-spin mr-2" />
                        Verificando assinaturas…
                    </div>
                ) : statusError ? (
                    <div className="p-3 rounded-xl bg-ios-orange/10 border border-ios-orange/30 text-[12px] text-ios-orange">
                        {statusError} Não foi possível verificar o status dos
                        canais agora.
                    </div>
                ) : statuses.length === 0 ? (
                    <p className="py-4 text-center text-[13px] text-ios-text-secondary">
                        Nenhum canal do Instagram conectado.
                    </p>
                ) : (
                    <div
                        className={
                            compact
                                ? "flex gap-3 overflow-x-auto pb-1"
                                : "grid grid-cols-1 sm:grid-cols-2 gap-3"
                        }
                    >
                        {statuses.map((s) => {
                            const meta =
                                STATUS_META[s.status] ??
                                STATUS_META.unknown;
                            const Icon = meta.icon;
                            return (
                                <div
                                    key={s.channelId}
                                    className={`p-3 rounded-xl border border-ios-separator bg-ios-background ${
                                        compact
                                            ? "min-w-[240px] shrink-0"
                                            : ""
                                    }`}
                                >
                                    <div className="flex items-center gap-2">
                                        <span className="flex-1 min-w-0 text-[13px] font-semibold text-ios-text truncate">
                                            {s.username
                                                ? `@${s.username}`
                                                : s.name || s.channelId}
                                        </span>
                                        <span
                                            className={`flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded-full uppercase shrink-0 ${meta.cls}`}
                                        >
                                            <Icon size={10} />
                                            {meta.label}
                                        </span>
                                    </div>
                                    {s.subscribedFields.length > 0 && (
                                        <p className="text-[10px] text-ios-text-secondary mt-1">
                                            Campos:{" "}
                                            {s.subscribedFields.join(", ")}
                                        </p>
                                    )}
                                    <div className="flex items-center justify-between gap-2 mt-2">
                                        <span className="text-[10px] text-ios-text-secondary truncate">
                                            {s.lastCheckedAt
                                                ? `Checado ${formatDateTime(s.lastCheckedAt)}`
                                                : "Nunca checado"}
                                        </span>
                                        <button
                                            type="button"
                                            onClick={() =>
                                                resubscribe(s.channelId)
                                            }
                                            disabled={
                                                resubscribing === s.channelId
                                            }
                                            className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold text-ios-blue bg-ios-blue/10 hover:bg-ios-blue/20 disabled:opacity-40 shrink-0"
                                        >
                                            {resubscribing ===
                                            s.channelId ? (
                                                <Loader2
                                                    size={11}
                                                    className="animate-spin"
                                                />
                                            ) : (
                                                <Send size={11} />
                                            )}
                                            Re-assinar
                                        </button>
                                    </div>
                                    {s.lastError && (
                                        <p className="text-[10px] text-ios-red mt-1 break-words">
                                            {s.lastError}
                                        </p>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
            </IOSCard>

            {/* Configuração Meta */}
            <IOSCard className="p-4">
                <button
                    type="button"
                    onClick={() => setMetaOpen((v) => !v)}
                    aria-expanded={metaOpen}
                    className="w-full flex items-center gap-2 text-left"
                >
                    <div className="w-9 h-9 rounded-xl bg-ios-blue/10 flex items-center justify-center text-ios-blue shrink-0">
                        <KeyRound size={18} />
                    </div>
                    <div className="flex-1 min-w-0">
                        <h3 className="text-[15px] font-bold text-ios-text">
                            Configuração Meta
                        </h3>
                        <p className="text-[11px] text-ios-text-secondary">
                            URL de callback e verify token do webhook
                        </p>
                    </div>
                    {metaOpen ? (
                        <ChevronUp
                            size={18}
                            className="text-ios-text-secondary"
                        />
                    ) : (
                        <ChevronDown
                            size={18}
                            className="text-ios-text-secondary"
                        />
                    )}
                </button>

                {metaOpen &&
                    (settingsLoading ? (
                        <div className="flex items-center justify-center py-6 text-ios-text-secondary text-[13px]">
                            <Loader2 size={16} className="animate-spin mr-2" />
                            Carregando configuração…
                        </div>
                    ) : settingsError || !settings ? (
                        <div className="mt-4 p-3 rounded-xl bg-ios-orange/10 border border-ios-orange/30 text-[12px] text-ios-orange">
                            {settingsError || "Configuração indisponível."}{" "}
                            Tente novamente em instantes.
                        </div>
                    ) : (
                        <div className="mt-4 space-y-4">
                            <div>
                                <label className="text-xs font-medium text-ios-text mb-1 block">
                                    Callback URL
                                </label>
                                <div className="flex items-center gap-2">
                                    <input
                                        readOnly
                                        value={settings.webhookUrl}
                                        aria-label="URL do webhook"
                                        className={`${inputCls} font-mono`}
                                    />
                                    <CopyButton
                                        value={settings.webhookUrl}
                                        label="URL"
                                        onCopied={showToast}
                                    />
                                </div>
                            </div>
                            <div>
                                <label className="text-xs font-medium text-ios-text mb-1 block">
                                    Verify token
                                    {settings.envOverride && (
                                        <span className="ml-2 text-[10px] text-ios-orange font-normal">
                                            definido por variável de ambiente
                                        </span>
                                    )}
                                </label>
                                <div className="flex items-center gap-2">
                                    <input
                                        readOnly
                                        type={showToken ? "text" : "password"}
                                        value={settings.verifyToken}
                                        aria-label="Verify token"
                                        className={`${inputCls} font-mono`}
                                    />
                                    <button
                                        type="button"
                                        onClick={() =>
                                            setShowToken((v) => !v)
                                        }
                                        className="px-2.5 py-1.5 rounded-lg text-[12px] font-semibold text-ios-text-secondary bg-ios-gray-5 hover:bg-ios-gray-4 transition-colors shrink-0"
                                    >
                                        {showToken ? "Ocultar" : "Mostrar"}
                                    </button>
                                    <CopyButton
                                        value={settings.verifyToken}
                                        label="Token"
                                        onCopied={showToast}
                                    />
                                </div>
                                <button
                                    type="button"
                                    onClick={regenerateToken}
                                    disabled={
                                        regenerating || settings.envOverride
                                    }
                                    className="mt-2 flex items-center gap-1 text-[12px] font-semibold text-ios-blue hover:underline disabled:opacity-40"
                                >
                                    {regenerating ? (
                                        <Loader2
                                            size={13}
                                            className="animate-spin"
                                        />
                                    ) : (
                                        <KeyRound size={13} />
                                    )}
                                    Gerar novo token
                                </button>
                            </div>
                            <div className="p-3 rounded-xl bg-ios-gray-6/80 text-[12px] text-ios-text-secondary space-y-1">
                                <p className="font-semibold text-ios-text">
                                    Onde colar no painel Meta
                                </p>
                                <p>
                                    1. developers.facebook.com → seu app →
                                    Instagram → Webhooks.
                                </p>
                                <p>
                                    2. Cole a Callback URL e o Verify token
                                    acima e clique em Verificar.
                                </p>
                                <p>
                                    3. Assine os campos{" "}
                                    <code className="font-mono">
                                        comments
                                    </code>
                                    ,{" "}
                                    <code className="font-mono">
                                        messages
                                    </code>{" "}
                                    e{" "}
                                    <code className="font-mono">
                                        messaging_postbacks
                                    </code>
                                    .
                                </p>
                            </div>
                        </div>
                    ))}
            </IOSCard>
        </div>
    );
}

// ── Webhooks de saída (CRUD) ─────────────────────────────────────────────────

interface OutboundForm {
    name: string;
    url: string;
    secret: string;
    events: string[];
    enabled: boolean;
    channelId: string;
}

const emptyOutbound: OutboundForm = {
    name: "",
    url: "",
    secret: "",
    events: ["action.sent", "action.failed"],
    enabled: true,
    channelId: "",
};

export function OutboundWebhooksPanel() {
    const [items, setItems] = useState<IgOutboundWebhook[]>([]);
    const [channels, setChannels] = useState<ChannelLite[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [modalOpen, setModalOpen] = useState(false);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [form, setForm] = useState<OutboundForm>(emptyOutbound);
    const [saving, setSaving] = useState(false);
    const [deletingId, setDeletingId] = useState<string | null>(null);

    const [toast, setToast] = useState<{
        msg: string;
        type: "success" | "error";
    } | null>(null);
    const closeToast = useCallback(() => setToast(null), []);
    const showToast = useCallback(
        (msg: string, type: "success" | "error" = "success") =>
            setToast({ msg, type }),
        [],
    );

    const load = useCallback(async () => {
        setLoading(true);
        setError("");
        try {
            const raw = await apiFetch<unknown>(
                "/api/ig/outbound-webhooks",
            );
            setItems(
                extractItems(raw, ["webhooks", "items"]).map(
                    normalizeOutboundWebhook,
                ),
            );
        } catch (e: unknown) {
            setError(
                e instanceof Error
                    ? e.message
                    : "Falha ao carregar webhooks de saída.",
            );
        } finally {
            setLoading(false);
        }
        try {
            const rawCh = await apiFetch<unknown>("/api/channels");
            setChannels(
                extractItems(rawCh, ["channels"])
                    .map(normalizeChannel)
                    .filter((c) => c.platform.toLowerCase() === "instagram"),
            );
        } catch {
            /* opcional */
        }
    }, []);

    useEffect(() => {
        load();
    }, [load]);

    function openCreate() {
        setEditingId(null);
        setForm(emptyOutbound);
        setModalOpen(true);
    }

    function openEdit(w: IgOutboundWebhook) {
        setEditingId(w.id);
        setForm({
            name: w.name,
            url: w.url,
            secret: "",
            events: w.events,
            enabled: w.enabled,
            channelId: w.channelId,
        });
        setModalOpen(true);
    }

    async function save() {
        if (!form.name.trim() || !form.url.trim()) {
            showToast("Informe nome e URL do webhook.", "error");
            return;
        }
        setSaving(true);
        try {
            const body: Record<string, unknown> = {
                name: form.name.trim(),
                url: form.url.trim(),
                events: form.events,
                enabled: form.enabled,
                channelId: form.channelId || null,
            };
            if (form.secret.trim()) body.secret = form.secret.trim();
            if (editingId) {
                await apiFetch<unknown>(
                    `/api/ig/outbound-webhooks/${editingId}`,
                    { method: "PATCH", body: JSON.stringify(body) },
                );
                showToast("Webhook atualizado ✓");
            } else {
                await apiFetch<unknown>("/api/ig/outbound-webhooks", {
                    method: "POST",
                    body: JSON.stringify(body),
                });
                showToast("Webhook criado ✓");
            }
            setModalOpen(false);
            load();
        } catch (e: unknown) {
            showToast(
                e instanceof Error ? e.message : "Falha ao salvar webhook.",
                "error",
            );
        } finally {
            setSaving(false);
        }
    }

    async function remove(w: IgOutboundWebhook) {
        if (!window.confirm(`Excluir o webhook "${w.name}"?`)) return;
        setDeletingId(w.id);
        try {
            await apiFetch<unknown>(
                `/api/ig/outbound-webhooks/${w.id}`,
                { method: "DELETE" },
            );
            setItems((prev) => prev.filter((x) => x.id !== w.id));
            showToast("Webhook excluído");
        } catch (e: unknown) {
            showToast(
                e instanceof Error ? e.message : "Falha ao excluir.",
                "error",
            );
        } finally {
            setDeletingId(null);
        }
    }

    function toggleEvent(ev: string) {
        setForm((f) => ({
            ...f,
            events: f.events.includes(ev)
                ? f.events.filter((e) => e !== ev)
                : [...f.events, ev],
        }));
    }

    return (
        <IOSCard className="p-4 space-y-3">
            <IOSToast
                message={toast?.msg ?? ""}
                type={toast?.type}
                isVisible={toast !== null}
                onClose={closeToast}
            />
            <div className="flex items-center justify-between">
                <div>
                    <h3 className="text-[15px] font-bold text-ios-text">
                        Webhooks de saída
                    </h3>
                    <p className="text-[11px] text-ios-text-secondary">
                        Notifique n8n, planilhas ou CRM com assinatura HMAC.
                    </p>
                </div>
                <IOSButton
                    variant="secondary"
                    className="!py-1.5 !px-3 !text-[13px] flex items-center gap-1"
                    onClick={openCreate}
                >
                    <Plus size={14} /> Novo
                </IOSButton>
            </div>

            {loading ? (
                <div className="flex justify-center py-6">
                    <Loader2
                        size={18}
                        className="animate-spin text-ios-text-secondary"
                    />
                </div>
            ) : error ? (
                <p className="p-3 rounded-xl bg-ios-orange/10 border border-ios-orange/30 text-[12px] text-ios-orange">
                    {error} Tente novamente em instantes.
                </p>
            ) : items.length === 0 ? (
                <p className="py-4 text-center text-[13px] text-ios-text-secondary">
                    Nenhum webhook de saída configurado.
                </p>
            ) : (
                <div className="space-y-2">
                    {items.map((w) => {
                        const ch = channels.find(
                            (c) => c.id === w.channelId,
                        );
                        return (
                            <div
                                key={w.id}
                                className="flex items-center gap-3 p-3 rounded-xl border border-ios-separator bg-ios-background"
                            >
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2">
                                        <span className="text-[13px] font-semibold text-ios-text truncate">
                                            {w.name}
                                        </span>
                                        <span
                                            className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full uppercase ${
                                                w.enabled
                                                    ? "bg-ios-green/15 text-ios-green"
                                                    : "bg-ios-gray-5 text-ios-text-secondary"
                                            }`}
                                        >
                                            {w.enabled
                                                ? "ativo"
                                                : "inativo"}
                                        </span>
                                    </div>
                                    <p className="text-[11px] text-ios-text-secondary font-mono truncate">
                                        {w.url}
                                    </p>
                                    <p className="text-[10px] text-ios-text-secondary mt-0.5">
                                        {w.events.length} evento(s)
                                        {ch
                                            ? ` · ${channelLabel(ch)}`
                                            : " · todos os canais"}
                                        {w.hasSecret
                                            ? " · segredo configurado"
                                            : ""}
                                    </p>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => openEdit(w)}
                                    aria-label={`Editar ${w.name}`}
                                    className="p-2 rounded-lg text-ios-blue hover:bg-ios-blue/10 shrink-0"
                                >
                                    <Check size={15} />
                                </button>
                                <button
                                    type="button"
                                    onClick={() => remove(w)}
                                    disabled={deletingId === w.id}
                                    aria-label={`Excluir ${w.name}`}
                                    className="p-2 rounded-lg text-ios-red hover:bg-ios-red/10 disabled:opacity-40 shrink-0"
                                >
                                    {deletingId === w.id ? (
                                        <Loader2
                                            size={15}
                                            className="animate-spin"
                                        />
                                    ) : (
                                        <Trash2 size={15} />
                                    )}
                                </button>
                            </div>
                        );
                    })}
                </div>
            )}

            {/* Modal */}
            {modalOpen && (
                <div
                    className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
                    role="presentation"
                    onClick={() => setModalOpen(false)}
                >
                    <div
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="outbound-modal-title"
                        onClick={(e) => e.stopPropagation()}
                        className="bg-ios-card w-full max-w-lg max-h-[85dvh] rounded-3xl shadow-2xl flex flex-col overflow-hidden"
                    >
                        <div className="p-4 border-b border-ios-separator flex items-center justify-between">
                            <h2
                                id="outbound-modal-title"
                                className="text-[17px] font-bold text-ios-text"
                            >
                                {editingId
                                    ? "Editar webhook"
                                    : "Novo webhook de saída"}
                            </h2>
                            <button
                                type="button"
                                onClick={() => setModalOpen(false)}
                                aria-label="Fechar"
                                className="p-2 rounded-full text-ios-text-secondary hover:bg-ios-gray-5"
                            >
                                <X size={18} />
                            </button>
                        </div>
                        <div className="flex-1 overflow-y-auto p-4 space-y-3">
                            <div>
                                <label className="text-xs font-medium text-ios-text mb-1 block">
                                    Nome *
                                </label>
                                <input
                                    value={form.name}
                                    onChange={(e) =>
                                        setForm({
                                            ...form,
                                            name: e.target.value,
                                        })
                                    }
                                    placeholder="Ex.: n8n leads"
                                    className={inputCls}
                                />
                            </div>
                            <div>
                                <label className="text-xs font-medium text-ios-text mb-1 block">
                                    URL *
                                </label>
                                <input
                                    type="url"
                                    value={form.url}
                                    onChange={(e) =>
                                        setForm({
                                            ...form,
                                            url: e.target.value,
                                        })
                                    }
                                    placeholder="https://…"
                                    className={`${inputCls} font-mono`}
                                />
                            </div>
                            <div>
                                <label className="text-xs font-medium text-ios-text mb-1 block">
                                    Segredo (HMAC)
                                </label>
                                <input
                                    type="password"
                                    value={form.secret}
                                    onChange={(e) =>
                                        setForm({
                                            ...form,
                                            secret: e.target.value,
                                        })
                                    }
                                    placeholder={
                                        editingId
                                            ? "Deixe vazio para manter"
                                            : "Opcional, usado na assinatura"
                                    }
                                    className={`${inputCls} font-mono`}
                                />
                            </div>
                            <div>
                                <label className="text-xs font-medium text-ios-text mb-1 block">
                                    Canal (opcional)
                                </label>
                                <select
                                    value={form.channelId}
                                    onChange={(e) =>
                                        setForm({
                                            ...form,
                                            channelId: e.target.value,
                                        })
                                    }
                                    className={inputCls}
                                >
                                    <option value="">
                                        Todos os canais
                                    </option>
                                    {channels.map((c) => (
                                        <option key={c.id} value={c.id}>
                                            {channelLabel(c)}
                                        </option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <p className="text-xs font-medium text-ios-text mb-1.5">
                                    Eventos
                                </p>
                                <div className="flex flex-wrap gap-1.5">
                                    {OUTBOUND_EVENTS.map((ev) => {
                                        const on = form.events.includes(ev);
                                        return (
                                            <button
                                                key={ev}
                                                type="button"
                                                onClick={() => toggleEvent(ev)}
                                                aria-pressed={on}
                                                className={`px-2.5 py-1 rounded-full text-[11px] font-mono border transition-colors ${
                                                    on
                                                        ? "bg-ios-blue text-white border-ios-blue"
                                                        : "border-ios-separator text-ios-text-secondary hover:bg-ios-gray-5"
                                                }`}
                                            >
                                                {ev}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                            <div className="flex items-center justify-between p-2">
                                <span className="text-sm font-medium text-ios-text">
                                    Ativo
                                </span>
                                <IOSSwitch
                                    checked={form.enabled}
                                    onChange={(enabled) =>
                                        setForm({ ...form, enabled })
                                    }
                                    ariaLabel="Webhook ativo"
                                />
                            </div>
                        </div>
                        <div className="border-t border-ios-separator flex">
                            <button
                                type="button"
                                onClick={() => setModalOpen(false)}
                                className="flex-1 py-3.5 text-[16px] text-ios-blue font-medium border-r border-ios-separator hover:bg-ios-gray-6"
                            >
                                Cancelar
                            </button>
                            <button
                                type="button"
                                onClick={save}
                                disabled={saving}
                                className="flex-1 py-3.5 text-[16px] text-ios-blue font-semibold hover:bg-ios-blue/5 disabled:opacity-40"
                            >
                                {saving ? "Salvando…" : "Salvar"}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </IOSCard>
    );
}
