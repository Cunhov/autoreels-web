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
    WebhookStatus,
} from "@/components/ig-automation/types";
import {
    ACTION_TYPE_LABELS,
    TRIGGER_LABELS,
    apiFetch,
    automationToPayload,
    channelLabel,
    extractItems,
    normalizeAutomation,
    normalizeChannel,
    normalizeSettings,
    normalizeWebhookStatus,
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

function RulesTab({ onToast }: { onToast: (msg: string, type?: "success" | "error") => void }) {
    const [automations, setAutomations] = useState<IgAutomation[]>([]);
    const [channels, setChannels] = useState<ChannelLite[]>([]);
    const [dryRun, setDryRun] = useState<boolean | null>(null);
    const [globalEnabled, setGlobalEnabled] = useState<boolean | null>(null);
    const [webhookStatuses, setWebhookStatuses] = useState<Record<string, WebhookStatus["status"]>>({});
    const [search, setSearch] = useState("");
    const [channelFilter, setChannelFilter] = useState("");
    const [statusFilter, setStatusFilter] = useState<"all" | "active" | "paused" | "test">("all");
    const [visibleCount, setVisibleCount] = useState(12);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [togglingId, setTogglingId] = useState<string | null>(null);
    const [duplicatingId, setDuplicatingId] = useState<string | null>(null);
    const [deletingId, setDeletingId] = useState<string | null>(null);
    const [deleting, setDeleting] = useState(false);
    const deleteDialogRef = useDialogA11y(deletingId !== null, () => setDeletingId(null));

    const load = useCallback(async () => {
        setLoading(true);
        setError("");
        try {
            const raw = await apiFetch<unknown>("/api/automations?grouped=1");
            setAutomations(extractItems(raw, ["automations", "items"]).map((a, i) => normalizeAutomation(a, i)));
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : "Falha ao carregar automações.");
        } finally {
            setLoading(false);
        }
    }, []);

    const loadAuxiliary = useCallback(async () => {
        const [channelsResult, settingsResult, statusesResult] = await Promise.allSettled([
            apiFetch<unknown>("/api/channels"),
            apiFetch<unknown>("/api/ig/settings"),
            apiFetch<unknown>("/api/ig/webhook-status"),
        ]);
        if (channelsResult.status === "fulfilled") setChannels(extractItems(channelsResult.value, ["channels"]).map(normalizeChannel).filter((c) => c.platform.toLowerCase() === "instagram"));
        if (settingsResult.status === "fulfilled") {
            const settings = normalizeSettings(settingsResult.value);
            setDryRun(settings.dryRun);
            setGlobalEnabled(settings.enabled);
        } else { setDryRun(null); setGlobalEnabled(null); }
        if (statusesResult.status === "fulfilled") setWebhookStatuses(Object.fromEntries(extractItems(statusesResult.value, ["channels", "items", "statuses"]).map(normalizeWebhookStatus).map((s) => [s.channelId, s.status])));
        else setWebhookStatuses({});
    }, []);

    useEffect(() => { load(); loadAuxiliary(); }, [load, loadAuxiliary]);

    const filtered = useMemo(() => {
        const words = search.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
        return automations.filter((a) => {
            const ids = a.channelIds?.length ? a.channelIds : [a.channelId];
            const haystack = `${a.name} ${a.keywords.join(" ")} ${TRIGGER_LABELS[a.trigger]}`.toLocaleLowerCase();
            const matchesSearch = words.every((word) => haystack.includes(word));
            const matchesChannel = !channelFilter || ids.includes(channelFilter);
            const matchesStatus = statusFilter === "all" || (statusFilter === "paused" ? !a.enabled || globalEnabled === false : statusFilter === "test" ? a.enabled && globalEnabled === true && dryRun === true : a.enabled && globalEnabled === true && dryRun === false);
            return matchesSearch && matchesChannel && matchesStatus;
        });
    }, [automations, channelFilter, dryRun, globalEnabled, search, statusFilter]);

    async function toggle(a: IgAutomation) {
        setTogglingId(a.id);
        try {
            await apiFetch<unknown>(`/api/automations/${a.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !a.enabled }) });
            setAutomations((prev) => prev.map((item) => item.id === a.id ? { ...item, enabled: !a.enabled } : item));
            onToast(a.enabled ? "Automação pausada" : "Automação ativada");
        } catch (e: unknown) { onToast(e instanceof Error ? e.message : "Falha ao atualizar automação.", "error"); }
        finally { setTogglingId(null); }
    }

    async function duplicate(a: IgAutomation) {
        setDuplicatingId(a.id);
        try {
            const payload = automationToPayload(a);
            const settings = { ...payload.settings };
            delete settings._profileGroupId;
            await apiFetch<unknown>("/api/automations", { method: "POST", body: JSON.stringify({
                ...payload, settings, name: `${a.name.length > 112 ? a.name.slice(0, 112).trimEnd() : a.name} (cópia)`, enabled: false,
                channelIds: a.channelIds?.length ? a.channelIds : [a.channelId],
                mediaIdsByChannel: a.mediaIdsByChannel,
            }) });
            onToast("Automação duplicada como pausada");
            await load();
        } catch (e: unknown) { onToast(e instanceof Error ? e.message : "Falha ao duplicar automação.", "error"); }
        finally { setDuplicatingId(null); }
    }

    async function confirmDelete() {
        if (!deletingId) return;
        setDeleting(true);
        try {
            await apiFetch<unknown>(`/api/automations/${deletingId}`, { method: "DELETE" });
            setAutomations((prev) => prev.filter((a) => a.id !== deletingId));
            onToast("Automação excluída");
            setDeletingId(null);
        } catch (e: unknown) { onToast(e instanceof Error ? e.message : "Falha ao excluir.", "error"); }
        finally { setDeleting(false); }
    }

    if (loading) return <div className="flex justify-center p-12"><div className="w-8 h-8 border-2 border-ios-blue border-t-transparent rounded-full animate-spin" /></div>;
    if (error) return <IOSCard className="p-8 text-center"><AlertTriangle size={36} className="mx-auto mb-3 text-ios-orange opacity-70" /><p className="text-[14px] text-ios-text mb-3">{error}</p><IOSButton variant="secondary" className="mx-auto !py-2 !px-4" onClick={load}>Tentar de novo</IOSButton></IOSCard>;
    if (automations.length === 0) return <IOSCard className="p-12 text-center text-ios-text-secondary"><Bot size={48} className="mx-auto mb-4 opacity-30" strokeWidth={1} /><h3 className="text-xl font-semibold mb-2 text-ios-text">Nenhuma automação ainda</h3><p className="max-w-sm mx-auto mb-6 text-[13px]">Crie uma regra para responder comentários ou mensagens. Depois, teste antes de ativar.</p><Link href="/automations/new" className="inline-flex min-h-11 items-center gap-1.5 px-4 rounded-xl bg-ios-blue text-white text-[15px] font-semibold"><Plus size={16} /> Nova automação</Link></IOSCard>;

    return <div className="space-y-4">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">{[["Regras", automations.length], ["Prontas", automations.filter((a) => a.enabled && globalEnabled === true && dryRun === false && (a.channelIds?.length ? a.channelIds : [a.channelId]).every((id) => webhookStatuses[id] === "ok")).length], ["Em teste", automations.filter((a) => a.enabled && globalEnabled === true && dryRun === true).length], ["Pausadas", automations.filter((a) => !a.enabled || globalEnabled === false).length]].map(([label, value]) => <div key={label} className="rounded-xl border border-ios-separator bg-ios-card px-3 py-2"><div className="text-[10px] text-ios-text-secondary">{label}</div><div className="text-[17px] font-bold text-ios-text tabular-nums">{value}</div>{label === "Prontas" && (globalEnabled === null || dryRun === null) && <div className="text-[9px] text-ios-text-secondary">estado global desconhecido</div>}</div>)}</div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <input value={search} onChange={(e) => { setSearch(e.target.value); setVisibleCount(12); }} placeholder="Buscar por nome ou palavra-chave" aria-label="Buscar automações" className="min-h-11 bg-ios-background border border-ios-separator rounded-lg px-3 text-sm" />
            <select value={channelFilter} onChange={(e) => { setChannelFilter(e.target.value); setVisibleCount(12); }} aria-label="Filtrar por perfil" className="min-h-11 bg-ios-background border border-ios-separator rounded-lg px-3 text-sm"><option value="">Todos os perfis</option>{channels.map((c) => <option key={c.id} value={c.id}>{c.username ? `@${c.username}` : channelLabel(c)}</option>)}</select>
            <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value as typeof statusFilter); setVisibleCount(12); }} aria-label="Filtrar por estado" className="min-h-11 bg-ios-background border border-ios-separator rounded-lg px-3 text-sm"><option value="all">Todos os estados</option><option value="active">Ativas</option><option value="test">Em modo de teste</option><option value="paused">Pausadas</option></select>
        </div>
        {filtered.length === 0 ? <IOSCard className="p-8 text-center text-[13px] text-ios-text-secondary">Nenhuma regra corresponde aos filtros. Ajuste a busca ou selecione outro perfil.</IOSCard> : <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">{filtered.slice(0, visibleCount).map((a) => {
            const disabled = !a.enabled;
            const profileIds = a.channelIds?.length ? a.channelIds : [a.channelId];
            const profiles = a.channels?.length ? a.channels : channels.filter((c) => profileIds.includes(c.id));
            const profilesVerified = profileIds.length > 0 && profileIds.every((id) => webhookStatuses[id] === "ok");
            const profileStatusKnown = profileIds.length > 0 && profileIds.every((id) => id in webhookStatuses && webhookStatuses[id] !== "unknown");
            const stateLabel = disabled ? "PAUSADA" : globalEnabled === false ? "PAUSADA PELO SISTEMA" : globalEnabled === null || dryRun === null ? "ESTADO GLOBAL NÃO VERIFICADO" : dryRun ? "TESTE · sem envios reais" : profilesVerified ? "PRONTA PARA ENVIAR" : profileStatusKnown ? "ATIVA · conexão pendente" : "CONEXÃO NÃO VERIFICADA";
            const keywordsForSummary = a.keywords.slice(0, 2).map((keyword) => `“${keyword}”`).join(" ou ");
            const keywordSummary = a.keywords.length ? ` quando o texto combinar com ${keywordsForSummary}${a.keywords.length > 2 ? " ou outras palavras-chave" : ""}` : " para qualquer texto";
            const actionSummary = a.actions.slice(0, 2).map((action) => ACTION_TYPE_LABELS[action.type] ?? action.type).join(" e ") || "nenhuma ação configurada";
            return <IOSCard key={a.id} className={`p-3 sm:p-4 ${disabled ? "opacity-75" : ""}`}>
                <div className="flex items-start gap-2.5">
                    <div className="pt-0.5 shrink-0"><IOSSwitch checked={a.enabled} disabled={togglingId === a.id} onChange={() => toggle(a)} ariaLabel={`Ativar ${a.name}`} /></div>
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap"><h4 className="text-[15px] font-semibold text-ios-text">{a.name}</h4><span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-ios-blue/10 text-ios-blue">{TRIGGER_LABELS[a.trigger]}</span><span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${disabled || globalEnabled === false ? "bg-ios-gray-5 text-ios-text-secondary" : dryRun === true ? "bg-ios-orange/15 text-ios-orange" : profilesVerified ? "bg-ios-green/15 text-ios-green" : "bg-ios-orange/10 text-ios-orange"}`}>{stateLabel}</span>{a.priority > 0 && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-ios-gray-5 text-ios-text-secondary">prioridade {a.priority}</span>}</div>
                        <div className="flex flex-wrap gap-1 mt-1.5" aria-label="Perfis vinculados">{profiles.length ? profiles.map((c) => <span key={c.id} className="text-[10px] px-1.5 py-0.5 rounded-full bg-ios-gray-5 text-ios-text-secondary">{c.username ? `@${c.username}` : channelLabel(c)}</span>) : profileIds.map((id) => <span key={id} className="text-[10px] px-1.5 py-0.5 rounded-full bg-ios-gray-5 text-ios-text-secondary">{id.slice(0, 8)}…</span>)}</div>
                        <div className="flex flex-wrap gap-1 mt-1.5">{a.keywords.length ? a.keywords.slice(0, 3).map((k, i) => <span key={`${k}-${i}`} className="text-[10px] px-1.5 py-0.5 rounded-full bg-ios-gray-5 text-ios-text-secondary">{k}</span>) : <span className="text-[11px] text-ios-text-secondary italic">Qualquer texto</span>}{a.keywords.length > 3 && <span className="text-[10px] text-ios-text-secondary">+{a.keywords.length - 3}</span>}</div>
                        <p className="mt-1 text-[11px] text-ios-text-secondary">Quando houver {TRIGGER_LABELS[a.trigger].toLocaleLowerCase()}{keywordSummary}, executar: {actionSummary}{a.actions.length > 2 ? ` e mais ${a.actions.length - 2}` : ""}.</p>
                        <div className="flex flex-wrap gap-x-2.5 gap-y-1 mt-2 text-[11px] tabular-nums"><span className="text-ios-blue font-semibold">{a.statsMatched} correspondências</span><span className="text-ios-green font-semibold">{a.statsSent} enviadas</span>{a.statsFailed > 0 && <span className="text-ios-red font-semibold">{a.statsFailed} falhas</span>}<span className="text-purple-500 font-semibold">{a.statsClicks} cliques</span><span className="text-ios-text-secondary">{a.actions.length} ações</span>{a.memberIds?.length > 1 && <span className="text-ios-text-secondary">{a.memberIds.length} perfis vinculados</span>}{a.lastRunAt && <span className="text-ios-text-secondary">última {relativeTime(a.lastRunAt)}</span>}</div>
                    </div>
                </div>
                <div className="flex flex-wrap gap-2 mt-3 pt-3 border-t border-ios-separator"><Link href={`/automations/${a.id}?simulate=1`} className="min-h-11 flex items-center gap-1 px-2.5 rounded-lg text-[12px] font-semibold text-purple-500 bg-purple-500/10"><PlayCircle size={14} /> Testar</Link><Link href={`/automations/${a.id}`} className="min-h-11 flex items-center gap-1 px-2.5 rounded-lg text-[12px] font-semibold text-ios-blue bg-ios-blue/10"><Pencil size={14} /> Editar</Link><button type="button" onClick={() => duplicate(a)} disabled={duplicatingId === a.id} className="min-h-11 flex items-center gap-1 px-2.5 rounded-lg text-[12px] font-semibold text-ios-text-secondary bg-ios-gray-5/60 disabled:opacity-40">{duplicatingId === a.id ? <Loader2 size={14} className="animate-spin" /> : <Copy size={14} />} Duplicar</button><button type="button" onClick={() => setDeletingId(a.id)} className="min-h-11 flex items-center gap-1 px-2.5 rounded-lg text-[12px] font-semibold text-ios-red bg-ios-red/10"><Trash2 size={14} /> Excluir</button></div>
            </IOSCard>;
        })}</div>}
        {filtered.length > visibleCount && <button type="button" onClick={() => setVisibleCount((count) => count + 12)} className="min-h-11 mx-auto block px-4 rounded-lg bg-ios-gray-5 text-[13px] font-semibold text-ios-blue">Carregar mais ({filtered.length - visibleCount})</button>}
        {deletingId && <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" role="presentation" onClick={() => { if (!deleting) setDeletingId(null); }}><div role="alertdialog" aria-modal="true" aria-labelledby="delete-automation-title" aria-describedby="delete-automation-description" tabIndex={-1} ref={deleteDialogRef} onClick={(e) => e.stopPropagation()} className="bg-ios-card w-full max-w-sm rounded-2xl shadow-2xl overflow-hidden"><div className="p-6 text-center"><div className="w-12 h-12 rounded-full bg-ios-red/15 flex items-center justify-center mx-auto mb-4"><Trash2 size={22} className="text-ios-red" /></div><h3 id="delete-automation-title" className="text-[17px] font-bold text-ios-text mb-1">Excluir automação?</h3><p id="delete-automation-description" className="text-[14px] text-ios-text-secondary">A regra será excluída de todos os perfis vinculados. Esta ação não pode ser desfeita.</p></div><div className="border-t border-ios-separator flex"><button type="button" onClick={() => setDeletingId(null)} disabled={deleting} data-autofocus className="flex-1 min-h-11 text-ios-blue font-medium border-r border-ios-separator">Cancelar</button><button type="button" onClick={confirmDelete} disabled={deleting} className="flex-1 min-h-11 text-ios-red font-semibold">{deleting ? "Excluindo…" : "Excluir"}</button></div></div></div>}
    </div>;
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
                    {error} Tente novamente em instantes.
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

            {/* Resumo global; configuração completa fica só na aba Config. */}
            {tab !== "config" && <WebhookPanel compact />}

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
