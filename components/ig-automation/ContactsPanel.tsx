"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    AlertTriangle,
    ChevronDown,
    ChevronUp,
    Loader2,
    Pause,
    Play,
    Search,
    Tags,
    Users,
} from "lucide-react";
import IOSButton from "@/components/IOSButton";
import IOSCard from "@/components/IOSComponents";
import IOSToast from "@/components/IOSToast";
import KeywordChips from "./KeywordChips";
import type { ChannelLite, IgContact } from "./types";
import {
    apiFetch,
    channelLabel,
    extractItems,
    formatDateTime,
    isPaused,
    normalizeChannel,
    normalizeContact,
    relativeTime,
} from "./types";

const inputCls =
    "w-full bg-ios-background border border-ios-separator rounded-lg p-2 text-sm focus:border-ios-blue outline-none placeholder:text-gray-400";

const PAUSE_OPTIONS = [
    { value: "1", label: "1 hora" },
    { value: "6", label: "6 horas" },
    { value: "24", label: "24 horas" },
    { value: "72", label: "3 dias" },
];

export default function ContactsPanel() {
    const [contacts, setContacts] = useState<IgContact[]>([]);
    const [nextCursor, setNextCursor] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [error, setError] = useState("");
    const [q, setQ] = useState("");
    const [tagFilter, setTagFilter] = useState("");
    const [channelId, setChannelId] = useState("");
    const [channels, setChannels] = useState<ChannelLite[]>([]);
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [notesDraft, setNotesDraft] = useState("");
    const [savingId, setSavingId] = useState<string | null>(null);
    const [pauseHours, setPauseHours] = useState("24");
    const requestSeq = useRef(0);

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
                /* filtro de canal fica vazio */
            }
        })();
    }, []);

    const fetchPage = useCallback(
        async (cursor: string | null) => {
            const seq = ++requestSeq.current;
            const append = Boolean(cursor);
            if (append) setLoadingMore(true);
            else setLoading(true);
            setError("");
            try {
                const params = new URLSearchParams({ limit: "30" });
                if (q.trim()) params.set("q", q.trim());
                if (tagFilter.trim()) params.set("tag", tagFilter.trim());
                if (channelId) params.set("channelId", channelId);
                if (cursor) params.set("cursor", cursor);
                const raw = await apiFetch<unknown>(
                    `/api/ig/contacts?${params.toString()}`,
                );
                const items = extractItems(raw, ["items", "contacts"]).map(
                    normalizeContact,
                );
                const nc =
                    raw && typeof raw === "object" && "nextCursor" in raw
                        ? (raw as { nextCursor?: unknown }).nextCursor
                        : null;
                if (seq !== requestSeq.current) return;
                setContacts((prev) =>
                    append ? [...prev, ...items] : items,
                );
                setNextCursor(typeof nc === "string" && nc ? nc : null);
            } catch (e: unknown) {
                if (seq !== requestSeq.current) return;
                setError(
                    e instanceof Error
                        ? e.message
                        : "Falha ao carregar contatos.",
                );
            } finally {
                if (seq === requestSeq.current) {
                    setLoading(false);
                    setLoadingMore(false);
                }
            }
        },
        [q, tagFilter, channelId],
    );

    // Busca com debounce.
    useEffect(() => {
        const t = setTimeout(() => {
            void fetchPage(null);
        }, 350);
        return () => clearTimeout(t);
    }, [fetchPage]);

    const channelName = useCallback(
        (id: string) => {
            const c = channels.find((x) => x.id === id);
            return c ? channelLabel(c) : id.slice(0, 8);
        },
        [channels],
    );

    function updateLocal(id: string, patch: Partial<IgContact>) {
        setContacts((prev) =>
            prev.map((c) => (c.id === id ? { ...c, ...patch } : c)),
        );
    }

    async function patchContact(
        contact: IgContact,
        body: Record<string, unknown>,
        successMsg?: string,
    ) {
        setSavingId(contact.id);
        try {
            await apiFetch<unknown>(`/api/ig/contacts/${contact.id}`, {
                method: "PATCH",
                body: JSON.stringify(body),
            });
            if (successMsg) showToast(successMsg);
        } catch (e: unknown) {
            showToast(
                e instanceof Error ? e.message : "Falha ao atualizar contato.",
                "error",
            );
        } finally {
            setSavingId(null);
        }
    }

    async function pauseContact(contact: IgContact) {
        setSavingId(contact.id);
        try {
            await apiFetch<unknown>(
                `/api/ig/contacts/${contact.id}/pause`,
                {
                    method: "POST",
                    body: JSON.stringify({
                        hours: Number(pauseHours) || 24,
                    }),
                },
            );
            const until = new Date(
                Date.now() + (Number(pauseHours) || 24) * 3600_000,
            ).toISOString();
            updateLocal(contact.id, { botPausedUntil: until });
            showToast(`Bot pausado para @${contact.username || contact.igUserId}`);
        } catch (e: unknown) {
            showToast(
                e instanceof Error ? e.message : "Falha ao pausar o bot.",
                "error",
            );
        } finally {
            setSavingId(null);
        }
    }

    async function resumeContact(contact: IgContact) {
        setSavingId(contact.id);
        try {
            await apiFetch<unknown>(
                `/api/ig/contacts/${contact.id}/resume`,
                { method: "POST" },
            );
            updateLocal(contact.id, { botPausedUntil: null });
            showToast("Bot retomado para este contato");
        } catch (e: unknown) {
            showToast(
                e instanceof Error ? e.message : "Falha ao retomar o bot.",
                "error",
            );
        } finally {
            setSavingId(null);
        }
    }

    const allTags = useMemo(() => {
        const set = new Set<string>();
        contacts.forEach((c) => c.tags.forEach((t) => set.add(t)));
        return Array.from(set).sort();
    }, [contacts]);

    return (
        <div className="space-y-4">
            <IOSToast
                message={toast?.msg ?? ""}
                type={toast?.type}
                isVisible={toast !== null}
                onClose={closeToast}
            />

            {/* Filtros */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="relative">
                    <Search
                        className="absolute left-3 top-1/2 -translate-y-1/2 text-ios-text-secondary"
                        size={16}
                    />
                    <input
                        type="text"
                        value={q}
                        onChange={(e) => setQ(e.target.value)}
                        placeholder="Buscar por @ ou nome…"
                        aria-label="Buscar contatos"
                        className="w-full bg-ios-card border border-ios-separator rounded-xl py-2.5 pl-9 pr-4 text-[14px] focus:outline-none focus:ring-1 focus:ring-ios-blue"
                    />
                </div>
                <div className="relative">
                    <Tags
                        className="absolute left-3 top-1/2 -translate-y-1/2 text-ios-text-secondary"
                        size={16}
                    />
                    <input
                        type="text"
                        list="ig-contact-tags"
                        value={tagFilter}
                        onChange={(e) => setTagFilter(e.target.value)}
                        placeholder="Filtrar por tag…"
                        aria-label="Filtrar contatos por tag"
                        className="w-full bg-ios-card border border-ios-separator rounded-xl py-2.5 pl-9 pr-4 text-[14px] focus:outline-none focus:ring-1 focus:ring-ios-blue"
                    />
                    <datalist id="ig-contact-tags">
                        {allTags.map((t) => (
                            <option key={t} value={t} />
                        ))}
                    </datalist>
                </div>
                <select
                    value={channelId}
                    onChange={(e) => setChannelId(e.target.value)}
                    aria-label="Filtrar contatos por canal"
                    className="w-full bg-ios-card border border-ios-separator rounded-xl py-2.5 px-3 text-[14px] focus:outline-none focus:ring-1 focus:ring-ios-blue"
                >
                    <option value="">Todos os canais</option>
                    {channels.map((c) => (
                        <option key={c.id} value={c.id}>
                            {channelLabel(c)}
                        </option>
                    ))}
                </select>
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
                        onClick={() => fetchPage(null)}
                    >
                        Tentar de novo
                    </IOSButton>
                </IOSCard>
            ) : contacts.length === 0 ? (
                <IOSCard className="p-12 text-center text-ios-text-secondary">
                    <Users
                        size={44}
                        className="mx-auto mb-3 opacity-30"
                        strokeWidth={1}
                    />
                    <h3 className="text-lg font-semibold mb-1 text-ios-text">
                        Nenhum contato
                    </h3>
                    <p className="text-[13px] max-w-sm mx-auto">
                        Os contatos aparecem aqui quando alguém interage com
                        um perfil conectado. Confira a conexão dos perfis em
                        Configurações das automações se ainda não chegaram interações.
                    </p>
                </IOSCard>
            ) : (
                <div className="space-y-3">
                    {contacts.map((c) => {
                        const paused = isPaused(c);
                        const expanded = expandedId === c.id;
                        return (
                            <IOSCard key={c.id} className="p-4">
                                <div className="flex items-start gap-3">
                                    {c.profilePicture ? (
                                        // eslint-disable-next-line @next/next/no-img-element -- avatar externo (mesmo padrão dos Canais)
                                        <img
                                            src={c.profilePicture}
                                            alt={
                                                c.username || c.igUserId
                                            }
                                            className="w-11 h-11 rounded-full object-cover border border-ios-separator shrink-0"
                                        />
                                    ) : (
                                        <div className="w-11 h-11 rounded-full bg-gradient-to-tr from-yellow-400 via-red-500 to-purple-500 p-[2px] shrink-0">
                                            <div className="w-full h-full rounded-full bg-ios-card flex items-center justify-center text-[15px] font-bold text-ios-text">
                                                {(
                                                    c.username ||
                                                    c.name ||
                                                    "?"
                                                )
                                                    .charAt(0)
                                                    .toUpperCase()}
                                            </div>
                                        </div>
                                    )}
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2 flex-wrap">
                                            <h4 className="text-[15px] font-semibold text-ios-text truncate">
                                                {c.username
                                                    ? `@${c.username}`
                                                    : c.name ||
                                                      c.igUserId}
                                            </h4>
                                            {paused && (
                                                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full uppercase bg-ios-orange/15 text-ios-orange">
                                                    bot pausado
                                                </span>
                                            )}
                                        </div>
                                        <p className="text-[11px] text-ios-text-secondary font-mono truncate">
                                            ID {c.igUserId}
                                        </p>
                                        <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1 text-[11px] text-ios-text-secondary">
                                            <span>
                                                {c.interactionsCount}{" "}
                                                interações
                                            </span>
                                            {c.lastMessageAt && (
                                                <span>
                                                    última DM{" "}
                                                    {relativeTime(
                                                        c.lastMessageAt,
                                                    )}
                                                </span>
                                            )}
                                            {c.lastCommentAt && (
                                                <span>
                                                    último comentário{" "}
                                                    {relativeTime(
                                                        c.lastCommentAt,
                                                    )}
                                                </span>
                                            )}
                                            <span>
                                                canal{" "}
                                                {channelName(c.channelId)}
                                            </span>
                                        </div>
                                        {paused && c.botPausedUntil && (
                                            <p className="text-[11px] text-ios-orange mt-1">
                                                Bot pausado até{" "}
                                                {formatDateTime(
                                                    c.botPausedUntil,
                                                )}
                                            </p>
                                        )}
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            if (expanded) {
                                                setExpandedId(null);
                                            } else {
                                                setExpandedId(c.id);
                                                setNotesDraft(c.notes);
                                            }
                                        }}
                                        aria-label={
                                            expanded
                                                ? "Recolher contato"
                                                : "Expandir contato"
                                        }
                                        aria-expanded={expanded}
                                        className="p-1.5 rounded-lg text-ios-text-secondary hover:bg-ios-gray-5 shrink-0"
                                    >
                                        {expanded ? (
                                            <ChevronUp size={16} />
                                        ) : (
                                            <ChevronDown size={16} />
                                        )}
                                    </button>
                                </div>

                                {expanded && (
                                    <div className="mt-4 space-y-4 border-t border-ios-separator pt-4">
                                        {/* Tags */}
                                        <div>
                                            <p className="text-[11px] font-semibold uppercase tracking-wide text-ios-text-secondary mb-1.5">
                                                Tags
                                            </p>
                                            <KeywordChips
                                                values={c.tags}
                                                ariaLabel="Tags do contato"
                                                placeholder="Adicionar tag…"
                                                disabled={savingId === c.id}
                                                onChange={(tags) => {
                                                    updateLocal(c.id, {
                                                        tags,
                                                    });
                                                    void patchContact(c, {
                                                        tags,
                                                    });
                                                }}
                                            />
                                        </div>

                                        {/* Notas */}
                                        <div>
                                            <p className="text-[11px] font-semibold uppercase tracking-wide text-ios-text-secondary mb-1.5">
                                                Notas
                                            </p>
                                            <textarea
                                                rows={2}
                                                value={notesDraft}
                                                onChange={(e) =>
                                                    setNotesDraft(
                                                        e.target.value,
                                                    )
                                                }
                                                placeholder="Anotações internas…"
                                                className={inputCls}
                                            />
                                            <div className="flex justify-end mt-1.5">
                                                <IOSButton
                                                    variant="secondary"
                                                    className="!py-1.5 !px-3 !text-[12px]"
                                                    disabled={
                                                        savingId === c.id ||
                                                        notesDraft ===
                                                            c.notes
                                                    }
                                                    onClick={async () => {
                                                        const notes =
                                                            notesDraft;
                                                        updateLocal(c.id, {
                                                            notes,
                                                        });
                                                        await patchContact(
                                                            c,
                                                            { notes },
                                                            "Notas salvas ✓",
                                                        );
                                                    }}
                                                >
                                                    Salvar notas
                                                </IOSButton>
                                            </div>
                                        </div>

                                        {/* Pausa/retomada */}
                                        <div className="flex flex-wrap items-center gap-2">
                                            {paused ? (
                                                <button
                                                    type="button"
                                                    onClick={() =>
                                                        resumeContact(c)
                                                    }
                                                    disabled={
                                                        savingId === c.id
                                                    }
                                                    className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-ios-green/10 text-ios-green text-[13px] font-semibold hover:bg-ios-green/20 disabled:opacity-40"
                                                >
                                                    {savingId === c.id ? (
                                                        <Loader2
                                                            size={14}
                                                            className="animate-spin"
                                                        />
                                                    ) : (
                                                        <Play size={14} />
                                                    )}
                                                    Retomar bot
                                                </button>
                                            ) : (
                                                <>
                                                    <select
                                                        value={pauseHours}
                                                        onChange={(e) =>
                                                            setPauseHours(
                                                                e.target
                                                                    .value,
                                                            )
                                                        }
                                                        aria-label="Duração da pausa"
                                                        className="bg-ios-background border border-ios-separator rounded-lg px-2 py-2 text-[13px] focus:border-ios-blue outline-none"
                                                    >
                                                        {PAUSE_OPTIONS.map(
                                                            (o) => (
                                                                <option
                                                                    key={
                                                                        o.value
                                                                    }
                                                                    value={
                                                                        o.value
                                                                    }
                                                                >
                                                                    {
                                                                        o.label
                                                                    }
                                                                </option>
                                                            ),
                                                        )}
                                                    </select>
                                                    <button
                                                        type="button"
                                                        onClick={() =>
                                                            pauseContact(c)
                                                        }
                                                        disabled={
                                                            savingId ===
                                                            c.id
                                                        }
                                                        className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-ios-orange/10 text-ios-orange text-[13px] font-semibold hover:bg-ios-orange/20 disabled:opacity-40"
                                                    >
                                                        {savingId === c.id ? (
                                                            <Loader2
                                                                size={14}
                                                                className="animate-spin"
                                                            />
                                                        ) : (
                                                            <Pause
                                                                size={14}
                                                            />
                                                        )}
                                                        Pausar bot
                                                    </button>
                                                </>
                                            )}
                                        </div>
                                    </div>
                                )}
                            </IOSCard>
                        );
                    })}

                    {nextCursor && (
                        <div className="flex justify-center pt-2">
                            <IOSButton
                                variant="secondary"
                                className="!py-2 !px-4 flex items-center gap-2"
                                disabled={loadingMore}
                                onClick={() => fetchPage(nextCursor)}
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
