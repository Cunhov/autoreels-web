"use client";
import { cloneElement, isValidElement, useCallback, useEffect, useId, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
    AlertTriangle,
    ArrowLeft,
    Bot,
    Clock,
    Loader2,
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
import ProfilePostPicker from "./ProfilePostPicker";
import MessagePreview from "./MessagePreview";
import { actionsForTemplate, EDITOR_TEMPLATES, type EditorTemplate } from "./editor-templates";
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
    normalizeSubstance,
    serializeActionPayload,
} from "./types";

const inputCls =
    "w-full bg-ios-background border border-ios-separator rounded-lg p-2 text-sm focus:border-ios-blue outline-none placeholder:text-gray-400";
const HTTP_URL_RE = /^https?:\/\/\S+$/i;

function isValidActionUrl(value: string | undefined): boolean {
    if (!value || !HTTP_URL_RE.test(value.trim())) return false;
    try {
        const parsed = new URL(value.trim());
        return (parsed.protocol === "http:" || parsed.protocol === "https:") && Boolean(parsed.hostname);
    } catch {
        return false;
    }
}

function resolveProfileReference(
    profileId: string,
    map: Record<string, string> | undefined,
    legacyId: string,
    options: SimplestOption[],
): string {
    const hasProfileValue = Boolean(map && Object.prototype.hasOwnProperty.call(map, profileId));
    const referenceId = hasProfileValue ? map?.[profileId] ?? "" : legacyId;
    if (!referenceId) return "";
    const option = options.find((item) => item.id === referenceId);
    if (hasProfileValue) {
        // Keep an existing profile-keyed reference if the options request is
        // unavailable, but reject a known reference owned by another profile.
        return !option || !option.channelId || option.channelId === profileId ? referenceId : "";
    }
    // A legacy scalar reference is safe only when its owner is global or this
    // profile. Never copy another profile's scalar value into this profile.
    return option && (!option.channelId || option.channelId === profileId) ? referenceId : "";
}

function Field({
    label,
    hint,
    children,
}: {
    label: string;
    hint?: string;
    children: React.ReactNode;
}) {
    const id = useId();
    const nativeControl = isValidElement<{ id?: string }>(children) && typeof children.type === "string";
    const controlId = nativeControl && isValidElement<{ id?: string }>(children)
        ? children.props.id ?? id
        : undefined;
    const control = nativeControl && isValidElement<{ id?: string }>(children)
        ? cloneElement(children, { id: controlId })
        : children;
    return (
        <div>
            {nativeControl ? (
                <label htmlFor={controlId} className="text-xs font-medium text-ios-text mb-1 block">
                    {label}
                </label>
            ) : (
                <p className="text-xs font-medium text-ios-text mb-1">{label}</p>
            )}
            {control}
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
    const [channelIds, setChannelIds] = useState<string[]>([]);
    const [mediaIdsByChannel, setMediaIdsByChannel] = useState<Record<string, string[]>>({});
    const [postScopeByChannel, setPostScopeByChannel] = useState<Record<string, "all" | "selected">>({});
    const [enabled, setEnabled] = useState(false);
    const [priority, setPriority] = useState("0");
    const [trigger, setTrigger] = useState<IgTrigger>(defaultTrigger);
    const [legacyTrigger, setLegacyTrigger] = useState("");
    const [legacyActions, setLegacyActions] = useState<Record<string, unknown>[]>([]);
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
    const [step, setStep] = useState(0);
    const [template, setTemplate] = useState<EditorTemplate | null>(null);
    const [profileQuery, setProfileQuery] = useState("");
    const [savedFingerprint, setSavedFingerprint] = useState<string | null>(null);
    const [refreshBaseline, setRefreshBaseline] = useState(false);
    const [webhookSummary, setWebhookSummary] = useState<{ loading: boolean; text: string }>({ loading: true, text: "Verificando conexão…" });
    const [globalMode, setGlobalMode] = useState("Modo global desconhecido");
    const [catalogCount, setCatalogCount] = useState<number|null>(null);
    const [testChannelId, setTestChannelId] = useState("");
    const [simulationResult, setSimulationResult] = useState<import("./types").IgSimulationResult|null>(null);

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
                            .map((s) => ({ id: s.id, name: s.name, channelId: s.channelId })),
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
                            .map((w) => ({ id: w.id, name: w.name, channelId: w.channelId ?? undefined })),
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
                const source=isRecord(raw)?raw:{};
                const rawTrigger=asString(source.trigger);
                setLegacyTrigger(rawTrigger && !(TRIGGERS as string[]).includes(rawTrigger) ? rawTrigger : "");
                const rawActions=Array.isArray(source.actions)?source.actions:[];
                setLegacyActions(rawActions.filter((item):item is Record<string,unknown>=>isRecord(item)&&!(ACTION_TYPES as string[]).includes(asString(item.type))));
                setRefreshBaseline(true);
                setName(a.name);
                setChannelId(a.channelId);
                setChannelIds(a.channelIds.length ? a.channelIds : [a.channelId].filter(Boolean));
                setMediaIdsByChannel(a.mediaIdsByChannel);
                setPostScopeByChannel(Object.fromEntries(a.channelIds.map(id=>[id,(a.mediaIdsByChannel[id]??[]).length?"selected":"all"])));
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
                setActions(a.actions.filter(action=>(ACTION_TYPES as string[]).includes(action.type)).length > 0
                        ? a.actions.filter(action=>(ACTION_TYPES as string[]).includes(action.type))
                        : rawActions.some(item=>isRecord(item)&&!(ACTION_TYPES as string[]).includes(asString(item.type))) ? [] : [newActionDraft("dm_text", 0)]);
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
    const formFingerprint = useMemo(() => JSON.stringify({name, channelId, channelIds, mediaIds, mediaIdsByChannel, postScopeByChannel, enabled, priority, trigger, legacyTrigger, keywords, matchMode, matchType, negatives, firstInteractionOnly, cooldown, dailyLimit, quietEnabled, quietStart, quietEnd, quietTz, substanceCatalog, settingsExtra, actions, legacyActions, template}), [name, channelId, channelIds, mediaIds, mediaIdsByChannel, postScopeByChannel, enabled, priority, trigger, legacyTrigger, keywords, matchMode, matchType, negatives, firstInteractionOnly, cooldown, dailyLimit, quietEnabled, quietStart, quietEnd, quietTz, substanceCatalog, settingsExtra, actions, legacyActions, template]);
    const dirty = savedFingerprint !== null && savedFingerprint !== formFingerprint;

    const visibleChannels = useMemo(() => channels.filter(c => `${channelLabel(c)} ${c.username}`.toLowerCase().includes(profileQuery.toLowerCase())), [channels, profileQuery]);
    useEffect(() => { if (channelIds.length && !channelIds.includes(channelId)) setChannelId(channelIds[0]); }, [channelIds, channelId]);
    useEffect(() => { if (!channelIds.includes(testChannelId)) setTestChannelId(channelIds[0] ?? ""); }, [channelIds, testChannelId]);
    useEffect(() => { let cancelled=false; apiFetch<unknown>("/api/ig/webhook-status").then(raw=>{ if(cancelled)return; const rows=Array.isArray(raw)?raw:(isRecord(raw)&&Array.isArray(raw.channels)?raw.channels:[]); const selected=rows.filter(isRecord).filter((x:any)=>channelIds.includes(String(x.channelId??x.channel_id??""))); const connected=selected.filter((x:any)=>String(x.status??"").toLowerCase()==="ok").length; setWebhookSummary({loading:false,text:selected.length?`${connected} de ${selected.length} perfil(is) com webhook conectado`:"Status de conexão indisponível"}); }).catch(()=>{if(!cancelled)setWebhookSummary({loading:false,text:"Status de conexão indisponível"});}); return()=>{cancelled=true;}; }, [channelIds]);
    useEffect(()=>{let cancelled=false;apiFetch<unknown>("/api/ig/settings").then(raw=>{if(cancelled)return;const o=isRecord(raw)&&isRecord(raw.settings)?raw.settings:isRecord(raw)?raw:{};setGlobalMode(o.enabled===false?"Automações pausadas no sistema":o.dryRun===true||o.dry_run===true?"Modo de teste global ativo":o.dryRun===false||o.dry_run===false?"Modo global de envio real":"Modo global desconhecido");}).catch(()=>{if(!cancelled)setGlobalMode("Modo global desconhecido");});return()=>{cancelled=true;};},[]);
    useEffect(()=>{if(!substanceCatalog&&template!=="catalog")return;let cancelled=false;apiFetch<unknown>("/api/ig/substances").then(raw=>{if(cancelled)return;const list=extractItems(raw,["substances","items"]).map(normalizeSubstance);setCatalogCount(list.filter(item=>item.enabled).length);}).catch(()=>{if(!cancelled)setCatalogCount(null);});return()=>{cancelled=true;};},[substanceCatalog,template]);
    useEffect(()=>{if(savedFingerprint===null&&(!editing||!loading))setSavedFingerprint(formFingerprint);},[savedFingerprint,editing,loading,formFingerprint]);
    useEffect(()=>{if(refreshBaseline){setSavedFingerprint(formFingerprint);setRefreshBaseline(false);}},[refreshBaseline,formFingerprint]);
    useEffect(()=>{if(!formErrors.length)return;const frame=requestAnimationFrame(()=>{const target=document.querySelector<HTMLElement>("[aria-invalid='true']")??document.querySelector<HTMLElement>("[role='alert']");target?.scrollIntoView({behavior:"smooth",block:"center"});target?.focus({preventScroll:true});});return()=>cancelAnimationFrame(frame);},[formErrors,step]);
    useEffect(() => { if (!dirty) return; const guard=(event:BeforeUnloadEvent)=>{ event.preventDefault(); event.returnValue=""; }; window.addEventListener("beforeunload",guard); return()=>window.removeEventListener("beforeunload",guard); }, [dirty]);
    useEffect(()=>{if(!dirty)return;const guard=(event:MouseEvent)=>{if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;const target=event.target instanceof Element?event.target.closest("a[href]"):null;if(!(target instanceof HTMLAnchorElement)||target.target==="_blank"||target.hasAttribute("download"))return;const url=new URL(target.href,window.location.href);if(url.origin!==window.location.origin||url.pathname===window.location.pathname||url.hash&&url.pathname===window.location.pathname)return;if(!window.confirm("Há alterações não salvas. Sair e descartá-las?")){event.preventDefault();event.stopPropagation();return;}setSavedFingerprint(formFingerprint);};document.addEventListener("click",guard,true);return()=>document.removeEventListener("click",guard,true);},[dirty,formFingerprint]);

    function validate(): string[] {
        const errs: string[] = [];
        if (!channelIds.length) errs.push("Selecione ao menos um perfil do Instagram.");
        channelIds.forEach(id=>{if(postScopeByChannel[id]==="selected"&&!(mediaIdsByChannel[id]??[]).length)errs.push(`${channelLabel(channels.find(c=>c.id===id)??{id,name:id,platform:"instagram",username:"",accountId:"",status:""})}: selecione ao menos um post ou escolha Todos.`);});
        if (!name.trim()) errs.push("Informe um nome para a automação.");
        if (quietEnabled && (!quietStart || !quietEnd)) {
            errs.push("Preencha o início e o fim do horário de silêncio.");
        }
        if (actions.length === 0 && legacyActions.length === 0) {
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
                if (a.type === "start_sequence") {
                    channelIds.forEach((profileId) => {
                        const sequenceId = resolveProfileReference(profileId, a.sequenceIdsByChannel, a.sequenceId, sequences);
                        if (!sequenceId) {
                            const profile = channels.find((channel) => channel.id === profileId);
                            errs.push(`${label}: selecione uma sequência para ${profile ? channelLabel(profile) : profileId}.`);
                        }
                    });
                }
                if (a.type === "outbound_webhook") {
                    channelIds.forEach((profileId) => {
                        const webhookId = resolveProfileReference(profileId, a.webhookIdsByChannel, a.webhookId, webhooks);
                        if (!webhookId) {
                            const profile = channels.find((channel) => channel.id === profileId);
                            errs.push(`${label}: selecione um webhook de saída para ${profile ? channelLabel(profile) : profileId}.`);
                        }
                    });
                }
                if (
                    ["private_reply", "dm_buttons"].includes(a.type) &&
                    a.buttons.some(
                        (b) =>
                            !b.title.trim() ||
                            (b.type === "web_url" && !isValidActionUrl(b.url)) ||
                            (b.type === "postback" && !b.payload?.trim()),
                    )
                ) {
                    errs.push(
                        `${label}: preencha título e link ou código de resposta de todos os botões.`,
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
            channelIds,
            mediaIdsByChannel: Object.fromEntries(channelIds.map(id => [id, mediaIdsByChannel[id] ?? []])),
            name: name.trim(),
            enabled,
            priority: Math.round(Number(priority) || 0),
            trigger: (legacyTrigger || trigger) as IgTrigger,
            keywords,
            matchMode,
            matchType,
            negativeKeywords: negatives,
            mediaIds: mediaIdsByChannel[channelId] ?? mediaIdList,
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
            actions: [...actions.map((a, i) => {const serialized=serializeActionPayload(a,i,"camel");const config=isRecord(serialized.config)?serialized.config:{};return {...serialized,config:{...config,sequenceIdsByChannel:Object.fromEntries(Object.entries(a.sequenceIdsByChannel??{}).filter(([id])=>channelIds.includes(id))),webhookIdsByChannel:Object.fromEntries(Object.entries(a.webhookIdsByChannel??{}).filter(([id])=>channelIds.includes(id)))}};}), ...legacyActions],
        };
    }

    function buildSimulationDraft(): AutomationPayload {
        const payload = buildPayload();
        return {
            ...payload,
            channelId: testChannelId,
            mediaIds: mediaIdsByChannel[testChannelId] ?? [],
            actions: payload.actions.map((serialized, index) => {
                const original = actions[index];
                if (!original) return serialized;
                const config = isRecord(serialized.config) ? serialized.config : {};
                const sequenceId = resolveProfileReference(
                    testChannelId,
                    original.sequenceIdsByChannel,
                    original.sequenceId,
                    sequences,
                );
                const webhookId = resolveProfileReference(
                    testChannelId,
                    original.webhookIdsByChannel,
                    original.webhookId,
                    webhooks,
                );
                return {
                    ...serialized,
                    sequenceId,
                    webhookId,
                    config: { ...config, sequenceId, webhookId },
                };
            }),
        };
    }

    async function save(statusOverride?: boolean) {
        const errs = validate();
        setFormErrors(errs);
        if (errs.length > 0) {
            if (errs.some(e=>e.includes("perfil")||e.includes("post"))) setStep(1);
            else if (errs.some(e=>e.includes("nome"))) setStep(0);
            else setStep(3);
            showToast(errs[0], "error");
            return;
        }
        setSaving(true);
        const payload = { ...buildPayload(), ...(statusOverride === undefined ? {} : { enabled: statusOverride }) };
        try {
            if (editing && automationId) {
                await apiFetch<unknown>(`/api/automations/${automationId}`, {
                    method: "PATCH",
                    body: JSON.stringify(payload),
                });
                showToast("Automação atualizada ✓");
                setFormErrors([]);
                setEnabled(payload.enabled);
                setRefreshBaseline(true);
            } else {
                const raw = await apiFetch<unknown>("/api/automations", {
                    method: "POST",
                    body: JSON.stringify(payload),
                });
                const rec = isRecord(raw) ? raw : {};
                const nested = isRecord(rec.automation) ? rec.automation : {};
                const newId = asString(rec.id) || asString(nested.id);
                showToast("Automação criada ✓");
                setSavedFingerprint(formFingerprint);
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

    function leaveEditor() {
        if (dirty && !window.confirm("Há alterações não salvas. Sair e descartá-las?")) return;
        setSavedFingerprint(formFingerprint);
        router.push("/automations");
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
        <fieldset disabled={saving} className="min-w-0 border-0 space-y-6 pb-28">
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
                <div className="text-right text-xs text-ios-text-secondary">{enabled ? "Ativada · envio condicionado" : "Pausada"}<br/>{webhookSummary.text}</div>
            </div>

            <nav aria-label="Etapas da automação" className="sticky top-0 z-20 bg-ios-background/95 backdrop-blur border-y border-ios-separator py-2">
                <ol className="grid grid-cols-5 gap-1 max-w-4xl mx-auto">
                    {["Objetivo", "Perfis e posts", "Quando responder", "Mensagem e ações", "Revisar e testar"].map((label, i) => (
                        <li key={label}>
                            <button
                                type="button"
                                onClick={() => setStep(i)}
                                aria-label={`Etapa ${i + 1}: ${label}`}
                                aria-current={step === i ? "step" : undefined}
                                className={`w-full min-h-11 px-1 rounded-lg text-[11px] sm:text-sm font-medium ${step === i ? "bg-ios-blue text-white" : "text-ios-text-secondary hover:bg-ios-gray-5"}`}
                            >
                                <span className="sm:hidden">{i + 1}</span>
                                <span className="hidden sm:inline">{i + 1}. {label}</span>
                            </button>
                        </li>
                    ))}
                </ol>
            </nav>

            {formErrors.length > 0 && (
                <div
                    role="alert"
                    tabIndex={-1}
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
                    {step===0&&<>
                    {!editing&&<IOSCard className="p-5"><h2 className="text-[17px] font-bold text-ios-text mb-3">Como você quer começar?</h2><div className="grid grid-cols-1 sm:grid-cols-2 gap-3">{EDITOR_TEMPLATES.map(item=><button key={item.id} type="button" aria-pressed={template===item.id} onClick={()=>{setTemplate(item.id);setTrigger(item.trigger);setName(item.name);const next=actionsForTemplate(item.id);if(next)setActions(next);if(item.id==="catalog")setSubstanceCatalog(true);setEnabled(false);}} className={`min-h-24 text-left rounded-xl border p-3 transition-colors ${template===item.id?"border-ios-blue bg-ios-blue/10 ring-2 ring-ios-blue/25":"border-ios-separator hover:bg-ios-gray-5"}`}><span className="font-semibold text-sm text-ios-text block">{item.title}</span><span className="text-xs text-ios-text-secondary">{item.description}</span></button>)}</div></IOSCard>}
                    <IOSCard className="p-5 space-y-4">
                        <div className="flex items-center gap-2">
                            <div className="w-9 h-9 rounded-xl bg-ios-blue/10 flex items-center justify-center text-ios-blue">
                                <Bot size={18} />
                            </div>
                            <h2 className="text-[17px] font-bold text-ios-text">
                                Básico
                            </h2>
                        </div>
                        <p className="text-xs text-ios-text-secondary">Perfis do Instagram e posts são escolhidos na próxima etapa.</p>
                        <Field label="Nome *">
                            <input
                                value={name}
                                maxLength={120}
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
                    </>}

                    {step===1&&<IOSCard className="p-5 space-y-4"><div><h2 className="text-[17px] font-bold text-ios-text">Perfis e posts</h2><p className="text-xs text-ios-text-secondary">A mesma regra será aplicada aos perfis selecionados.</p></div>
                        <Field label="Buscar perfis"><input value={profileQuery} onChange={e=>setProfileQuery(e.target.value)} placeholder="Nome ou @usuário" className={inputCls} aria-invalid={formErrors.some(error=>error.includes("perfil")||error.includes("post"))}/></Field>
                        <div className="flex flex-wrap gap-2"><button type="button" onClick={()=>setChannelIds(channels.map(c=>c.id))} className="min-h-11 px-3 rounded-lg border border-ios-separator text-sm">Selecionar todos</button><button type="button" onClick={()=>setChannelIds([])} className="min-h-11 px-3 rounded-lg border border-ios-separator text-sm">Limpar seleção</button><span className="self-center text-xs text-ios-text-secondary">{channelIds.length} perfil(is) selecionado(s)</span></div>
                        {channelsError&&<p className="text-sm text-ios-orange">{channelsError}</p>}{visibleChannels.length===0&&<p className="text-sm text-ios-text-secondary">Nenhum perfil do Instagram encontrado.</p>}
                        <div className="space-y-2">{visibleChannels.map(c=><label key={c.id} className="flex items-center gap-3 min-h-12 rounded-xl border border-ios-separator p-3"><input type="checkbox" className="w-5 h-5 accent-blue-600" checked={channelIds.includes(c.id)} onChange={e=>setChannelIds(current=>e.target.checked?[...current,c.id]:current.filter(id=>id!==c.id))}/><span className="min-w-0 flex-1"><span className="block text-sm font-medium text-ios-text">{channelLabel(c)}</span><span className="text-xs text-ios-text-secondary">@{c.username} · {c.status}</span></span></label>)}</div>
                        {trigger==="comment"?<ProfilePostPicker channels={channels} selectedIds={channelIds} mediaIdsByChannel={mediaIdsByChannel} scopeByChannel={postScopeByChannel} onChange={setMediaIdsByChannel} onScopeChange={setPostScopeByChannel}/>:<details className="rounded-xl border border-ios-separator p-3"><summary className="cursor-pointer min-h-8 text-sm font-medium text-ios-text">Restrições de posts existentes</summary><p className="text-xs text-ios-text-secondary my-2">Estas restrições foram preservadas da configuração anterior.</p><ProfilePostPicker channels={channels} selectedIds={channelIds} mediaIdsByChannel={mediaIdsByChannel} scopeByChannel={postScopeByChannel} onChange={setMediaIdsByChannel} onScopeChange={setPostScopeByChannel}/></details>}
                    </IOSCard>}

                    {/* Gatilho */}
                    {step===2&&<>
                    <IOSCard className="p-5 space-y-4">
                        <div className="flex items-center gap-2">
                            <div className="w-9 h-9 rounded-xl bg-ios-green/10 flex items-center justify-center text-ios-green">
                                <Zap size={18} />
                            </div>
                            <h2 className="text-[17px] font-bold text-ios-text">
                                Quando a automação responde
                            </h2>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                            <Field label="Gatilho">
                                <select
                                    value={trigger}
                                    onChange={(e) =>
                                        (setLegacyTrigger(""), setTrigger(e.target.value as IgTrigger))
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
                            <Field label="Quais palavras devem aparecer">
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
                            <Field label="Como comparar o texto">
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
                            label="Palavras que ativam a resposta"
                            hint="Sem palavras, responde a qualquer texto. Não diferencia acentos ou letras maiúsculas."
                        >
                            <KeywordChips
                                values={keywords}
                                onChange={setKeywords}
                                ariaLabel="Palavras-chave da automação"
                                placeholder="Ex.: link, quero, preço"
                            />
                        </Field>
                        <Field
                            label="Palavras negativas"
                            hint="Se encontrar alguma destas palavras, a automação não responde."
                        >
                            <KeywordChips
                                values={negatives}
                                onChange={setNegatives}
                                ariaLabel="Palavras negativas"
                                placeholder="Ex.: golpe, spam"
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
                    <details className="rounded-xl border border-ios-separator bg-ios-background p-4"><summary className="cursor-pointer min-h-10 text-[16px] font-semibold text-ios-text">Opções avançadas e limites</summary><div className="space-y-4 mt-4">
                    <IOSCard className="p-5 space-y-4">
                        <div className="flex items-center gap-2">
                            <div className="w-9 h-9 rounded-xl bg-ios-orange/10 flex items-center justify-center text-ios-orange">
                                <Clock size={18} />
                            </div>
                            <h2 className="text-[17px] font-bold text-ios-text">
                                Intervalos e limites
                            </h2>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <Field
                                label="Intervalo por contato (horas)"
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
                            label="Horário de silêncio"
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
                                <Field label="Fuso horário" hint="Escolha uma sugestão ou informe outro fuso.">
                                    <input
                                        value={quietTz}
                                        onChange={(e) =>
                                            setQuietTz(e.target.value)
                                        }
                                        placeholder="America/Bahia" list="automation-timezones"
                                        className={`${inputCls} font-mono`}
                                    />
                                    <datalist id="automation-timezones"><option value="America/Bahia">Brasília</option><option value="America/Manaus">Manaus</option><option value="America/Rio_Branco">Rio Branco</option><option value="Europe/Lisbon">Lisboa</option><option value="UTC">UTC</option></datalist>
                                </Field>
                            </div>
                        )}
                    </IOSCard>
                    </div></details></>}

                    {/* Ações */}
                    {step===3&&<>
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
                            profileChannels={channels.filter(c=>channelIds.includes(c.id))}
                        />
                    </IOSCard>
                    <MessagePreview result={null} actions={actions} profileLabel={channels.find(c=>c.id===channelIds[0])?.username}/>
                    </>}

                    {/* Avançado */}
                    {step===3&&<details className="rounded-xl border border-ios-separator bg-ios-background p-4"><summary className="cursor-pointer min-h-10 text-[16px] font-semibold text-ios-text">Configuração avançada</summary><IOSCard className="p-5 space-y-4 mt-4">
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
                    </details>}

                    {step===4&&<IOSCard className="p-5 space-y-4"><h2 className="text-[18px] font-bold text-ios-text">Revise sua automação</h2><dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm"><div><dt className="text-ios-text-secondary">Objetivo</dt><dd className="font-medium text-ios-text">{name||"Sem nome"}</dd></div><div><dt className="text-ios-text-secondary">Perfis</dt><dd className="font-medium text-ios-text">{channelIds.map(id=>channelLabel(channels.find(c=>c.id===id)??{id,name:id,platform:"instagram",username:"",accountId:"",status:""})).join(", ")||"Nenhum selecionado"}</dd></div><div><dt className="text-ios-text-secondary">Quando</dt><dd className="font-medium text-ios-text">{legacyTrigger||TRIGGER_LABELS[trigger]||String(trigger)} · {keywords.length?keywords.join(", "):"qualquer texto"}</dd></div><div><dt className="text-ios-text-secondary">Ações</dt><dd className="font-medium text-ios-text">{actions.length+legacyActions.length} ação(ões)</dd></div><div><dt className="text-ios-text-secondary">Estado ao salvar</dt><dd className="font-medium text-ios-text">{enabled?"Ativada; envio depende das configurações globais":"Pausada"}</dd></div><div><dt className="text-ios-text-secondary">Conexão</dt><dd className="font-medium text-ios-text">{webhookSummary.loading?"Verificando…":webhookSummary.text}</dd></div><div><dt className="text-ios-text-secondary">Modo global do Instagram</dt><dd className="font-medium text-ios-text">{globalMode}</dd></div></dl><div className="rounded-xl bg-ios-orange/10 p-3 text-sm text-ios-text">Uma automação ativa pode continuar sem enviar quando o modo de teste global estiver ligado ou a conexão falhar. Conexão webhook não confirma entrega.</div><div className="flex flex-col sm:flex-row gap-3"><IOSButton variant="secondary" className="!min-h-11" onClick={()=>save(false)} disabled={saving}>{saving?"Salvando…":"Salvar pausada"}</IOSButton><IOSButton variant="primary" className="!min-h-11" onClick={()=>save(true)} disabled={saving}>{saving?"Salvando…":"Salvar e ativar"}</IOSButton></div>{(template==="catalog"||substanceCatalog)&&catalogCount===0&&<p role="status" className="rounded-lg bg-ios-orange/10 p-3 text-sm text-ios-text">O catálogo está vazio. <Link href="/automations?tab=catalogo" className="text-ios-blue underline">Adicionar itens ao catálogo</Link> antes de usar dados de substâncias.</p>}</IOSCard>}
                </div>

                {/* Simulador lateral */}
                {step===4&&<div className="lg:sticky lg:top-4 space-y-3">
                    <Field label="Perfil para o teste"><select value={testChannelId} onChange={e=>setTestChannelId(e.target.value)} className={inputCls}>{channelIds.map(id=><option key={id} value={id}>{channelLabel(channels.find(c=>c.id===id)??{id,name:id,platform:"instagram",username:"",accountId:"",status:""})}</option>)}</select></Field>
                    <SimulatorPanel
                        channelId={testChannelId}
                        profileLabel={channels.find(c=>c.id===testChannelId)?.username}
                        defaultOpen={step === 4 || initialSimulatorOpen}
                        defaultKind={trigger}
                        onToast={showToast}
                        draft={buildSimulationDraft()}
                        onResultChange={setSimulationResult}
                    />
                    <MessagePreview result={simulationResult} actions={actions} profileLabel={channels.find(c=>c.id===testChannelId)?.username}/>
                </div>}
            </div>
            <div className="fixed bottom-[calc(4.5rem+env(safe-area-inset-bottom))] md:bottom-0 md:left-64 md:w-[calc(100%-16rem)] inset-x-0 z-30 border-t border-ios-separator bg-ios-background/95 backdrop-blur p-3 pb-[max(env(safe-area-inset-bottom),0.75rem)]"><div className="max-w-5xl mx-auto flex gap-3"><button type="button" onClick={()=>step===0?leaveEditor():setStep(s=>Math.max(0,s-1))} className="min-h-11 px-4 rounded-xl border border-ios-separator text-sm font-medium text-ios-text">{step===0?"Sair":"Voltar"}</button>{step<4?<button type="button" onClick={()=>{if(step===0&&!name.trim()){setFormErrors(["Informe um nome para a automação."]);return;}if(step===1){if(!channelIds.length){setFormErrors(["Selecione ao menos um perfil do Instagram."]);return;}const noPosts=channelIds.filter(id=>postScopeByChannel[id]==="selected"&&!(mediaIdsByChannel[id]??[]).length).map(id=>`${channelLabel(channels.find(c=>c.id===id)??{id,name:id,platform:"instagram",username:"",accountId:"",status:""})}: selecione um post ou escolha Todos.`);if(noPosts.length){setFormErrors(noPosts);return;}}setFormErrors([]);setStep(s=>Math.min(4,s+1));window.scrollTo({top:0,behavior:"smooth"});}} className="flex-1 min-h-11 rounded-xl bg-ios-blue text-white text-sm font-semibold">Próxima etapa</button>:<button type="button" onClick={()=>save(false)} disabled={saving} className="flex-1 min-h-11 rounded-xl bg-ios-blue text-white text-sm font-semibold disabled:opacity-50">{saving?"Salvando…":"Salvar pausada"}</button>}</div></div>
        </fieldset>
    );
}
