"use client";
import { useCallback, useEffect, useState } from "react";
import {
    AlertTriangle,
    BarChart3,
    MousePointerClick,
    RefreshCw,
    Send,
    Users,
    XCircle,
    Zap,
} from "lucide-react";
import IOSButton from "@/components/IOSButton";
import IOSCard from "@/components/IOSComponents";
import type { ChannelLite, IgAnalytics } from "./types";
import {
    apiFetch,
    channelLabel,
    extractItems,
    normalizeAnalytics,
    normalizeChannel,
} from "./types";

const inputCls =
    "bg-ios-background border border-ios-separator rounded-lg p-2 text-[13px] focus:border-ios-blue outline-none";

interface BarPoint {
    label: string;
    matched: number;
    sent: number;
    failed: number;
    clicks: number;
}

function shortDate(date: string): string {
    if (!date) return "—";
    const d = new Date(date.length <= 10 ? `${date}T00:00:00` : date);
    if (Number.isNaN(d.getTime())) return date;
    return d.toLocaleDateString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
    });
}

export default function AnalyticsPanel() {
    const [analytics, setAnalytics] = useState<IgAnalytics | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [channels, setChannels] = useState<ChannelLite[]>([]);
    const [channelId, setChannelId] = useState("");
    const [days, setDays] = useState("7");

    useEffect(() => {
        (async () => {
            try {
                const raw = await apiFetch<unknown>("/api/channels");
                setChannels(
                    extractItems(raw, ["channels"])
                        .map(normalizeChannel)
                        .filter(
                            (c) => c.platform.toLowerCase() === "instagram",
                        ),
                );
            } catch {
                /* filtro fica vazio */
            }
        })();
    }, []);

    const load = useCallback(async () => {
        setLoading(true);
        setError("");
        try {
            const params = new URLSearchParams({ days });
            if (channelId) params.set("channelId", channelId);
            const raw = await apiFetch<unknown>(
                `/api/ig/analytics?${params.toString()}`,
            );
            setAnalytics(normalizeAnalytics(raw));
        } catch (e: unknown) {
            setAnalytics(null);
            setError(
                e instanceof Error
                    ? e.message
                    : "Falha ao carregar relatórios.",
            );
        } finally {
            setLoading(false);
        }
    }, [channelId, days]);

    useEffect(() => {
        void load();
    }, [load]);

    const series: BarPoint[] = (analytics?.series ?? []).map((p) => ({
        label: shortDate(p.date),
        matched: p.matched,
        sent: p.sent,
        failed: p.failed,
        clicks: p.clicks,
    }));

    const totals = analytics?.totals ?? {
        matched: 0,
        sent: 0,
        failed: 0,
        clicks: 0,
        contacts: 0,
    };

    const totalCards = [
        {
            label: "Matches",
            value: totals.matched,
            icon: Zap,
            color: "text-ios-blue bg-ios-blue/10",
        },
        {
            label: "Enviadas",
            value: totals.sent,
            icon: Send,
            color: "text-ios-green bg-ios-green/10",
        },
        {
            label: "Falhas",
            value: totals.failed,
            icon: XCircle,
            color: "text-ios-red bg-ios-red/10",
        },
        {
            label: "Cliques",
            value: totals.clicks,
            icon: MousePointerClick,
            color: "text-purple-500 bg-purple-500/10",
        },
        {
            label: "Contatos",
            value: totals.contacts,
            icon: Users,
            color: "text-ios-orange bg-ios-orange/10",
        },
    ];

    const maxVal = Math.max(
        1,
        ...series.flatMap((p) => [p.matched, p.sent, p.failed, p.clicks]),
    );

    const barDefs: { key: keyof Omit<BarPoint, "label">; cls: string }[] = [
        { key: "matched", cls: "bg-ios-blue/60" },
        { key: "sent", cls: "bg-ios-green/70" },
        { key: "failed", cls: "bg-ios-red/70" },
        { key: "clicks", cls: "bg-purple-500/70" },
    ];

    return (
        <div className="space-y-4">
            {/* Filtros */}
            <div className="flex flex-wrap items-center gap-2">
                <select
                    value={channelId}
                    onChange={(e) => setChannelId(e.target.value)}
                    aria-label="Filtrar por canal"
                    className={inputCls}
                >
                    <option value="">Todos os canais</option>
                    {channels.map((c) => (
                        <option key={c.id} value={c.id}>
                            {channelLabel(c)}
                        </option>
                    ))}
                </select>
                <select
                    value={days}
                    onChange={(e) => setDays(e.target.value)}
                    aria-label="Período"
                    className={inputCls}
                >
                    <option value="7">Últimos 7 dias</option>
                    <option value="14">Últimos 14 dias</option>
                    <option value="30">Últimos 30 dias</option>
                </select>
                <button
                    type="button"
                    onClick={() => load()}
                    disabled={loading}
                    aria-label="Atualizar relatórios"
                    className="ml-auto p-2 rounded-lg text-ios-blue hover:bg-ios-blue/10 disabled:opacity-40"
                >
                    <RefreshCw
                        size={16}
                        className={loading ? "animate-spin" : ""}
                    />
                </button>
            </div>

            {loading ? (
                <div className="flex justify-center p-12">
                    <div className="w-8 h-8 border-2 border-ios-blue border-t-transparent rounded-full animate-spin" />
                </div>
            ) : error ? (
                <IOSCard className="p-8 text-center">
                    <AlertTriangle
                        size={36}
                        className="mx-auto mb-3 text-ios-orange opacity-70"
                    />
                    <p className="text-[14px] text-ios-text mb-3">{error}</p>
                    <IOSButton
                        variant="secondary"
                        className="mx-auto !py-2 !px-4"
                        onClick={() => load()}
                    >
                        Tentar de novo
                    </IOSButton>
                </IOSCard>
            ) : (
                <>
                    {/* Totais */}
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                        {totalCards.map((c) => (
                            <IOSCard key={c.label} className="p-3">
                                <div
                                    className={`w-8 h-8 rounded-lg flex items-center justify-center mb-2 ${c.color}`}
                                >
                                    <c.icon size={16} />
                                </div>
                                <p className="text-[22px] font-bold text-ios-text tabular-nums leading-none">
                                    {c.value}
                                </p>
                                <p className="text-[11px] text-ios-text-secondary mt-1">
                                    {c.label}
                                </p>
                            </IOSCard>
                        ))}
                    </div>

                    {/* Série */}
                    <IOSCard className="p-4">
                        <div className="flex items-center justify-between mb-3">
                            <h3 className="text-[15px] font-bold text-ios-text">
                                Série diária
                            </h3>
                            <div className="flex items-center gap-2 text-[10px] text-ios-text-secondary">
                                <span className="flex items-center gap-1">
                                    <span className="w-2.5 h-2.5 rounded-sm bg-ios-blue/60" />{" "}
                                    matches
                                </span>
                                <span className="flex items-center gap-1">
                                    <span className="w-2.5 h-2.5 rounded-sm bg-ios-green/70" />{" "}
                                    enviadas
                                </span>
                                <span className="flex items-center gap-1">
                                    <span className="w-2.5 h-2.5 rounded-sm bg-ios-red/70" />{" "}
                                    falhas
                                </span>
                                <span className="flex items-center gap-1">
                                    <span className="w-2.5 h-2.5 rounded-sm bg-purple-500/70" />{" "}
                                    cliques
                                </span>
                            </div>
                        </div>
                        {series.length === 0 ? (
                            <div className="py-10 text-center text-ios-text-secondary text-[13px]">
                                <BarChart3
                                    size={28}
                                    className="mx-auto mb-2 opacity-20"
                                />
                                Sem dados no período.
                            </div>
                        ) : (
                            <div className="overflow-x-auto">
                                <div className="flex items-end gap-2 min-w-max h-36 pb-6 relative">
                                    {series.map((p, i) => (
                                        <div
                                            key={`${p.label}-${i}`}
                                            className="flex flex-col items-center gap-0.5 w-10 shrink-0 group relative"
                                            title={`${p.label}: ${p.matched} matches, ${p.sent} enviadas, ${p.failed} falhas, ${p.clicks} cliques`}
                                        >
                                            <div className="flex items-end gap-0.5 h-28 w-full justify-center">
                                                {barDefs.map((b) => (
                                                    <div
                                                        key={b.key}
                                                        className={`w-1.5 rounded-t-sm ${b.cls} transition-all`}
                                                        style={{
                                                            height: `${Math.max(
                                                                2,
                                                                (p[b.key] /
                                                                    maxVal) *
                                                                    100,
                                                            )}%`,
                                                        }}
                                                        aria-hidden="true"
                                                    />
                                                ))}
                                            </div>
                                            <span className="absolute -bottom-5 text-[9px] text-ios-text-secondary whitespace-nowrap">
                                                {p.label}
                                            </span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </IOSCard>

                    {/* Por automação */}
                    <IOSCard className="overflow-hidden">
                        <div className="p-4 pb-2">
                            <h3 className="text-[15px] font-bold text-ios-text">
                                Por automação
                            </h3>
                        </div>
                        {(analytics?.byAutomation.length ?? 0) === 0 ? (
                            <p className="px-4 pb-4 text-[13px] text-ios-text-secondary">
                                Sem dados por automação no período.
                            </p>
                        ) : (
                            <div className="overflow-x-auto">
                                <table className="w-full text-left text-[13px] min-w-[520px]">
                                    <thead className="bg-ios-gray-6 text-ios-text-secondary text-[11px] uppercase tracking-wide">
                                        <tr>
                                            <th className="px-4 py-2 font-semibold">
                                                Automação
                                            </th>
                                            <th className="px-3 py-2 font-semibold text-right">
                                                Matches
                                            </th>
                                            <th className="px-3 py-2 font-semibold text-right">
                                                Enviadas
                                            </th>
                                            <th className="px-3 py-2 font-semibold text-right">
                                                Falhas
                                            </th>
                                            <th className="px-4 py-2 font-semibold text-right">
                                                Cliques
                                            </th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-ios-separator">
                                        {analytics?.byAutomation.map((a) => (
                                            <tr
                                                key={a.automationId || a.name}
                                                className="hover:bg-ios-gray-6/60"
                                            >
                                                <td className="px-4 py-2 font-medium text-ios-text">
                                                    {a.name ||
                                                        a.automationId.slice(
                                                            0,
                                                            8,
                                                        )}
                                                </td>
                                                <td className="px-3 py-2 text-right tabular-nums text-ios-text">
                                                    {a.matched}
                                                </td>
                                                <td className="px-3 py-2 text-right tabular-nums text-ios-green font-semibold">
                                                    {a.sent}
                                                </td>
                                                <td className="px-3 py-2 text-right tabular-nums text-ios-red">
                                                    {a.failed}
                                                </td>
                                                <td className="px-4 py-2 text-right tabular-nums text-purple-500 font-semibold">
                                                    {a.clicks}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </IOSCard>
                </>
            )}
        </div>
    );
}
