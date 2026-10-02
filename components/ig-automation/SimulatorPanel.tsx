"use client";
import { useEffect, useRef, useState } from "react";
import {
    Bot,
    FlaskConical,
    Loader2,
    Play,
    Send,
    Webhook,
    XCircle,
    CheckCircle2,
    ChevronDown,
    ChevronUp,
} from "lucide-react";
import IOSButton from "@/components/IOSButton";
import IOSCard from "@/components/IOSComponents";
import type { AutomationPayload, IgSimulationResult, IgTrigger } from "./types";
import {
    ACTION_TYPE_LABELS,
    TRIGGER_LABELS,
    TRIGGERS,
    apiFetch,
    normalizeSimulation,
} from "./types";

const inputCls =
    "w-full bg-ios-background border border-ios-separator rounded-lg p-2 text-sm focus:border-ios-blue outline-none placeholder:text-gray-400";

const GATE_LABELS: Record<string, string> = {
    trigger: "Tipo de evento",
    channel: "Perfil selecionado",
    kill_switch: "Automações globais",
    media_ids: "Publicação selecionada",
    first_interaction_only: "Primeira interação",
    negatives: "Palavras a ignorar",
    keywords: "Palavras-chave",
    substance: "Catálogo de produtos",
    quiet_hours: "Horário permitido",
    bot_pause: "Pausa manual do contato",
    cooldown: "Intervalo entre mensagens",
    daily_limit: "Limite diário do contato",
    rate_limit: "Limite de envios do perfil",
};

function gateReason(reason: string): string {
    if (reason === "gatilho incompatível") return "O evento é de outro tipo.";
    if (reason === "post fora da lista") return "Este post não está selecionado nesta regra.";
    if (reason === "não é a primeira interação") return "Este contato já interagiu antes.";
    if (reason === "contém palavra negativa") return "O texto contém um termo excluído.";
    if (reason === "sem match de palavra-chave") return "Nenhuma palavra-chave corresponde ao texto.";
    if (reason === "horário de silêncio") return "O horário atual está dentro do período de silêncio.";
    if (reason === "contato pausado") return "As respostas estão pausadas para este contato.";
    if (reason === "cooldown ativo") return "Ainda não passou o intervalo entre mensagens.";
    if (reason === "limite diário atingido") return "Este contato atingiu o limite diário.";
    if (reason === "throttled") return "O perfil atingiu o limite temporário de envios.";
    if (reason === "sem match de substância") return "Nenhum item do catálogo corresponde ao texto.";
    return reason;
}

interface SimulatorPanelProps {
    channelId: string;
    mediaIds?: string[];
    defaultOpen?: boolean;
    defaultKind?: IgTrigger;
    onToast?: (msg: string, type: "success" | "error") => void;
    /**
     * FIX-A7: rascunho da automação em edição (formato do POST /api/automations).
     * Avaliado com prioridade máxima pelo simulador, mesmo sem salvar.
     */
    draft?: AutomationPayload | null;
    onResultChange?: (result: IgSimulationResult | null) => void;
    profileLabel?: string;
}

/**
 * Simulador de eventos (§11: POST /api/automations/simulate). Mostra os gates
 * reais (✅/⛔) e as ações renderizadas, sem efeitos colaterais.
 */
export default function SimulatorPanel({
    channelId,
    mediaIds = [],
    defaultOpen = false,
    defaultKind = "comment",
    onToast,
    draft = null,
    onResultChange,
    profileLabel,
}: SimulatorPanelProps) {
    const [open, setOpen] = useState(defaultOpen);
    const [kind, setKind] = useState<IgTrigger>(defaultKind);
    const [text, setText] = useState("");
    const [mediaId, setMediaId] = useState("");
    const [username, setUsername] = useState("");
    const [igUserId, setIgUserId] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [result, setResult] = useState<IgSimulationResult | null>(null);
    const draftKey = JSON.stringify(draft);
    const mediaIdsKey = JSON.stringify(mediaIds);
    const inputKey = JSON.stringify([channelId, mediaIdsKey, draftKey, kind, text, mediaId, username, igUserId]);
    const generation = useRef(0);
    const onResultChangeRef = useRef(onResultChange);
    onResultChangeRef.current = onResultChange;

    useEffect(() => {
        setKind(defaultKind);
    }, [defaultKind]);

    useEffect(() => {
        setMediaId(mediaIds[0] ?? "");
    }, [channelId, mediaIdsKey]);

    useEffect(() => {
        generation.current += 1;
        setResult(null);
        setError("");
        onResultChangeRef.current?.(null);
    }, [inputKey]);

    function updateResult(next: IgSimulationResult | null) {
        setResult(next);
        onResultChangeRef.current?.(next);
    }

    async function requestSimulation(includeDraft: boolean) {
        const raw = await apiFetch<unknown>("/api/automations/simulate", {
            method: "POST",
            body: JSON.stringify({
                channelId,
                kind,
                text,
                mediaId: mediaId.trim() || undefined,
                username: username.trim() || undefined,
                igUserId: igUserId.trim() || undefined,
                ...(includeDraft && draft ? { draft } : {}),
            }),
        });
        return normalizeSimulation(raw);
    }

    async function run() {
        setError("");
        updateResult(null);
        if (!channelId) {
            setError("Selecione um canal antes de testar.");
            return;
        }
        setLoading(true);
        const requestGeneration = ++generation.current;
        try {
            const next = await requestSimulation(true);
            if (generation.current === requestGeneration) updateResult(next);
        } catch (e: unknown) {
            const msg =
                e instanceof Error ? e.message : "Falha ao simular o evento.";
            if (generation.current === requestGeneration) {
                setError(msg);
                onToast?.(msg, "error");
            }
        } finally {
            setLoading(false);
        }
    }

    return (
        <IOSCard className="p-4">
            <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                aria-expanded={open}
                aria-controls="ig-simulator-body"
                className="w-full flex items-center gap-2 text-left"
            >
                <div className="w-9 h-9 rounded-xl bg-purple-500/10 flex items-center justify-center text-purple-500 shrink-0">
                    <FlaskConical size={18} />
                </div>
                <div className="flex-1 min-w-0">
                    <h3 className="text-[15px] font-bold text-ios-text">
                        Simulador
                    </h3>
                    <p className="text-[11px] text-ios-text-secondary">
                        {draft ? `Rascunho: ${draft.name || "sem nome"}` : "Teste um evento sem disparar nada"}
                    </p>
                    <p className="text-[10px] text-ios-text-secondary truncate">{profileLabel || `Perfil ${channelId.slice(0, 8)}`}{draft ? " · não salvo" : ""}</p>
                </div>
                {open ? (
                    <ChevronUp size={18} className="text-ios-text-secondary" />
                ) : (
                    <ChevronDown
                        size={18}
                        className="text-ios-text-secondary"
                    />
                )}
            </button>

            {open && (
                <div id="ig-simulator-body" className="mt-4 space-y-3">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                            <label className="text-xs font-medium text-ios-text mb-1 block">
                                Tipo de evento
                            </label>
                            <select
                                value={kind}
                                onChange={(e) => setKind(e.target.value as IgTrigger)}
                                className={inputCls}
                            >
                                {TRIGGERS.map((t) => (
                                    <option key={t} value={t}>
                                        {TRIGGER_LABELS[t]}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <div>
                            <label className="text-xs font-medium text-ios-text mb-1 block">
                                @username (opcional)
                            </label>
                            <input
                                value={username}
                                onChange={(e) => setUsername(e.target.value)}
                                placeholder="ex.: cliente_teste"
                                className={inputCls}
                            />
                        </div>
                    </div>

                    <div>
                        <label className="text-xs font-medium text-ios-text mb-1 block">
                            Texto recebido
                        </label>
                        <textarea
                            rows={2}
                            value={text}
                            onChange={(e) => setText(e.target.value)}
                            placeholder="Ex.: quero o link do produto"
                            className={inputCls}
                        />
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                            <label className="text-xs font-medium text-ios-text mb-1 block">
                                {mediaIds.length > 0 ? "Post para o teste" : "ID do post para o teste (opcional)"}
                            </label>
                            {mediaIds.length > 0 ? (
                                <select
                                    value={mediaId}
                                    onChange={(e) => setMediaId(e.target.value)}
                                    className={inputCls}
                                >
                                    <option value="">Nenhum post</option>
                                    {mediaIds.map((id, index) => (
                                        <option key={id} value={id}>
                                            Post selecionado {index + 1}… ({id.length > 18 ? `${id.slice(0, 15)}…` : id})
                                        </option>
                                    ))}
                                </select>
                            ) : (
                                <input
                                    value={mediaId}
                                    onChange={(e) => setMediaId(e.target.value)}
                                    placeholder="ID do post"
                                    className={`${inputCls} font-mono`}
                                />
                            )}
                        </div>
                        <div>
                            <label className="text-xs font-medium text-ios-text mb-1 block">
                                ID do contato no Instagram (opcional)
                            </label>
                            <input
                                value={igUserId}
                                onChange={(e) => setIgUserId(e.target.value)}
                                placeholder="ID do usuário"
                                className={`${inputCls} font-mono`}
                            />
                        </div>
                    </div>

                    <IOSButton
                        variant="primary"
                        className="w-full !py-2.5 flex items-center justify-center gap-2"
                        onClick={run}
                        disabled={loading}
                    >
                        {loading ? (
                            <Loader2 size={16} className="animate-spin" />
                        ) : (
                            <Play size={16} />
                        )}
                        {loading ? "Simulando…" : "Simular evento"}
                    </IOSButton>

                    {error && (
                        <div
                            role="alert"
                            className="p-3 rounded-xl bg-ios-orange/10 border border-ios-orange/30 text-[12px] text-ios-orange break-words"
                        >
                            {error}
                        </div>
                    )}

                    {result && (
                        <div className="space-y-3">
                            {/* Automação que casou */}
                            {result.matched ? (
                                <div className="p-3 rounded-xl bg-ios-green/10 border border-ios-green/30">
                                    <p className="text-[12px] font-semibold text-ios-green flex items-center gap-1.5 flex-wrap">
                                        <Bot size={14} />{" "}
                                        {result.matched.name}
                                        {result.matched.automationId ===
                                            "draft" && (
                                            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-ios-blue/10 text-ios-blue font-semibold">
                                                Rascunho
                                            </span>
                                        )}
                                        {result.matched.automationId !== "draft" && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-ios-gray-5 text-ios-text-secondary">Regra salva</span>}
                                    </p>
                                    <p className="text-[10px] text-ios-text-secondary font-mono truncate">
                                        {result.matched.automationId}
                                    </p>
                                </div>
                            ) : (
                                <div className="p-3 rounded-xl bg-ios-gray-5/60 border border-ios-separator">
                                    <p className="text-[12px] font-medium text-ios-text-secondary">
                                        Nenhuma automação corresponde a este evento.
                                    </p>
                                </div>
                            )}

                            {/* Gates */}
                            {result.gates.length > 0 && (
                                <div>
                                    <p className="text-[11px] font-semibold uppercase tracking-wide text-ios-text-secondary mb-1.5">
                                Verificações
                                    </p>
                                    <ul className="space-y-1">
                                        {result.gates.map((g, i) => (
                                            <li
                                                key={`${g.gate}-${i}`}
                                                className="flex items-start gap-1.5 text-[12px]"
                                            >
                                                {g.passed ? (
                                                    <CheckCircle2
                                                        size={13}
                                                        className="text-ios-green shrink-0 mt-0.5"
                                                    />
                                                ) : (
                                                    <XCircle
                                                        size={13}
                                                        className="text-ios-red shrink-0 mt-0.5"
                                                    />
                                                )}
                                                <span className="text-ios-text">
                                                    {GATE_LABELS[g.gate] ?? g.gate}
                                                    {g.reason && (
                                                        <span className="text-ios-text-secondary">
                                                            {" — "}
                                                            {gateReason(g.reason)}
                                                        </span>
                                                    )}
                                                </span>
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}

                            {/* Contato simulado */}
                            {(result.contact.username ||
                                result.contact.igUserId) && (
                                <div className="text-[11px] text-ios-text-secondary">
                                    Contato:{" "}
                                    {result.contact.username
                                        ? `@${result.contact.username}`
                                        : result.contact.igUserId}{" "}
                                    ·{" "}
                                    {result.contact.firstInteraction
                                        ? "primeira interação"
                                        : "já interagiu antes"}
                                </div>
                            )}

                            {/* Ações renderizadas */}
                            {result.actions.length > 0 && (
                                <div>
                                    <p className="text-[11px] font-semibold uppercase tracking-wide text-ios-text-secondary mb-1.5">
                                        Ações ({result.actions.length})
                                    </p>
                                    <div className="space-y-2">
                                        {result.actions.map((a, i) => (
                                            <div
                                                key={
                                                    a.actionId ||
                                                    `${a.type}-${i}`
                                                }
                                                className="p-2.5 rounded-lg bg-ios-background border border-ios-separator"
                                            >
                                                <div className="flex items-center gap-1.5 flex-wrap">
                                                    <Send
                                                        size={12}
                                                        className="text-ios-blue"
                                                    />
                                                    <span className="text-[12px] font-semibold text-ios-text">
                                                        {ACTION_TYPE_LABELS[
                                                            a.type
                                                        ] ?? a.type}
                                                    </span>
                                                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-ios-blue/10 text-ios-blue font-medium">
                                                        em
                                                        {" "}
                                                        {Math.round(
                                                            a.runAtOffsetMs /
                                                                1000,
                                                        )}
                                                        s
                                                    </span>
                                                    {a.target && (
                                                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-ios-gray-5 text-ios-text-secondary">
                                                            {a.target}
                                                        </span>
                                                    )}
                                                </div>
                                                {a.renderedText && (
                                                    <p className="mt-1.5 text-[12px] text-ios-text whitespace-pre-wrap break-words">
                                                        {a.renderedText}
                                                    </p>
                                                )}
                                                {(a.buttons?.length ?? 0) >
                                                    0 && (
                                                    <div className="mt-1.5 flex flex-wrap gap-1">
                                                        {a.buttons?.map(
                                                            (b, bi) => (
                                                                <span
                                                                    key={bi}
                                                                    className="text-[10px] px-2 py-0.5 rounded-full border border-ios-blue/40 text-ios-blue"
                                                                >
                                                                    {b.title}
                                                                </span>
                                                            ),
                                                        )}
                                                    </div>
                                                )}
                                                {(a.quickReplies?.length ??
                                                    0) > 0 && (
                                                    <div className="mt-1.5 flex flex-wrap gap-1">
                                                        {a.quickReplies?.map(
                                                            (q, qi) => (
                                                                <span
                                                                    key={qi}
                                                                    className="text-[10px] px-2 py-0.5 rounded-full bg-ios-gray-5 text-ios-text-secondary"
                                                                >
                                                                    {q.title}
                                                                </span>
                                                            ),
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {result.actions.some(
                                (a) => a.type === "outbound_webhook",
                            ) && (
                                <p className="text-[10px] text-ios-text-secondary flex items-center gap-1">
                                    <Webhook size={11} /> Webhooks de saída não
                                    são disparados na simulação.
                                </p>
                            )}
                        </div>
                    )}
                </div>
            )}
        </IOSCard>
    );
}
