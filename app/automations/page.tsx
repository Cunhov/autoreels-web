"use client";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
    AlertTriangle,
    BarChart3,
    Bot,
    Copy,
    FlaskConical,
    Inbox,
    ListOrdered,
    Loader2,
    Pencil,
    PlayCircle,
    Plus,
    RefreshCw,
    Settings,
    Tags,
    Trash2,
    Users,
    Zap,
} from "lucide-react";
import IOSButton from "@/components/IOSButton";
import { useDialogA11y } from "@/lib/dialog-a11y";
import IOSCard from "@/components/IOSComponents";
import IOSSwitch from "@/components/IOSSwitch";
import IOSToast from "@/components/IOSToast";
import WebhookPanel, {
    OutboundWebhooksPanel,
} from "@/components/ig-automation/WebhookPanel";
import SubstanceManager from "@/components/ig-automation/SubstanceManager";
import SequenceEditor from "@/components/ig-automation/SequenceEditor";
import ContactsPanel from "@/components/ig-automation/ContactsPanel";
import InboxPanel from "@/components/ig-automation/InboxPanel";
import AnalyticsPanel from "@/components/ig-automation/AnalyticsPanel";
import type {
    ChannelLite,
    IgAutomation,
    IgSettings,
} from "@/components/ig-automation/types";
import {
    ApiError,
    TRIGGER_LABELS,
    apiFetch,
    automationToPayload,
    channelLabel,
    extractItems,
    normalizeAutomation,
    normalizeChannel,
    normalizeSettings,
    relativeTime,
} from "@/components/ig-automation/types";

type TabId =
    | "regras"
    | "catalogo"
    | "sequencias"
    | "contatos"
    | "inbox"
    | "relatorios"
    | "config";

const TABS: { id: TabId; label: string; icon: typeof Bot }[] = [
    { id: "regras", label: "Regras", icon: Bot },
    { id: "catalogo", label: "Catálogo", icon: FlaskConical },
    { id: "sequencias", label: "Sequências", icon: ListOrdered },
    { id: "contatos", label: "Contatos", icon: Users },
    { id: "inbox", label: "Inbox", icon: Inbox },
    { id: "relatorios", label: "Relatórios", icon: BarChart3 },
    { id: "config", label: "Config", icon: Settings },
];

// ── Aba Regras ───────────────────────────────────────────────────────────────

function RulesTab({
    onToast,
}: {
    onToast: (msg: string, type?: "success" | "error") => void;
}) {
    const [automations, setAutomations] = useState<IgAutomation[]>([]);
    const [channels, setChannels] = useState<ChannelLite[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [togglingId, setTogglingId] = useState<string | null>(null);
    const [duplicatingId, setDuplicatingId] = useState<string | null>(null);
    const [deletingId, setDeletingId] = useState<string | null>(null);
    const [deleting, setDeleting] = useState(false);
    const deleteDialogRef = useDialogA11y(
        deletingId !== null,
        () => setDeletingId(null),
    );

    const load = useCallback(async () => {
        setLoading(true);
        setError("");
        try {
            const raw = await apiFetch<unknown>("/api/automations");
            setAutomations(
                extractItems(raw, ["automations", "items"]).map((a, i) =>
                    normalizeAutomation(a, i),
                ),
            );
        } catch (e: unknown) {
            if (e instanceof ApiError && e.status === 404) {
                setError(
                    "API de automações ainda não publicada. Disponível após o deploy da onda 1.",
                );
            } else {
                setError(
                    e instanceof Error
                        ? e.message
                        : "Falha ao carregar automações.",
                );
            }
        } finally {
            setLoading(false);
        }
    }, []);

    const loadChannels = useCallback(async () => {
        try {
            const raw = await apiFetch<unknown>("/api/channels");
            setChannels(
                extractItems(raw, ["channels"])
                    .map(normalizeChannel)
                    .filter((c) => c.platform.toLowerCase() === "instagram"),
            );
        } catch {
            /* nome do canal cai no fallback */
        }
    }, []);

    useEffect(() => {
        load();
        loadChannels();
    }, [load, loadChannels]);

    const channelMap = useMemo(() => {
        const map: Record<string, ChannelLite> = {};
        channels.forEach((c) => {
            map[c.id] = c;
        });
        return map;
    }, [channels]);

    function channelName(a: IgAutomation): string {
        if (a.channel) return channelLabel(a.channel);
        const c = channelMap[a.channelId];
        if (c) return channelLabel(c);
        return a.channelId ? `${a.channelId.slice(0, 8)}…` : "Sem canal";
    }

    const grouped = useMemo(() => {
        const map = new Map<string, IgAutomation[]>();
        for (const a of automations) {
            const list = map.get(a.channelId) ?? [];
            list.push(a);
            map.set(a.channelId, list);
        }
        return Array.from(map.entries());
    }, [automations]);

    async function toggle(a: IgAutomation) {
        setTogglingId(a.id);
        try {
            await apiFetch<unknown>(`/api/automations/${a.id}`, {
                method: "PATCH",
                body: JSON.stringify({ enabled: !a.enabled }),
            });
            setAutomations((prev) =>
                prev.map((x) =>
                    x.id === a.id ? { ...x, enabled: !a.enabled } : x,
                ),
            );
            onToast(a.enabled ? "Automação pausada" : "Automação ativada");
        } catch (e: unknown) {
            onToast(
                e instanceof Error
                    ? e.message
                    : "Falha ao atualizar automação.",
                "error",
            );
        } finally {
            setTogglingId(null);
        }
    }

    async function duplicate(a: IgAutomation) {
        setDuplicatingId(a.id);
        try {
            await apiFetch<unknown>("/api/automations", {
                method: "POST",
                body: JSON.stringify({
                    ...automationToPayload(a),
                    name: `${a.name} (cópia)`,
                }),
            });
            onToast("Automação duplicada ✓");
            await load();
        } catch (e: unknown) {
            onToast(
                e instanceof Error
                    ? e.message
                    : "Falha ao duplicar automação.",
                "error",
            );
        } finally {
            setDuplicatingId(null);
        }
    }

    async function confirmDelete() {
        if (!deletingId) return;
        setDeleting(true);
        try {
            await apiFetch<unknown>(`/api/automations/${deletingId}`, {
                method: "DELETE",
            });
            setAutomations((prev) =>
                prev.filter((a) => a.id !== deletingId),
            );
            onToast("Automação excluída");
            setDeletingId(null);
        } catch (e: unknown) {
            onToast(
                e instanceof Error ? e.message : "Falha ao excluir.",
                "error",
            );
        } finally {
            setDeleting(false);
        }
    }

    if (loading) {
        return (
            <div className="flex justify-center p-12">
                <div className="w-8 h-8 border-2 border-ios-blue border-t-transparent rounded-full animate-spin" />
            </div>
        );
    }

    if (error) {
        return (
            <IOSCard className="p-8 text-center">
                <AlertTriangle
                    size={36}
                    className="mx-auto mb-3 text-ios-orange opacity-70"
                />
                <p className="text-[14px] text-ios-text mb-3">{error}</p>
                <IOSButton
                    variant="secondary"
                    className="mx-auto !py-2 !px-4"
                    onClick={load}
                >
                    Tentar de novo
                </IOSButton>
            </IOSCard>
        );
    }

    if (automations.length === 0) {
        return (
            <IOSCard className="p-12 text-center text-ios-text-secondary">
                <Bot
                    size={48}
                    className="mx-auto mb-4 opacity-30"
                    strokeWidth={1}
                />
                <h3 className="text-xl font-semibold mb-2 text-ios-text">
                    Nenhuma automação ainda
                </h3>
                <p className="max-w-sm mx-auto mb-6 text-[13px]">
                    Crie regras para responder comentários e DMs
                    automaticamente, com anti-bloqueio e simulação.
                </p>
                <Link
                    href="/automations/new"
                    className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-ios-blue text-white text-[15px] font-semibold hover:opacity-90"
                >
                    <Plus size={16} /> Nova automação
                </Link>
            </IOSCard>
        );
    }

    return (
        <div className="space-y-6">
            {grouped.map(([channelId, list]) => (
                <div key={channelId || "sem-canal"}>
                    <div className="flex items-center gap-2 mb-2 px-1">
                        <h3 className="text-[14px] font-bold text-ios-text">
                            {channelName(list[0])}
                        </h3>
                        <span className="text-[11px] text-ios-text-secondary">
                            {list.length} regra{list.length !== 1 ? "s" : ""}
                        </span>
                    </div>
                    <div className="space-y-3">
                        {list.map((a) => {
                            const disabled = !a.enabled;
                            return (
                                <IOSCard
                                    key={a.id}
                                    className={`p-4 ${disabled ? "opacity-70" : ""}`}
                                >
                                    <div className="flex items-start gap-3">
                                        <div className="pt-1.5 shrink-0">
                                            <IOSSwitch
                                                checked={a.enabled}
                                                disabled={togglingId === a.id}
                                                onChange={() => toggle(a)}
                                                ariaLabel={`Ativar ${a.name}`}
                                            />
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2 flex-wrap">
                                                <h4 className="text-[15px] font-semibold text-ios-text truncate">
                                                    {a.name}
                                                </h4>
                                                <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-ios-blue/10 text-ios-blue">
                                                    {TRIGGER_LABELS[a.trigger]}
                                                </span>
                                                {a.priority > 0 && (
                                                    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-ios-gray-5 text-ios-text-secondary">
                                                        prio {a.priority}
                                                    </span>
                                                )}
                                            </div>

                                            {/* Keywords */}
                                            <div className="flex flex-wrap gap-1 mt-1.5">
                                                {a.keywords.length === 0 ? (
                                                    <span className="text-[11px] text-ios-text-secondary italic">
                                                        Qualquer texto
                                                    </span>
                                                ) : (
                                                    <>
                                                        {a.keywords
                                                            .slice(0, 6)
                                                            .map((k, i) => (
                                                                <span
                                                                    key={`${k}-${i}`}
                                                                    className="text-[10px] px-1.5 py-0.5 rounded-full bg-ios-gray-5 text-ios-text-secondary"
                                                                >
                                                                    {k}
                                                                </span>
                                                            ))}
                                                        {a.keywords.length >
                                                            6 && (
                                                            <span className="text-[10px] text-ios-text-secondary">
                                                                +
                                                                {a.keywords
                                                                    .length - 6}
                                                            </span>
                                                        )}
                                                    </>
                                                )}
                                            </div>

                                            {/* Stats */}
                                            <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2 text-[11px] tabular-nums">
                                                <span className="text-ios-blue font-semibold">
                                                    {a.statsMatched} matches
                                                </span>
                                                <span className="text-ios-green font-semibold">
                                                    {a.statsSent} enviadas
                                                </span>
                                                {a.statsFailed > 0 && (
                                                    <span className="text-ios-red font-semibold">
                                                        {a.statsFailed} falhas
                                                    </span>
                                                )}
                                                <span className="text-purple-500 font-semibold">
                                                    {a.statsClicks} cliques
                                                </span>
                                                <span className="text-ios-text-secondary">
                                                    {a.actions.length} ação(ões)
                                                </span>
                                                {a.lastRunAt && (
                                                    <span className="text-ios-text-secondary">
                                                        última{" "}
                                                        {relativeTime(
                                                            a.lastRunAt,
                                                        )}
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                    </div>

                                    {/* Ações */}
                                    <div className="flex flex-wrap gap-2 mt-3 pt-3 border-t border-ios-separator">
                                        <Link
                                            href={`/automations/${a.id}?simulate=1`}
                                            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[12px] font-semibold text-purple-500 bg-purple-500/10 hover:bg-purple-500/20"
                                        >
                                            <PlayCircle size={14} /> Testar
                                        </Link>
                                        <Link
                                            href={`/automations/${a.id}`}
                                            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[12px] font-semibold text-ios-blue bg-ios-blue/10 hover:bg-ios-blue/20"
                                        >
                                            <Pencil size={14} /> Editar
                                        </Link>
                                        <button
                                            type="button"
                                            onClick={() => duplicate(a)}
                                            disabled={duplicatingId === a.id}
                                            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[12px] font-semibold text-ios-text-secondary bg-ios-gray-5/60 hover:bg-ios-gray-5 disabled:opacity-40"
                                        >
                                            {duplicatingId === a.id ? (
                                                <Loader2
                                                    size={14}
                                                    className="animate-spin"
                                                />
                                            ) : (
                                                <Copy size={14} />
                                            )}
                                            Duplicar
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() =>
                                                setDeletingId(a.id)
                                            }
                                            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[12px] font-semibold text-ios-red bg-ios-red/10 hover:bg-ios-red/20"
                                        >
                                            <Trash2 size={14} /> Excluir
                                        </button>
                                    </div>
                                </IOSCard>
                            );
                        })}
                    </div>
                </div>
            ))}

            {/* Confirmar exclusão */}
            {deletingId && (
                <div
                    className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
                    role="presentation"
                    onClick={() => { if (!deleting) setDeletingId(null); }}
                >
                    <div
                        role="alertdialog"
                        aria-modal="true"
                        aria-labelledby="delete-automation-title"
                        aria-describedby="delete-automation-description"
                        tabIndex={-1}
                        ref={deleteDialogRef}
                        onClick={(e) => e.stopPropagation()}
                        className="bg-ios-card w-full max-w-sm rounded-2xl shadow-2xl overflow-hidden"
                    >
                        <div className="p-6 text-center">
                            <div className="w-12 h-12 rounded-full bg-ios-red/15 flex items-center justify-center mx-auto mb-4">
                                <Trash2 size={22} className="text-ios-red" />
                            </div>
                            <h3
                                id="delete-automation-title"
                                className="text-[17px] font-bold text-ios-text mb-1"
                            >
                                Excluir automação?
                            </h3>
                            <p id="delete-automation-description" className="text-[14px] text-ios-text-secondary">
                                Esta ação não pode ser desfeita.
                            </p>
                        </div>
                        <div className="border-t border-ios-separator flex">
                            <button
                                type="button"
                                onClick={() => setDeletingId(null)}
                                disabled={deleting}
                                data-autofocus
                                className="flex-1 py-3.5 text-[17px] text-ios-blue font-medium border-r border-ios-separator hover:bg-ios-gray-6 disabled:opacity-40"
                            >
                                Cancelar
                            </button>
                            <button
                                type="button"
                                onClick={confirmDelete}
                                disabled={deleting}
                                className="flex-1 py-3.5 text-[17px] text-ios-red font-semibold hover:bg-ios-red/10 disabled:opacity-40"
                            >
                                {deleting ? "Excluindo…" : "Excluir"}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

// ── Aba Config: limites ──────────────────────────────────────────────────────

function limitValue(
    limits: Record<string, unknown>,
    aliases: string[],
): string {
    for (const k of aliases) {
        const v = limits[k];
        if (v !== undefined && v !== null && v !== "") return String(v);
    }
    return "";
}

function LimitsForm({
    onToast,
}: {
    onToast: (msg: string, type?: "success" | "error") => void;
}) {
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const [cooldown, setCooldown] = useState("");
    const [daily, setDaily] = useState("");
    const [rate, setRate] = useState("");
    const [takeover, setTakeover] = useState("");

    const load = useCallback(async () => {
        setLoading(true);
        setError("");
        try {
            const raw = await apiFetch<unknown>("/api/ig/settings");
            const s: IgSettings = normalizeSettings(raw);
            setCooldown(
                limitValue(s.limits, [
                    "cooldownHours",
                    "cooldown_hours",
                    "ig_cooldown_hours",
                ]),
            );
            setDaily(
                limitValue(s.limits, [
                    "dailyLimitPerContact",
                    "daily_limit_per_contact",
                    "ig_daily_limit_per_contact",
                ]),
            );
            setRate(
                limitValue(s.limits, [
                    "maxSendsPerMinute",
                    "max_sends_per_minute",
                    "ig_max_sends_per_minute",
                ]),
            );
            setTakeover(
                limitValue(s.limits, [
                    "humanTakeoverPauseHours",
                    "human_takeover_pause_hours",
                    "ig_human_takeover_pause_hours",
                ]),
            );
        } catch (e: unknown) {
            setError(
                e instanceof Error
                    ? e.message
                    : "Configuração indisponível.",
            );
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        load();
    }, [load]);

    async function save() {
        setSaving(true);
        try {
            await apiFetch<unknown>("/api/ig/settings", {
                method: "PUT",
                body: JSON.stringify({
                    cooldownHours: cooldown === "" ? null : Number(cooldown),
                    dailyLimitPerContact:
                        daily === "" ? null : Number(daily),
                    maxSendsPerMinute:
                        rate === "" ? null : Number(rate),
                    humanTakeoverPauseHours:
                        takeover === "" ? null : Number(takeover),
                }),
            });
            onToast("Limites salvos ✓");
            await load();
        } catch (e: unknown) {
            onToast(
                e instanceof Error
                    ? e.message
                    : "Falha ao salvar limites.",
                "error",
            );
        } finally {
            setSaving(false);
        }
    }

    const fields = [
        {
            label: "Cooldown por contato (horas)",
            value: cooldown,
            set: setCooldown,
            placeholder: "24",
            hint: "Padrão quando a automação não define o próprio.",
        },
        {
            label: "Limite diário por contato",
            value: daily,
            set: setDaily,
            placeholder: "0 (sem limite)",
            hint: "0 = desativado.",
        },
        {
            label: "Máx. envios por minuto (canal)",
            value: rate,
            set: setRate,
            placeholder: "30",
            hint: "Proteção de rate limit da API do Instagram.",
        },
        {
            label: "Pausa após takeover humano (horas)",
            value: takeover,
            set: setTakeover,
            placeholder: "24",
            hint: "Quando você responde manualmente, o bot pausa para o contato.",
        },
    ];

    return (
        <IOSCard className="p-5">
            <div className="flex items-center justify-between mb-4">
                <div>
                    <h3 className="text-[15px] font-bold text-ios-text">
                        Limites e verificações
                    </h3>
                    <p className="text-[11px] text-ios-text-secondary">
                        Valores globais usados pelo engine anti-bloqueio.
                    </p>
                </div>
                <button
                    type="button"
                    onClick={load}
                    disabled={loading}
                    aria-label="Recarregar limites"
                    className="p-1.5 rounded-lg text-ios-blue hover:bg-ios-blue/10 disabled:opacity-40"
                >
                    <RefreshCw
                        size={15}
                        className={loading ? "animate-spin" : ""}
                    />
                </button>
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
                    {error} Disponível após o deploy da onda 2.
                </p>
            ) : (
                <div className="space-y-3">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {fields.map((f) => (
                            <div key={f.label}>
                                <label className="text-xs font-medium text-ios-text mb-1 block">
                                    {f.label}
                                </label>
                                <input
                                    type="number"
                                    min={0}
                                    value={f.value}
                                    onChange={(e) =>
                                        f.set(e.target.value)
                                    }
                                    placeholder={f.placeholder}
                                    className="w-full bg-ios-background border border-ios-separator rounded-lg p-2 text-sm focus:border-ios-blue outline-none"
                                />
                                <p className="text-[10px] text-ios-text-secondary mt-1">
                                    {f.hint}
                                </p>
                            </div>
                        ))}
                    </div>
                    <div className="flex justify-end">
                        <IOSButton
                            variant="primary"
                            className="!py-2 !px-4 flex items-center gap-1"
                            onClick={save}
                            disabled={saving}
                        >
                            {saving ? (
                                <Loader2
                                    size={15}
                                    className="animate-spin"
                                />
                            ) : (
                                <Zap size={15} />
                            )}
                            Salvar limites
                        </IOSButton>
                    </div>
                </div>
            )}
        </IOSCard>
    );
}

// ── Página ───────────────────────────────────────────────────────────────────

function AutomationsContent() {
    const searchParams = useSearchParams();
    const router = useRouter();
    const tabParam = searchParams.get("tab");
    const tab: TabId = (TABS.some((t) => t.id === tabParam)
        ? tabParam
        : "regras") as TabId;

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

    function setTab(id: TabId) {
        router.replace(`/automations?tab=${id}`, { scroll: false });
    }

    return (
        <div className="space-y-5 pb-8">
            <IOSToast
                message={toast?.msg ?? ""}
                type={toast?.type}
                isVisible={toast !== null}
                onClose={closeToast}
            />

            {/* Header */}
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                <div>
                    <h1 className="text-[28px] sm:text-[34px] font-bold text-ios-text flex items-center gap-2">
                        <Bot size={28} className="text-ios-blue" />
                        Automações
                    </h1>
                    <p className="text-ios-text-secondary text-sm">
                        Respostas automáticas para comentários e DMs do
                        Instagram
                    </p>
                </div>
                <Link
                    href="/automations/new"
                    className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-ios-blue text-white text-[15px] font-semibold hover:opacity-90 active:opacity-75 shrink-0 self-start"
                >
                    <Plus size={16} /> Nova automação
                </Link>
            </div>

            {/* Webhook + configuração Meta (header) */}
            <WebhookPanel compact />

            {/* Abas */}
            <div
                role="tablist"
                aria-label="Seções de automações"
                className="flex gap-1 overflow-x-auto pb-1 border-b border-ios-separator"
            >
                {TABS.map((t) => {
                    const active = tab === t.id;
                    return (
                        <button
                            key={t.id}
                            type="button"
                            role="tab"
                            aria-selected={active}
                            onClick={() => setTab(t.id)}
                            className={`flex items-center gap-1.5 px-3 py-2 text-[13px] font-semibold whitespace-nowrap rounded-t-xl border-b-2 transition-colors ${
                                active
                                    ? "text-ios-blue border-ios-blue"
                                    : "text-ios-text-secondary border-transparent hover:text-ios-text"
                            }`}
                        >
                            <t.icon size={15} />
                            {t.label}
                        </button>
                    );
                })}
            </div>

            {/* Conteúdo da aba */}
            {tab === "regras" && <RulesTab onToast={showToast} />}
            {tab === "catalogo" && <SubstanceManager />}
            {tab === "sequencias" && <SequenceEditor />}
            {tab === "contatos" && <ContactsPanel />}
            {tab === "inbox" && <InboxPanel />}
            {tab === "relatorios" && <AnalyticsPanel />}
            {tab === "config" && (
                <div className="space-y-4">
                    <WebhookPanel />
                    <LimitsForm onToast={showToast} />
                    <OutboundWebhooksPanel />
                    <p className="text-[11px] text-ios-text-secondary flex items-center gap-1">
                        <Tags size={11} /> Dica: o token do webhook é exibido
                        mascarado; use “Mostrar” para conferir antes de colar no
                        painel Meta.
                    </p>
                </div>
            )}
        </div>
    );
}

export default function AutomationsPage() {
    return (
        <Suspense
            fallback={
                <div className="flex justify-center p-12">
                    <div className="w-8 h-8 border-2 border-ios-blue border-t-transparent rounded-full animate-spin" />
                </div>
            }
        >
            <AutomationsContent />
        </Suspense>
    );
}
