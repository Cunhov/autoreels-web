"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    AlertTriangle,
    ArrowDownLeft,
    ArrowUpRight,
    Inbox,
    Loader2,
    RefreshCw,
    Reply,
    Send,
    Sparkles,
    Webhook,
    Zap,
} from "lucide-react";
import IOSButton from "@/components/IOSButton";
import IOSCard from "@/components/IOSComponents";
import type { ChannelLite } from "./types";
import {
    ACTION_TYPE_LABELS,
    apiFetch,
    asString,
    channelLabel,
    extractItems,
    formatDateTime,
    isRecord,
    normalizeChannel,
} from "./types";

const inputCls =
    "bg-ios-background border border-ios-separator rounded-lg p-2 text-[13px] focus:border-ios-blue outline-none";

const KIND_LABELS: Record<string, string> = {
    comment: "Comentário",
    dm: "DM",
    story_reply: "Resposta de story",
    story_mention: "Menção de story",
    postback: "Postback",
    reaction: "Reação",
    echo: "Echo (humano)",
    system: "Sistema",
};

const STATUS_STYLES: Record<string, string> = {
    sent: "bg-ios-green/15 text-ios-green",
    matched: "bg-ios-green/15 text-ios-green",
    received: "bg-ios-blue/15 text-ios-blue",
    pending: "bg-ios-blue/15 text-ios-blue",
    failed: "bg-ios-red/15 text-ios-red",
    skipped: "bg-ios-gray-5 text-ios-text-secondary",
    paused: "bg-ios-orange/15 text-ios-orange",
    duplicate: "bg-ios-gray-5 text-ios-text-secondary",
};

type Source = "tudo" | "eventos" | "acoes";

interface TimelineItem {
    key: string;
    source: "evento" | "acao";
    createdAt: string;
    kind: string;
    status: string;
    text: string;
    username: string;
    automationName: string;
    error: string;
    direction: string;
    channelId: string;
}

function nestedName(o: Record<string, unknown>, keys: string[]): string {
    for (const k of keys) {
        const v = o[k];
        if (isRecord(v)) {
            const name = asString(v.name);
            if (name) return name;
        }
        if (typeof v === "string") return v;
    }
    return "";
}

function nestedUsername(raw: unknown): string {
    if (!isRecord(raw)) return "";
    return asString(raw.username) || asString(raw.name);
}

function normalizeEventItem(raw: unknown): TimelineItem {
    const o = isRecord(raw) ? raw : {};
    return {
        key: `evt-${asString(o.id)}`,
        source: "evento",
        createdAt: asString(o.createdAt) || asString(o.created_at),
        kind: asString(o.kind, "system"),
        status: asString(o.status, "received"),
        text: asString(o.text),
        username: asString(o.username),
        automationName: nestedName(o, ["automation"]),
        error: asString(o.error),
        direction: asString(o.direction, "in"),
        channelId: asString(o.channelId) || asString(o.channel_id),
    };
}

function normalizeLogItem(raw: unknown): TimelineItem {
    const o = isRecord(raw) ? raw : {};
    return {
        key: `log-${asString(o.id)}`,
        source: "acao",
        createdAt: asString(o.createdAt) || asString(o.created_at),
        kind: asString(o.actionType) || asString(o.action_type, "action"),
        status: asString(o.status, "pending"),
        text: "",
        username: nestedUsername(o.contact),
        automationName: nestedName(o, ["automation"]),
        error: asString(o.error),
        direction: "out",
        channelId: asString(o.channelId) || asString(o.channel_id),
    };
}

export default function InboxPanel() {
    const [items, setItems] = useState<TimelineItem[]>([]);
    const [nextEvents, setNextEvents] = useState<string | null>(null);
    const [nextLogs, setNextLogs] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [error, setError] = useState("");
    const [channels, setChannels] = useState<ChannelLite[]>([]);
    const [source, setSource] = useState<Source>("tudo");
    const [channelId, setChannelId] = useState("");
    const [kind, setKind] = useState("");
    const [status, setStatus] = useState("");
    const [direction, setDirection] = useState("");
    const requestSeq = useRef(0);

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

    const fetchPage = useCallback(
        async (opts: {
            eventsCursor?: string | null;
            logsCursor?: string | null;
            append: boolean;
        }) => {
            const seq = ++requestSeq.current;
            if (opts.append) setLoadingMore(true);
            else setLoading(true);
            setError("");
            try {
                const collected: TimelineItem[] = [];
                let nextEv: string | null = null;
                let nextLg: string | null = null;

                if (source !== "acoes") {
                    const params = new URLSearchParams({ limit: "30" });
                    if (channelId) params.set("channelId", channelId);
                    if (kind) params.set("kind", kind);
                    if (direction) params.set("direction", direction);
                    if (opts.eventsCursor)
                        params.set("cursor", opts.eventsCursor);
                    const raw = await apiFetch<unknown>(
                        `/api/ig/events?${params.toString()}`,
                    );
                    collected.push(
                        ...extractItems(raw, ["items", "events"]).map(
                            normalizeEventItem,
                        ),
                    );
                    const nc = isRecord(raw) ? raw.nextCursor : null;
                    nextEv = typeof nc === "string" && nc ? nc : null;
                }

                if (source !== "eventos") {
                    const params = new URLSearchParams({ limit: "30" });
                    if (channelId) params.set("channelId", channelId);
                    if (status) params.set("status", status);
                    if (opts.logsCursor) params.set("cursor", opts.logsCursor);
                    const raw = await apiFetch<unknown>(
                        `/api/automations/logs?${params.toString()}`,
                    );
                    collected.push(
                        ...extractItems(raw, ["items", "logs"]).map(
                            normalizeLogItem,
                        ),
                    );
                    const nc = isRecord(raw) ? raw.nextCursor : null;
                    nextLg = typeof nc === "string" && nc ? nc : null;
                }

                collected.sort(
                    (a, b) =>
                        new Date(b.createdAt).getTime() -
                        new Date(a.createdAt).getTime(),
                );
                if (seq !== requestSeq.current) return;
                setItems((prev) =>
                    opts.append ? [...prev, ...collected] : collected,
                );
                if (opts.append) {
                    // Clear an exhausted cursor for fetched sources, while
                    // preserving the cursor for a source excluded by the filter.
                    if (source !== "acoes") setNextEvents(nextEv);
                    if (source !== "eventos") setNextLogs(nextLg);
                } else {
                    setNextEvents(nextEv);
                    setNextLogs(nextLg);
                }
            } catch (e: unknown) {
                if (seq !== requestSeq.current) return;
                setError(
                    e instanceof Error
                        ? e.message
                        : "Falha ao carregar a timeline.",
                );
            } finally {
                if (seq === requestSeq.current) {
                    setLoading(false);
                    setLoadingMore(false);
                }
            }
        },
        [source, channelId, kind, status, direction],
    );

    useEffect(() => {
        void fetchPage({ append: false });
    }, [fetchPage]);

    const hasMore = Boolean(nextEvents || nextLogs);

    const channelName = useMemo(() => {
        const map: Record<string, string> = {};
        channels.forEach((c) => {
            map[c.id] = channelLabel(c);
        });
        return map;
    }, [channels]);

    return (
        <div className="space-y-4">
            {/* Filtros */}
            <IOSCard className="p-3">
                <div className="flex flex-wrap items-center gap-2">
                    <div className="flex rounded-lg border border-ios-separator overflow-hidden">
                        {(
                            [
                                ["tudo", "Tudo"],
                                ["eventos", "Eventos"],
                                ["acoes", "Ações"],
                            ] as [Source, string][]
                        ).map(([id, label]) => (
                            <button
                                key={id}
                                type="button"
                                onClick={() => setSource(id)}
                                className={`px-3 py-1.5 text-[12px] font-semibold transition-colors ${
                                    source === id
                                        ? "bg-ios-blue text-white"
                                        : "text-ios-text-secondary hover:bg-ios-gray-5"
                                }`}
                            >
                                {label}
                            </button>
                        ))}
                    </div>
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
                    {source !== "acoes" && (
                        <>
                            <select
                                value={kind}
                                onChange={(e) => setKind(e.target.value)}
                                aria-label="Filtrar por tipo de evento"
                                className={inputCls}
                            >
                                <option value="">Todos os tipos</option>
                                {Object.entries(KIND_LABELS).map(
                                    ([k, label]) => (
                                        <option key={k} value={k}>
                                            {label}
                                        </option>
                                    ),
                                )}
                            </select>
                            <select
                                value={direction}
                                onChange={(e) =>
                                    setDirection(e.target.value)
                                }
                                aria-label="Filtrar por direção"
                                className={inputCls}
                            >
                                <option value="">Entrada e saída</option>
                                <option value="in">Entrada</option>
                                <option value="out">Saída</option>
                            </select>
                        </>
                    )}
                    {source !== "eventos" && (
                        <select
                            value={status}
                            onChange={(e) => setStatus(e.target.value)}
                            aria-label="Filtrar por status da ação"
                            className={inputCls}
                        >
                            <option value="">Todos os status</option>
                            <option value="sent">Enviado</option>
                            <option value="failed">Falhou</option>
                            <option value="skipped">Ignorado</option>
                            <option value="pending">Pendente</option>
                        </select>
                    )}
                    <button
                        type="button"
                        onClick={() => fetchPage({ append: false })}
                        disabled={loading}
                        aria-label="Atualizar timeline"
                        className="ml-auto p-2 rounded-lg text-ios-blue hover:bg-ios-blue/10 disabled:opacity-40"
                    >
                        <RefreshCw
                            size={16}
                            className={loading ? "animate-spin" : ""}
                        />
                    </button>
                </div>
            </IOSCard>

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
                        onClick={() => fetchPage({ append: false })}
                    >
                        Tentar de novo
                    </IOSButton>
                </IOSCard>
            ) : items.length === 0 ? (
                <IOSCard className="p-12 text-center text-ios-text-secondary">
                    <Inbox
                        size={44}
                        className="mx-auto mb-3 opacity-30"
                        strokeWidth={1}
                    />
                    <h3 className="text-lg font-semibold mb-1 text-ios-text">
                        Timeline vazia
                    </h3>
                    <p className="text-[13px] max-w-sm mx-auto">
                        Eventos recebidos e ações executadas aparecem aqui
                        conforme as automações rodam.
                    </p>
                </IOSCard>
            ) : (
                <div className="space-y-2">
                    {items.map((item) => {
                        const isEvent = item.source === "evento";
                        const Icon = isEvent
                            ? item.kind === "comment"
                                ? Reply
                                : ArrowDownLeft
                            : item.kind === "public_comment_reply" ||
                                item.kind === "private_reply"
                              ? Send
                              : item.kind === "ai_reply"
                                ? Sparkles
                                : item.kind === "outbound_webhook"
                                  ? Webhook
                                  : ArrowUpRight;
                        const label = isEvent
                            ? KIND_LABELS[item.kind] ?? item.kind
                            : ACTION_TYPE_LABELS[
                                  item.kind as keyof typeof ACTION_TYPE_LABELS
                              ] ?? item.kind;
                        const statusStyle =
                            STATUS_STYLES[item.status] ??
                            "bg-ios-gray-5 text-ios-text-secondary";
                        return (
                            <div
                                key={item.key}
                                className="flex items-start gap-3 p-3 rounded-xl bg-ios-card border border-ios-separator"
                            >
                                <div
                                    className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${
                                        isEvent
                                            ? "bg-ios-blue/10 text-ios-blue"
                                            : "bg-purple-500/10 text-purple-500"
                                    }`}
                                >
                                    <Icon size={15} />
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <span className="text-[13px] font-semibold text-ios-text">
                                            {label}
                                        </span>
                                        <span
                                            className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full uppercase ${statusStyle}`}
                                        >
                                            {item.status}
                                        </span>
                                        <span className="text-[10px] text-ios-text-secondary">
                                            {isEvent ? "evento" : "ação"}
                                        </span>
                                        {item.channelId && (
                                            <span className="text-[10px] text-ios-text-secondary">
                                                {channelName[item.channelId] ??
                                                    item.channelId.slice(0, 8)}
                                            </span>
                                        )}
                                    </div>
                                    {item.text && (
                                        <p className="text-[12px] text-ios-text mt-1 break-words line-clamp-3">
                                            {item.text}
                                        </p>
                                    )}
                                    <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1 text-[11px] text-ios-text-secondary">
                                        {item.username && (
                                            <span>@{item.username}</span>
                                        )}
                                        {item.automationName && (
                                            <span className="flex items-center gap-1">
                                                <Zap size={10} />
                                                {item.automationName}
                                            </span>
                                        )}
                                        <span>{formatDateTime(item.createdAt)}</span>
                                    </div>
                                    {item.error && (
                                        <p className="text-[11px] text-ios-red mt-1 break-words">
                                            {item.error}
                                        </p>
                                    )}
                                </div>
                            </div>
                        );
                    })}

                    {hasMore && (
                        <div className="flex justify-center pt-2">
                            <IOSButton
                                variant="secondary"
                                className="!py-2 !px-4 flex items-center gap-2"
                                disabled={loadingMore}
                                onClick={() =>
                                    fetchPage({
                                        append: true,
                                        eventsCursor: nextEvents,
                                        logsCursor: nextLogs,
                                    })
                                }
                            >
                                {loadingMore && (
                                    <Loader2
                                        size={15}
                                        className="animate-spin"
                                    />
                                )}
                                Carregar mais
                            </IOSButton>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
