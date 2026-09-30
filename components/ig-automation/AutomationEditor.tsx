"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
    AlertTriangle,
    ArrowLeft,
    Bot,
    Clock,
    Loader2,
    Save,
    SlidersHorizontal,
    Sparkles,
    Tags,
    Zap,
} from "lucide-react";
import IOSButton from "@/components/IOSButton";
import IOSCard from "@/components/IOSComponents";
import IOSSwitch from "@/components/IOSSwitch";
import IOSToast from "@/components/IOSToast";
import KeywordChips from "./KeywordChips";
import ActionListEditor from "./ActionListEditor";
import SimulatorPanel from "./SimulatorPanel";
import type {
    AutomationPayload,
    ChannelLite,
    IgActionDraft,
    IgMatchMode,
    IgMatchType,
    IgTrigger,
    SimplestOption,
} from "./types";
import {
    ACTION_TYPES,
    ApiError,
    MATCH_MODE_LABELS,
    MATCH_TYPES,
    MATCH_TYPE_LABELS,
    TRIGGERS,
    TRIGGER_LABELS,
    apiFetch,
    asString,
    channelLabel,
    extractItems,
    isRecord,
    newActionDraft,
    normalizeAutomation,
    normalizeChannel,
    normalizeSequence,
    normalizeOutboundWebhook,
    serializeActionPayload,
} from "./types";

const inputCls =
    "w-full bg-ios-background border border-ios-separator rounded-lg p-2 text-sm focus:border-ios-blue outline-none placeholder:text-gray-400";

function Field({
    label,
    hint,
    children,
}: {
    label: string;
    hint?: string;
    children: React.ReactNode;
}) {
    return (
        <div>
            <label className="text-xs font-medium text-ios-text mb-1 block">
                {label}
            </label>
            {children}
            {hint && (
                <p className="text-[11px] text-ios-text-secondary mt-1">
                    {hint}
                </p>
            )}
        </div>
    );
}

function SwitchRow({
    label,
    hint,
    checked,
    onChange,
    disabled,
}: {
    label: string;
    hint?: string;
    checked: boolean;
    onChange: (next: boolean) => void;
    disabled?: boolean;
}) {
    return (
        <div className="flex items-start justify-between gap-4 py-1">
            <div className="min-w-0">
                <p className="text-sm font-medium text-ios-text">{label}</p>
                {hint && (
                    <p className="text-[11px] text-ios-text-secondary">
                        {hint}
                    </p>
                )}
            </div>
            <IOSSwitch
                checked={checked}
                onChange={onChange}
                disabled={disabled}
                ariaLabel={label}
            />
        </div>
    );
}

interface AutomationEditorProps {
    automationId?: string;
    initialSimulatorOpen?: boolean;
    defaultTrigger?: IgTrigger;
}

export default function AutomationEditor({
    automationId,
    initialSimulatorOpen = false,
    defaultTrigger = "comment",
}: AutomationEditorProps) {
    const router = useRouter();
    const editing = Boolean(automationId);

    const [loading, setLoading] = useState(editing);
    const [loadError, setLoadError] = useState("");
    const [saving, setSaving] = useState(false);
    const [formErrors, setFormErrors] = useState<string[]>([]);

    const [channels, setChannels] = useState<ChannelLite[]>([]);
    const [channelsError, setChannelsError] = useState("");
    const [sequences, setSequences] = useState<SimplestOption[]>([]);
    const [webhooks, setWebhooks] = useState<SimplestOption[]>([]);

    // Form
    const [name, setName] = useState("");
    const [channelId, setChannelId] = useState("");
    const [enabled, setEnabled] = useState(true);
    const [priority, setPriority] = useState("0");
    const [trigger, setTrigger] = useState<IgTrigger>(defaultTrigger);
    const [keywords, setKeywords] = useState<string[]>([]);
    const [matchMode, setMatchMode] = useState<IgMatchMode>("any");
    const [matchType, setMatchType] = useState<IgMatchType>("contains");
    const [negatives, setNegatives] = useState<string[]>([]);
    const [mediaIds, setMediaIds] = useState("");
    const [firstInteractionOnly, setFirstInteractionOnly] = useState(false);
    const [cooldown, setCooldown] = useState("");
    const [dailyLimit, setDailyLimit] = useState("");
    const [quietEnabled, setQuietEnabled] = useState(false);
    const [quietStart, setQuietStart] = useState("23:00");
    const [quietEnd, setQuietEnd] = useState("07:00");
    const [quietTz, setQuietTz] = useState("America/Bahia");
    const [substanceCatalog, setSubstanceCatalog] = useState(false);
    const [settingsExtra, setSettingsExtra] = useState<Record<string, unknown>>(
        {},
    );
    const [actions, setActions] = useState<IgActionDraft[]>(() => [
        newActionDraft("dm_text", 0),
    ]);

    const [toast, setToast] = useState<{
        msg: string;
        type: "success" | "error";
    } | null>(null);
    const closeToast = useCallback(() => setToast(null), []);
    const showToast = useCallback(
        (msg: string, type: "success" | "error" = "success") => {
            setToast({ msg, type });
        },
        [],
    );

    // Canais (GET /api/channels — somente Instagram).
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const raw = await apiFetch<unknown>("/api/channels");
                const list = extractItems(raw, ["channels"]).map(
                    normalizeChannel,
                );
                const ig = list.filter(
                    (c) => c.platform.toLowerCase() === "instagram",
                );
                if (!cancelled) setChannels(ig);
            } catch (e: unknown) {
                if (!cancelled) {
                    setChannelsError(
                        e instanceof Error
                            ? e.message
                            : "Falha ao carregar canais.",
                    );
                }
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    // Sequências e webhooks de saída (best-effort: falha não bloqueia o editor).
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const raw = await apiFetch<unknown>("/api/ig/sequences");
                if (!cancelled) {
                    setSequences(
                        extractItems(raw, ["sequences", "items"])
                            .map(normalizeSequence)
                            .map((s) => ({ id: s.id, name: s.name })),
                    );
                }
            } catch {
                /* aba Sequências cobre o detalhe */
            }
            try {
                const raw = await apiFetch<unknown>(
                    "/api/ig/outbound-webhooks",
                );
                if (!cancelled) {
                    setWebhooks(
                        extractItems(raw, ["webhooks", "items"])
                            .map(normalizeOutboundWebhook)
                            .map((w) => ({ id: w.id, name: w.name })),
                    );
                }
            } catch {
                /* Config cobre o detalhe */
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    // Automação existente (modo edição).
    useEffect(() => {
        if (!automationId) return;
        let cancelled = false;
        setLoading(true);
        setLoadError("");
        apiFetch<unknown>(`/api/automations/${automationId}`)
            .then((raw) => {
                const a = normalizeAutomation(raw);
                if (cancelled) return;
                setName(a.name);
                setChannelId(a.channelId);
                setEnabled(a.enabled);
                setPriority(String(a.priority));
                setTrigger(a.trigger);
                setKeywords(a.keywords);
                setMatchMode(a.matchMode);
                setMatchType(a.matchType);
                setNegatives(a.negativeKeywords);
                setMediaIds(a.mediaIds.join("\n"));
                setFirstInteractionOnly(a.firstInteractionOnly);
                setCooldown(
                    a.cooldownHours === null ? "" : String(a.cooldownHours),
                );
                setDailyLimit(
                    a.dailyLimit === null ? "" : String(a.dailyLimit),
                );
                if (a.quietHours) {
                    setQuietEnabled(true);
                    setQuietStart(a.quietHours.start);
                    setQuietEnd(a.quietHours.end);
                    setQuietTz(a.quietHours.tz);
                }
                setSubstanceCatalog(
                    a.settings.substanceCatalog === true,
                );
                setSettingsExtra(a.settings);
                setActions(
                    a.actions.length > 0
                        ? a.actions
                        : [newActionDraft("dm_text", 0)],
                );
            })
            .catch((e: unknown) => {
                if (cancelled) return;
                if (e instanceof ApiError && e.status === 404) {
                    setLoadError("Automação não encontrada.");
                } else {
                    setLoadError(
                        e instanceof Error
                            ? e.message
                            : "Falha ao carregar a automação.",
                    );
                }
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [automationId]);

    const mediaIdList = useMemo(
        () =>
            mediaIds
                .split(/[\n,]+/)
                .map((m) => m.trim())
                .filter(Boolean),
        [mediaIds],
    );

    function validate(): string[] {
        const errs: string[] = [];
        if (!channelId) errs.push("Selecione o canal do Instagram.");
        if (!name.trim()) errs.push("Informe um nome para a automação.");
        if (quietEnabled && (!quietStart || !quietEnd)) {
            errs.push("Preencha o início e o fim das quiet hours.");
        }
        if (actions.length === 0) {
            errs.push("Adicione pelo menos uma ação.");
        }
        actions.forEach((a, i) => {
            const label = `Ação ${i + 1}`;
            if (ACTION_TYPES.includes(a.type)) {
                if (
                    [
                        "public_comment_reply",
                        "private_reply",
                        "dm_text",
                        "dm_buttons",
                        "dm_quick_replies",
                        "dm_media",
                    ].includes(a.type) &&
                    a.textVariants.filter((t) => t.trim() !== "").length === 0
                ) {
                    errs.push(`${label}: informe pelo menos uma variação de texto.`);
                }
                if (a.type === "dm_media" && !a.mediaUrl.trim()) {
                    errs.push(`${label}: informe a URL da mídia.`);
                }
                if (a.type === "ai_reply" && !a.aiPrompt.trim()) {
                    errs.push(`${label}: informe o prompt da IA.`);
                }
                if (a.type === "assign_tag" && !a.tag.trim()) {
                    errs.push(`${label}: informe a tag.`);
                }
                if (a.type === "start_sequence" && !a.sequenceId) {
                    errs.push(`${label}: selecione a sequência.`);
                }
                if (a.type === "outbound_webhook" && !a.webhookId) {
                    errs.push(`${label}: selecione o webhook de saída.`);
                }
                if (
                    ["private_reply", "dm_buttons"].includes(a.type) &&
                    a.buttons.some(
                        (b) =>
                            !b.title.trim() ||
                            (b.type === "web_url" && !b.url?.trim()) ||
                            (b.type === "postback" && !b.payload?.trim()),
                    )
                ) {
                    errs.push(
                        `${label}: preencha título e link/payload de todos os botões.`,
                    );
                }
            }
        });
        return errs;
    }

    /** Payload canônico do formulário: usado ao salvar e como rascunho do simulador. */
    function buildPayload(): AutomationPayload {
        return {
            channelId,
            name: name.trim(),
            enabled,
            priority: Math.round(Number(priority) || 0),
            trigger,
            keywords,
            matchMode,
            matchType,
            negativeKeywords: negatives,
            mediaIds: mediaIdList,
            firstInteractionOnly,
            cooldownHours:
                cooldown.trim() === ""
                    ? null
                    : Math.max(0, Math.round(Number(cooldown) || 0)),
            dailyLimit:
                dailyLimit.trim() === ""
                    ? null
                    : Math.max(0, Math.round(Number(dailyLimit) || 0)),
            quietHours: quietEnabled
                ? {
                      start: quietStart,
                      end: quietEnd,
                      tz: quietTz.trim() || "America/Bahia",
                  }
                : null,
            settings: { ...settingsExtra, substanceCatalog },
            actions: actions.map((a, i) =>
                serializeActionPayload(a, i, "camel"),
            ),
        };
    }

    async function save() {
        const errs = validate();
        setFormErrors(errs);
        if (errs.length > 0) {
            showToast(errs[0], "error");
            return;
        }
        setSaving(true);
        const payload = buildPayload();
        try {
            if (editing && automationId) {
                await apiFetch<unknown>(`/api/automations/${automationId}`, {
                    method: "PATCH",
                    body: JSON.stringify(payload),
                });
                showToast("Automação atualizada ✓");
                setFormErrors([]);
            } else {
                const raw = await apiFetch<unknown>("/api/automations", {
                    method: "POST",
                    body: JSON.stringify(payload),
                });
                const rec = isRecord(raw) ? raw : {};
                const nested = isRecord(rec.automation) ? rec.automation : {};
                const newId = asString(rec.id) || asString(nested.id);
                showToast("Automação criada ✓");
                if (newId) {
                    router.push(`/automations/${newId}`);
                } else {
                    router.push("/automations");
                }
            }
        } catch (e: unknown) {
            const msg =
                e instanceof Error ? e.message : "Falha ao salvar automação.";
            showToast(msg, "error");
        } finally {
            setSaving(false);
        }
    }

    if (loading) {
        return (
            <div className="flex justify-center p-20">
                <div className="w-8 h-8 border-2 border-ios-blue border-t-transparent rounded-full animate-spin" />
            </div>
        );
    }

    if (loadError) {
        return (
            <div className="space-y-4 pb-8">
                <Link
                    href="/automations"
                    className="inline-flex items-center gap-1.5 text-[14px] text-ios-blue hover:underline"
                >
                    <ArrowLeft size={16} /> Voltar para Automações
                </Link>
                <IOSCard className="p-8 text-center">
                    <AlertTriangle
                        size={36}
                        className="mx-auto mb-3 text-ios-orange opacity-70"
                    />
                    <p className="text-[15px] font-semibold text-ios-text mb-1">
                        {loadError}
                    </p>
                    <p className="text-[13px] text-ios-text-secondary mb-4">
                        Verifique sua conexão e tente novamente.
                    </p>
                    <IOSButton
                        variant="secondary"
                        className="mx-auto !py-2 !px-4"
                        onClick={() => router.refresh()}
                    >
                        Tentar de novo
                    </IOSButton>
                </IOSCard>
            </div>
        );
    }

    return (
        <div className="space-y-6 pb-8">
            <IOSToast
                message={toast?.msg ?? ""}
                type={toast?.type}
                isVisible={toast !== null}
                onClose={closeToast}
            />

            {/* Header */}
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                <div className="min-w-0">
                    <Link
                        href="/automations"
                        className="inline-flex items-center gap-1.5 text-[13px] text-ios-blue hover:underline mb-1"
                    >
                        <ArrowLeft size={14} /> Automações
                    </Link>
                    <h1 className="text-[28px] sm:text-[34px] font-bold text-ios-text truncate">
                        {editing ? "Editar automação" : "Nova automação"}
                    </h1>
                    <p className="text-ios-text-secondary text-sm">
                        Configure gatilhos, respostas e limites anti-bloqueio
                    </p>
                </div>
                <IOSButton
                    variant="primary"
                    className="!py-2 !px-4 flex items-center gap-1 shrink-0"
                    onClick={save}
                    disabled={saving}
                >
                    {saving ? (
                        <Loader2 size={16} className="animate-spin" />
                    ) : (
                        <Save size={16} />
                    )}
                    {saving ? "Salvando…" : "Salvar"}
                </IOSButton>
            </div>

            {formErrors.length > 0 && (
                <div
                    role="alert"
                    className="p-3 rounded-xl bg-ios-red/10 border border-ios-red/30 text-[13px] text-ios-red space-y-1"
                >
                    {formErrors.map((e, i) => (
                        <p key={i} className="flex items-start gap-1.5">
                            <AlertTriangle
                                size={14}
                                className="shrink-0 mt-0.5"
                            />
                            {e}
                        </p>
                    ))}
                </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
                <div className="lg:col-span-2 space-y-6">
                    {/* Básico */}
                    <IOSCard className="p-5 space-y-4">
                        <div className="flex items-center gap-2">
                            <div className="w-9 h-9 rounded-xl bg-ios-blue/10 flex items-center justify-center text-ios-blue">
                                <Bot size={18} />
                            </div>
                            <h2 className="text-[17px] font-bold text-ios-text">
                                Básico
                            </h2>
                        </div>
                        <Field
                            label="Canal do Instagram *"
                            hint={
                                channelsError
                                    ? `Aviso: ${channelsError}`
                                    : "Somente contas profissionais do Instagram."
                            }
                        >
                            <select
                                value={channelId}
                                onChange={(e) => setChannelId(e.target.value)}
                                className={inputCls}
                                aria-label="Canal do Instagram"
                            >
                                <option value="">
                                    Selecione um canal…
                                </option>
                                {channels.map((c) => (
                                    <option key={c.id} value={c.id}>
                                        {channelLabel(c)}
                                        {c.status !== "active"
                                            ? ` (${c.status})`
                                            : ""}
                                    </option>
                                ))}
                            </select>
                        </Field>
                        <Field label="Nome *">
                            <input
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                placeholder="Ex.: Comentário → link do produto"
                                className={inputCls}
                            />
                        </Field>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <Field
                                label="Prioridade"
                                hint="Maior valor é avaliado primeiro."
                            >
                                <input
                                    type="number"
                                    value={priority}
                                    onChange={(e) =>
                                        setPriority(e.target.value)
                                    }
                                    className={inputCls}
                                />
                            </Field>
                            <div className="flex items-center justify-between pt-5">
                                <span className="text-sm font-medium text-ios-text">
                                    Automação ativa
                                </span>
                                <IOSSwitch
                                    checked={enabled}
                                    onChange={setEnabled}
                                    ariaLabel="Automação ativa"
                                />
                            </div>
                        </div>
                    </IOSCard>

                    {/* Gatilho */}
                    <IOSCard className="p-5 space-y-4">
                        <div className="flex items-center gap-2">
                            <div className="w-9 h-9 rounded-xl bg-ios-green/10 flex items-center justify-center text-ios-green">
                                <Zap size={18} />
                            </div>
                            <h2 className="text-[17px] font-bold text-ios-text">
                                Gatilho e matching
                            </h2>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                            <Field label="Gatilho">
                                <select
                                    value={trigger}
                                    onChange={(e) =>
                                        setTrigger(
                                            e.target.value as IgTrigger,
                                        )
                                    }
                                    className={inputCls}
                                >
                                    {TRIGGERS.map((t) => (
                                        <option key={t} value={t}>
                                            {TRIGGER_LABELS[t]}
                                        </option>
                                    ))}
                                </select>
                            </Field>
                            <Field label="Modo de match">
                                <select
                                    value={matchMode}
                                    onChange={(e) =>
                                        setMatchMode(
                                            e.target.value as IgMatchMode,
                                        )
                                    }
                                    className={inputCls}
                                >
                                    {(
                                        Object.keys(
                                            MATCH_MODE_LABELS,
                                        ) as IgMatchMode[]
                                    ).map((m) => (
                                        <option key={m} value={m}>
                                            {MATCH_MODE_LABELS[m]}
                                        </option>
                                    ))}
                                </select>
                            </Field>
                            <Field label="Tipo de match">
                                <select
                                    value={matchType}
                                    onChange={(e) =>
                                        setMatchType(
                                            e.target.value as IgMatchType,
                                        )
                                    }
                                    className={inputCls}
                                >
                                    {MATCH_TYPES.map((m) => (
                                        <option key={m} value={m}>
                                            {MATCH_TYPE_LABELS[m]}
                                        </option>
                                    ))}
                                </select>
                            </Field>
                        </div>
                        <Field
                            label="Keywords"
                            hint="Vazio = responde a qualquer texto. Normalização ignora acentos e maiúsculas."
                        >
                            <KeywordChips
                                values={keywords}
                                onChange={setKeywords}
                                ariaLabel="Keywords da automação"
                                placeholder="Ex.: link, quero, preço"
                            />
                        </Field>
                        <Field
                            label="Palavras negativas"
                            hint="Se qualquer uma casar, a automação não responde."
                        >
                            <KeywordChips
                                values={negatives}
                                onChange={setNegatives}
                                ariaLabel="Palavras negativas"
                                placeholder="Ex.: golpe, spam"
                            />
                        </Field>
                        <Field
                            label="Posts específicos (media_ids)"
                            hint="Um ID por linha. Vazio = qualquer post."
                        >
                            <textarea
                                rows={2}
                                value={mediaIds}
                                onChange={(e) => setMediaIds(e.target.value)}
                                placeholder={"17895695668004550\n…"}
                                className={`${inputCls} font-mono`}
                            />
                        </Field>
                        <SwitchRow
                            label="Somente primeira interação"
                            hint="Responde apenas se o contato nunca interagiu com o canal."
                            checked={firstInteractionOnly}
                            onChange={setFirstInteractionOnly}
                        />
                    </IOSCard>

                    {/* Anti-bloqueio */}
                    <IOSCard className="p-5 space-y-4">
                        <div className="flex items-center gap-2">
                            <div className="w-9 h-9 rounded-xl bg-ios-orange/10 flex items-center justify-center text-ios-orange">
                                <Clock size={18} />
                            </div>
                            <h2 className="text-[17px] font-bold text-ios-text">
                                Cooldown e limites
                            </h2>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <Field
                                label="Cooldown por contato (horas)"
                                hint="Vazio = usa o padrão global."
                            >
                                <input
                                    type="number"
                                    min={0}
                                    value={cooldown}
                                    onChange={(e) =>
                                        setCooldown(e.target.value)
                                    }
                                    placeholder="24"
                                    className={inputCls}
                                />
                            </Field>
                            <Field
                                label="Limite diário por contato"
                                hint="Vazio = usa o padrão global (0 = sem limite)."
                            >
                                <input
                                    type="number"
                                    min={0}
                                    value={dailyLimit}
                                    onChange={(e) =>
                                        setDailyLimit(e.target.value)
                                    }
                                    placeholder="0"
                                    className={inputCls}
                                />
                            </Field>
                        </div>
                        <SwitchRow
                            label="Quiet hours"
                            hint="Não responde dentro da janela de silêncio."
                            checked={quietEnabled}
                            onChange={setQuietEnabled}
                        />
                        {quietEnabled && (
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                                <Field label="Início">
                                    <input
                                        type="time"
                                        value={quietStart}
                                        onChange={(e) =>
                                            setQuietStart(e.target.value)
                                        }
                                        className={inputCls}
                                    />
                                </Field>
                                <Field label="Fim">
                                    <input
                                        type="time"
                                        value={quietEnd}
                                        onChange={(e) =>
                                            setQuietEnd(e.target.value)
                                        }
                                        className={inputCls}
                                    />
                                </Field>
                                <Field label="Fuso (tz)">
                                    <input
                                        value={quietTz}
                                        onChange={(e) =>
                                            setQuietTz(e.target.value)
                                        }
                                        placeholder="America/Bahia"
                                        className={`${inputCls} font-mono`}
                                    />
                                </Field>
                            </div>
                        )}
                    </IOSCard>

                    {/* Ações */}
                    <IOSCard className="p-5 space-y-4">
                        <div className="flex items-center gap-2">
                            <div className="w-9 h-9 rounded-xl bg-purple-500/10 flex items-center justify-center text-purple-500">
                                <SlidersHorizontal size={18} />
                            </div>
                            <div>
                                <h2 className="text-[17px] font-bold text-ios-text">
                                    Ações
                                </h2>
                                <p className="text-[11px] text-ios-text-secondary">
                                    Executadas na ordem, com delay acumulado.
                                </p>
                            </div>
                        </div>
                        <ActionListEditor
                            actions={actions}
                            onChange={setActions}
                            sequences={sequences}
                            webhooks={webhooks}
                        />
                    </IOSCard>

                    {/* Avançado */}
                    <IOSCard className="p-5 space-y-4">
                        <div className="flex items-center gap-2">
                            <div className="w-9 h-9 rounded-xl bg-ios-teal/10 flex items-center justify-center text-ios-teal">
                                <Sparkles size={18} />
                            </div>
                            <h2 className="text-[17px] font-bold text-ios-text">
                                Avançado
                            </h2>
                        </div>
                        <SwitchRow
                            label="Detectar substância no catálogo"
                            hint="Consulta o catálogo de substâncias pelo texto e injeta {substancia.*} nas respostas."
                            checked={substanceCatalog}
                            onChange={setSubstanceCatalog}
                        />
                        <p className="text-[11px] text-ios-text-secondary flex items-center gap-1">
                            <Tags size={11} /> As tags são aplicadas nos
                            contatos e visíveis na aba Contatos.
                        </p>
                    </IOSCard>
                </div>

                {/* Simulador lateral */}
                <div className="lg:sticky lg:top-4">
                    <SimulatorPanel
                        channelId={channelId}
                        defaultOpen={initialSimulatorOpen}
                        defaultKind={trigger}
                        onToast={showToast}
                        draft={buildPayload()}
                    />
                </div>
            </div>
        </div>
    );
}
