"use client";
import { useState } from "react";
import {
    ChevronDown,
    ChevronUp,
    Plus,
    Trash2,
    X,
} from "lucide-react";
import IOSSwitch from "@/components/IOSSwitch";
import type {
    ChannelLite,
    IgActionDraft,
    IgActionType,
    IgButton,
    SimplestOption,
} from "./types";
import {
    ACTION_TYPES,
    ACTION_TYPE_LABELS,
    TEXT_ACTION_TYPES,
    newActionDraft,
} from "./types";

const inputCls =
    "w-full bg-ios-background border border-ios-separator rounded-lg p-2 text-sm focus:border-ios-blue outline-none placeholder:text-gray-400";

const BUTTON_ACTION_TYPES: IgActionType[] = ["private_reply", "dm_buttons"];
const QUICK_REPLY_ACTION_TYPES: IgActionType[] = ["dm_quick_replies"];
const DURATION_UNITS = [
    { id: "seconds", label: "segundos", factor: 1 },
    { id: "minutes", label: "minutos", factor: 60 },
    { id: "hours", label: "horas", factor: 3600 },
    { id: "days", label: "dias", factor: 86400 },
] as const;

function actionLabel(type: IgActionType): string {
    if (type === "private_reply") return "Enviar no privado após comentário";
    if (type === "dm_text") return "Mensagem privada";
    return ACTION_TYPE_LABELS[type];
}

function actionHelp(type: IgActionType): string {
    if (type === "private_reply") return "Envia uma mensagem privada em resposta ao comentário que iniciou a conversa.";
    if (type === "dm_text") return "Envia uma mensagem de texto privada para a pessoa.";
    if (type === "public_comment_reply") return "Publica uma resposta no comentário recebido.";
    if (type === "start_sequence") return "Inicia uma sequência de mensagens para este contato.";
    if (type === "outbound_webhook") return "Envia os dados desta interação para uma integração externa.";
    return "Esta ação será executada quando a regra corresponder.";
}

function FieldLabel({
    children,
    hint,
}: {
    children: React.ReactNode;
    hint?: string;
}) {
    return (
        <div className="mb-1">
            <p className="text-xs font-medium text-ios-text block">
                {children}
            </p>
            {hint && (
                <p className="text-[11px] text-ios-text-secondary">{hint}</p>
            )}
        </div>
    );
}

interface ActionListEditorProps {
    actions: IgActionDraft[];
    onChange: (next: IgActionDraft[]) => void;
    sequences?: SimplestOption[];
    webhooks?: SimplestOption[];
    profileChannels?: ChannelLite[];
    allowedTypes?: IgActionType[];
    disabled?: boolean;
    /** Rótulo do bloco ("Ação" ou "Passo"). */
    itemNoun?: "Ação" | "Passo";
}

export default function ActionListEditor({
    actions,
    onChange,
    sequences = [],
    webhooks = [],
    profileChannels = [],
    allowedTypes = ACTION_TYPES,
    disabled = false,
    itemNoun = "Ação",
}: ActionListEditorProps) {
    const [newType, setNewType] = useState<IgActionType>(allowedTypes[0] ?? "dm_text");
    const [textSelection, setTextSelection] = useState<Record<string, { variantIndex: number; start: number; end: number }>>({});
    const [delayUnits, setDelayUnits] = useState<Record<string, (typeof DURATION_UNITS)[number]["id"]>>({});

    const update = (index: number, patch: Partial<IgActionDraft>) => {
        onChange(
            actions.map((a, i) => (i === index ? { ...a, ...patch } : a)),
        );
    };

    const move = (from: number, to: number) => {
        if (to < 0 || to >= actions.length) return;
        const next = [...actions];
        const [item] = next.splice(from, 1);
        next.splice(to, 0, item);
        onChange(next.map((a, i) => ({ ...a, position: i })));
    };

    const remove = (index: number) => {
        onChange(
            actions
                .filter((_, i) => i !== index)
                .map((a, i) => ({ ...a, position: i })),
        );
    };

    const add = () => {
        onChange([...actions, newActionDraft(newType, actions.length)]);
    };

    const variables = [
        ["{username}", "Nome de usuário"],
        ["{first_name}", "Primeiro nome"],
        ["{substancia.nome}", "Nome do catálogo"],
        ["{substancia.descricao}", "Descrição do catálogo"],
        ["{substancia.acao}", "Ação do catálogo"],
        ["{substancia.dosagem}", "Dosagem do catálogo"],
        ["{substancia.duracao}", "Duração do catálogo"],
        ["{substancia.url}", "Link do catálogo"],
    ] as const;

    const insertVariable = (action: IgActionDraft, index: number, token: string) => {
        const variants = action.textVariants.length ? [...action.textVariants] : [""];
        const actionKey = action.id ?? `${action.type}-${index}`;
        const selection = textSelection[actionKey];
        const lastIndex = variants.length - 1;
        const variantIndex = selection?.variantIndex ?? lastIndex;
        const current = variants[variantIndex] ?? "";
        const start = selection?.start ?? current.length;
        const end = selection?.end ?? current.length;
        variants[variantIndex] = `${current.slice(0, start)}${token}${current.slice(end)}`;
        update(index, { textVariants: variants });
        setTextSelection((prev) => ({ ...prev, [actionKey]: { variantIndex, start: start + token.length, end: start + token.length } }));
    };

    const referenceOptions = (options: SimplestOption[], channelId: string) => options.filter((option) => !option.channelId || option.channelId === channelId);
    const setProfileReference = (index: number, field: "sequence" | "webhook", channelId: string, value: string) => {
        const action = actions[index];
        if (!action) return;
        const mapKey = field === "sequence" ? "sequenceIdsByChannel" : "webhookIdsByChannel";
        const legacyKey = field === "sequence" ? "sequenceId" : "webhookId";
        const nextMap = { ...(action[mapKey] ?? {}) };
        if (value) nextMap[channelId] = value;
        else delete nextMap[channelId];
        update(index, { [mapKey]: nextMap, [legacyKey]: nextMap[profileChannels[0]?.id ?? channelId] ?? "" });
    };

    return (
        <div className="space-y-3">
            {actions.length === 0 && (
                <div className="p-4 rounded-xl border border-dashed border-ios-separator text-center text-[13px] text-ios-text-secondary">
                    Nenhuma {itemNoun.toLowerCase()} configurada ainda.
                </div>
            )}

            {actions.map((action, index) => {
                const actionKey = action.id ?? `${action.type}-${index}`;
                const delayUnit = DURATION_UNITS.find((unit) => unit.id === delayUnits[actionKey]) ?? DURATION_UNITS[0];
                const isText = TEXT_ACTION_TYPES.includes(action.type);
                // FIX-B4-UI: private_reply só aceita botões web_url (mesma regra
                // da validação/Graph no backend).
                const privateReply = action.type === "private_reply";
                const showButtons = BUTTON_ACTION_TYPES.includes(action.type);
                const showQuick = QUICK_REPLY_ACTION_TYPES.includes(action.type);

                return (
                    <div
                        key={action.id ?? `${action.type}-${index}`}
                        className="rounded-xl border border-ios-separator bg-ios-background p-3 space-y-3"
                    >
                        {/* Cabeçalho + ordenação */}
                        <div className="flex items-center gap-2">
                            <span className="w-6 h-6 rounded-full bg-ios-blue/15 text-ios-blue text-[11px] font-bold flex items-center justify-center shrink-0">
                                {index + 1}
                            </span>
                            <span className="text-[13px] font-semibold text-ios-text flex-1 min-w-0 truncate">
                                {actionLabel(action.type)}
                            </span>
                            <button
                                type="button"
                                onClick={() => move(index, index - 1)}
                                disabled={disabled || index === 0}
                                aria-label={`Mover ${itemNoun.toLowerCase()} ${index + 1} para cima`}
                                className="min-h-11 min-w-11 flex items-center justify-center rounded-lg text-ios-text-secondary hover:bg-ios-gray-5 transition-colors disabled:opacity-30"
                            >
                                <ChevronUp size={16} />
                            </button>
                            <button
                                type="button"
                                onClick={() => move(index, index + 1)}
                                disabled={disabled || index === actions.length - 1}
                                aria-label={`Mover ${itemNoun.toLowerCase()} ${index + 1} para baixo`}
                                className="min-h-11 min-w-11 flex items-center justify-center rounded-lg text-ios-text-secondary hover:bg-ios-gray-5 transition-colors disabled:opacity-30"
                            >
                                <ChevronDown size={16} />
                            </button>
                            <button
                                type="button"
                                onClick={() => remove(index)}
                                disabled={disabled}
                                aria-label={`Remover ${itemNoun.toLowerCase()} ${index + 1}`}
                                className="min-h-11 min-w-11 flex items-center justify-center rounded-lg text-ios-red hover:bg-ios-red/10 transition-colors disabled:opacity-30"
                            >
                                <Trash2 size={16} />
                            </button>
                        </div>

                        {/* Tipo + delay */}
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <div>
                                <FieldLabel>Tipo</FieldLabel>
                                <select
                                    aria-label={`${itemNoun} ${index + 1}: tipo`}
                                    value={action.type}
                                    disabled={disabled}
                                    onChange={(e) => {
                                        const nextType = e.target
                                            .value as IgActionType;
                                        const patch: Partial<IgActionDraft> = {
                                            type: nextType,
                                        };
                                        if (!BUTTON_ACTION_TYPES.includes(nextType)) patch.buttons = [];
                                        if (!QUICK_REPLY_ACTION_TYPES.includes(nextType)) patch.quickReplies = [];
                                        if (nextType === "private_reply") {
                                            // Converte postbacks existentes p/ web_url.
                                            patch.buttons = action.buttons.map(
                                                (b) =>
                                                    b.type === "postback"
                                                        ? {
                                                              ...b,
                                                              type: "web_url" as const,
                                                              payload: undefined,
                                                          }
                                                        : b,
                                            );
                                        }
                                        update(index, patch);
                                    }}
                                    className={inputCls}
                                >
                                    {ACTION_TYPES.filter((t) =>
                                        allowedTypes.includes(t),
                                    ).map((t) => (
                                        <option key={t} value={t}>
                                            {actionLabel(t)}
                                        </option>
                                    ))}
                                </select>
                            </div>
                            <p className="text-[11px] text-ios-text-secondary sm:col-span-2">{actionHelp(action.type)}</p>
                            <div>
                                <FieldLabel hint="Tempo aguardado antes de executar esta ação.">
                                    Espera
                                </FieldLabel>
                                <div className="grid grid-cols-[1fr_auto] gap-2">
                                    <input type="number" aria-label={`${itemNoun} ${index + 1}: espera em ${delayUnit.label}`} min={0} step="any" value={Number((action.delaySeconds / delayUnit.factor).toFixed(3))} disabled={disabled} onChange={(e) => update(index, { delaySeconds: Math.max(0, (Number(e.target.value) || 0) * delayUnit.factor) })} className={inputCls} />
                                    <select aria-label={`${itemNoun} ${index + 1}: unidade de espera`} value={delayUnit.id} disabled={disabled} onChange={(e) => setDelayUnits((prev) => ({ ...prev, [actionKey]: e.target.value as (typeof DURATION_UNITS)[number]["id"] }))} className="bg-ios-background border border-ios-separator rounded-lg px-2 text-xs"><option value="seconds">segundos</option><option value="minutes">minutos</option><option value="hours">horas</option><option value="days">dias</option></select>
                                </div>
                            </div>
                        </div>

                        {/* Variações de texto */}
                        {isText && (
                            <div className="space-y-2">
                                <FieldLabel hint="A cada envio, uma destas mensagens é escolhida.">
                                    Variações de texto
                                </FieldLabel>
                                {(action.textVariants.length ? action.textVariants : [""]).map((variant, vi) => (
                                    <div key={vi} className="space-y-1">
                                        <div className="flex items-center justify-between">
                                            <span className="text-[11px] text-ios-text-secondary">Mensagem {vi + 1}</span>
                                            {action.textVariants.length > 1 && <button type="button" disabled={disabled} onClick={() => update(index, { textVariants: action.textVariants.filter((_, j) => j !== vi) })} className="min-h-11 px-2 text-[12px] text-ios-red">Remover variação</button>}
                                        </div>
                                        <textarea
                                            rows={3}
                                            aria-label={`${itemNoun} ${index + 1}: mensagem ${vi + 1}`}
                                            value={variant}
                                            disabled={disabled}
                                            onSelect={(e) => setTextSelection((prev) => ({ ...prev, [actionKey]: { variantIndex: vi, start: e.currentTarget.selectionStart, end: e.currentTarget.selectionEnd } }))}
                                            onChange={(e) => update(index, { textVariants: (action.textVariants.length ? action.textVariants : [""]).map((text, j) => j === vi ? e.target.value : text) })}
                                            placeholder={action.type === "public_comment_reply" ? "Ex.: Oi {username}! Enviei os detalhes na sua DM 💬" : "Ex.: Oi {username}! Aqui está o que você pediu…"}
                                            className={`${inputCls} font-mono`}
                                        />
                                    </div>
                                ))}
                                <div className="flex flex-wrap gap-1.5">
                                    <span className="w-full text-[10px] text-ios-text-secondary">Inserir variável:</span>
                                    {variables.map(([value, label]) => <button key={value} type="button" disabled={disabled} title={value} onClick={() => insertVariable(action, index, value)} className="min-h-11 px-2.5 rounded-lg bg-ios-gray-5 text-[11px] text-ios-text-secondary hover:text-ios-blue">{label}</button>)}
                                </div>
                                <button type="button" disabled={disabled} onClick={() => update(index, { textVariants: [...action.textVariants, ""] })} className="min-h-11 px-2.5 rounded-lg text-[12px] font-semibold text-ios-blue hover:bg-ios-blue/10">+ Adicionar variação</button>
                            </div>
                        )}

                        {/* Mídia */}
                        {action.type === "dm_media" && (
                            <div>
                                <FieldLabel hint="URL pública da imagem enviada na DM.">
                                    URL da mídia
                                </FieldLabel>
                                <input
                                    type="url"
                                    aria-label={`${itemNoun} ${index + 1}: URL da mídia`}
                                    value={action.mediaUrl}
                                    disabled={disabled}
                                    onChange={(e) =>
                                        update(index, {
                                            mediaUrl: e.target.value,
                                        })
                                    }
                                    placeholder="https://…"
                                    className={`${inputCls} font-mono`}
                                />
                            </div>
                        )}

                        {/* Prompt IA */}
                        {action.type === "ai_reply" && (
                            <div>
                                <FieldLabel hint="Instrução para a IA gerar a resposta (usa OpenRouter).">
                                    Prompt da IA
                                </FieldLabel>
                                <textarea
                                    rows={3}
                                    aria-label={`${itemNoun} ${index + 1}: prompt da IA`}
                                    value={action.aiPrompt}
                                    disabled={disabled}
                                    onChange={(e) =>
                                        update(index, {
                                            aiPrompt: e.target.value,
                                        })
                                    }
                                    placeholder="Ex.: Responda de forma simpática e curta, tirando dúvidas sobre o produto…"
                                    className={inputCls}
                                />
                            </div>
                        )}

                        {/* Botões */}
                        {showButtons && (
                            <div className="space-y-2">
                                <FieldLabel
                                    hint={
                                        privateReply
                                            ? "Até 3 botões de link (web_url) — private reply não aceita postback."
                                            : "Até 3 botões. Links com rastreio passam pelo redirecionador /r/…"
                                    }
                                >
                                    Botões
                                </FieldLabel>
                                {action.buttons.map((button, bi) => {
                                    const buttonType: IgButton["type"] =
                                        privateReply ? "web_url" : button.type;
                                    return (
                                    <div
                                        key={bi}
                                        className="rounded-lg border border-ios-separator p-2 space-y-2 bg-ios-card"
                                    >
                                        <div className="flex items-center gap-2">
                                            <select
                                                value={buttonType}
                                                disabled={disabled}
                                                aria-label={`Tipo do botão ${bi + 1}`}
                                                onChange={(e) =>
                                                    update(index, {
                                                        buttons:
                                                            action.buttons.map(
                                                                (b, j) =>
                                                                    j === bi
                                                                        ? {
                                                                              ...b,
                                                                              type: e
                                                                                  .target
                                                                                  .value as IgButton["type"],
                                                                          }
                                                                        : b,
                                                            ),
                                                    })
                                                }
                                                className="bg-ios-background border border-ios-separator rounded-lg px-2 py-1 text-[12px] focus:border-ios-blue outline-none"
                                            >
                                                <option value="web_url">
                                                    Link (web_url)
                                                </option>
                                                {!privateReply && (
                                                    <option value="postback">
                                                        Postback
                                                    </option>
                                                )}
                                            </select>
                                            <input
                                                value={button.title}
                                                disabled={disabled}
                                                aria-label={`Título do botão ${bi + 1}`}
                                                onChange={(e) =>
                                                    update(index, {
                                                        buttons:
                                                            action.buttons.map(
                                                                (b, j) =>
                                                                    j === bi
                                                                        ? {
                                                                              ...b,
                                                                              title: e
                                                                                  .target
                                                                                  .value,
                                                                          }
                                                                        : b,
                                                            ),
                                                    })
                                                }
                                                placeholder="Título"
                                                className="flex-1 min-w-0 bg-ios-background border border-ios-separator rounded-lg px-2 py-1 text-[12px] focus:border-ios-blue outline-none"
                                            />
                                            <button
                                                type="button"
                                                onClick={() =>
                                                    update(index, {
                                                        buttons:
                                                            action.buttons.filter(
                                                                (_, j) =>
                                                                    j !== bi,
                                                            ),
                                                    })
                                                }
                                                disabled={disabled}
                                                aria-label={`Remover botão ${bi + 1}`}
                                                className="p-1 rounded text-ios-red hover:bg-ios-red/10"
                                            >
                                                <X size={14} />
                                            </button>
                                        </div>
                                        {buttonType === "web_url" ? (
                                            <input
                                                type="url"
                                                value={button.url ?? ""}
                                                disabled={disabled}
                                                aria-label={`URL do botão ${bi + 1}`}
                                                onChange={(e) =>
                                                    update(index, {
                                                        buttons:
                                                            action.buttons.map(
                                                                (b, j) =>
                                                                    j === bi
                                                                        ? {
                                                                              ...b,
                                                                              url: e
                                                                                  .target
                                                                                  .value,
                                                                          }
                                                                        : b,
                                                            ),
                                                    })
                                                }
                                                placeholder="https://…"
                                                className={`${inputCls} font-mono !text-[12px] !py-1`}
                                            />
                                        ) : (
                                            <input
                                                value={button.payload ?? ""}
                                                disabled={disabled}
                                                aria-label={`Payload do botão ${bi + 1}`}
                                                onChange={(e) =>
                                                    update(index, {
                                                        buttons:
                                                            action.buttons.map(
                                                                (b, j) =>
                                                                    j === bi
                                                                        ? {
                                                                              ...b,
                                                                              payload:
                                                                                  e
                                                                                      .target
                                                                                      .value,
                                                                          }
                                                                        : b,
                                                            ),
                                                    })
                                                }
                                                placeholder="payload do postback"
                                                className={`${inputCls} font-mono !text-[12px] !py-1`}
                                            />
                                        )}
                                        {buttonType === "web_url" && (
                                            <div className="flex items-center justify-between gap-2 text-[12px] text-ios-text-secondary">
                                                <span>
                                                    Rastrear cliques (UTM)
                                                </span>
                                                <IOSSwitch
                                                    checked={
                                                        button.track !== false
                                                    }
                                                    disabled={disabled}
                                                    ariaLabel={`Rastrear cliques do botão ${bi + 1}`}
                                                    onChange={(next) =>
                                                        update(index, {
                                                            buttons:
                                                                action.buttons.map(
                                                                    (b, j) =>
                                                                        j === bi
                                                                            ? {
                                                                                  ...b,
                                                                                  track: next,
                                                                              }
                                                                            : b,
                                                                ),
                                                        })
                                                    }
                                                />
                                            </div>
                                        )}
                                    </div>
                                    );
                                })}
                                {action.buttons.length < 3 && (
                                    <button
                                        type="button"
                                        disabled={disabled}
                                        onClick={() =>
                                            update(index, {
                                                buttons: [
                                                    ...action.buttons,
                                                    {
                                                        type: "web_url",
                                                        title: "",
                                                        url: "",
                                                        track: true,
                                                    },
                                                ],
                                            })
                                        }
                                        className="flex items-center gap-1 text-[12px] font-semibold text-ios-blue hover:underline"
                                    >
                                        <Plus size={12} /> Adicionar botão
                                    </button>
                                )}
                            </div>
                        )}

                        {/* Quick replies */}
                        {showQuick && (
                            <div className="space-y-2">
                                <FieldLabel>
                                    Respostas rápidas (quick replies)
                                </FieldLabel>
                                {action.quickReplies.map((qr, qi) => (
                                    <div
                                        key={qi}
                                        className="flex items-center gap-2"
                                    >
                                        <input
                                            value={qr.title}
                                            disabled={disabled}
                                            aria-label={`Título da resposta rápida ${qi + 1}`}
                                            onChange={(e) =>
                                                update(index, {
                                                    quickReplies:
                                                        action.quickReplies.map(
                                                            (q, j) =>
                                                                j === qi
                                                                    ? {
                                                                          ...q,
                                                                          title: e
                                                                              .target
                                                                              .value,
                                                                      }
                                                                    : q,
                                                        ),
                                                })
                                            }
                                            placeholder="Título"
                                            className="flex-1 min-w-0 bg-ios-background border border-ios-separator rounded-lg px-2 py-1 text-[12px] focus:border-ios-blue outline-none"
                                        />
                                        <input
                                            value={qr.payload}
                                            disabled={disabled}
                                            aria-label={`Payload da resposta rápida ${qi + 1}`}
                                            onChange={(e) =>
                                                update(index, {
                                                    quickReplies:
                                                        action.quickReplies.map(
                                                            (q, j) =>
                                                                j === qi
                                                                    ? {
                                                                          ...q,
                                                                          payload:
                                                                              e
                                                                                  .target
                                                                                  .value,
                                                                      }
                                                                    : q,
                                                        ),
                                                })
                                            }
                                            placeholder="payload"
                                            className="w-32 bg-ios-background border border-ios-separator rounded-lg px-2 py-1 text-[12px] font-mono focus:border-ios-blue outline-none"
                                        />
                                        <button
                                            type="button"
                                            onClick={() =>
                                                update(index, {
                                                    quickReplies:
                                                        action.quickReplies.filter(
                                                            (_, j) => j !== qi,
                                                        ),
                                                })
                                            }
                                            disabled={disabled}
                                            aria-label={`Remover resposta rápida ${qi + 1}`}
                                            className="p-1 rounded text-ios-red hover:bg-ios-red/10"
                                        >
                                            <X size={14} />
                                        </button>
                                    </div>
                                ))}
                                {action.quickReplies.length < 10 && (
                                    <button
                                        type="button"
                                        disabled={disabled}
                                        onClick={() =>
                                            update(index, {
                                                quickReplies: [
                                                    ...action.quickReplies,
                                                    { title: "", payload: "" },
                                                ],
                                            })
                                        }
                                        className="flex items-center gap-1 text-[12px] font-semibold text-ios-blue hover:underline"
                                    >
                                        <Plus size={12} /> Adicionar resposta
                                        rápida
                                    </button>
                                )}
                            </div>
                        )}

                        {/* Tag */}
                        {action.type === "assign_tag" && (
                            <div>
                                <FieldLabel>
                                    Tag aplicada ao contato
                                </FieldLabel>
                                <input
                                    aria-label={`${itemNoun} ${index + 1}: tag aplicada ao contato`}
                                    value={action.tag}
                                    disabled={disabled}
                                    onChange={(e) =>
                                        update(index, { tag: e.target.value })
                                    }
                                    placeholder="Ex.: lead-quente"
                                    className={inputCls}
                                />
                            </div>
                        )}

                        {/* Sequência */}
                        {action.type === "start_sequence" && (
                            <div>
                                <FieldLabel>
                                    Sequência a iniciar
                                </FieldLabel>
                                {profileChannels.length > 1 ? (
                                    <div className="space-y-2">
                                        {profileChannels.map((channel, ci) => {
                                            const options = referenceOptions(sequences, channel.id);
                                            return <label key={channel.id} className="block text-[11px] font-medium text-ios-text-secondary">{channel.username ? `@${channel.username}` : channel.name || `Perfil ${ci + 1}`}
                                                <select aria-label={`${itemNoun} ${index + 1}: sequência para ${channel.name || channel.id}`} value={action.sequenceIdsByChannel?.[channel.id] ?? (ci === 0 ? action.sequenceId : "")} disabled={disabled} onChange={(e) => setProfileReference(index, "sequence", channel.id, e.target.value)} className={inputCls}>
                                                    <option value="">Selecione uma sequência…</option>
                                                    {options.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                                                </select>
                                            </label>;
                                        })}
                                    </div>
                                ) : (
                                    <select aria-label={`${itemNoun} ${index + 1}: sequência a iniciar`} value={profileChannels[0] ? action.sequenceIdsByChannel?.[profileChannels[0].id] ?? action.sequenceId : action.sequenceId} disabled={disabled} onChange={(e) => update(index, { sequenceId: e.target.value, ...(profileChannels[0] ? { sequenceIdsByChannel: { ...action.sequenceIdsByChannel, [profileChannels[0].id]: e.target.value } } : {}) })} className={inputCls}>
                                        <option value="">Selecione uma sequência…</option>
                                        {referenceOptions(sequences, profileChannels[0]?.id ?? "").map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                                    </select>
                                )}
                                {sequences.length === 0 && (
                                    <p className="text-[11px] text-ios-orange mt-1">
                                        Nenhuma sequência cadastrada ainda.
                                    </p>
                                )}
                            </div>
                        )}

                        {/* Webhook de saída */}
                        {action.type === "outbound_webhook" && (
                            <div>
                                <FieldLabel>
                                    Webhook de saída
                                </FieldLabel>
                                {profileChannels.length > 1 ? (
                                    <div className="space-y-2">
                                        {profileChannels.map((channel, ci) => {
                                            const options = referenceOptions(webhooks, channel.id);
                                            return <label key={channel.id} className="block text-[11px] font-medium text-ios-text-secondary">{channel.username ? `@${channel.username}` : channel.name || `Perfil ${ci + 1}`}
                                                <select aria-label={`${itemNoun} ${index + 1}: webhook para ${channel.name || channel.id}`} value={action.webhookIdsByChannel?.[channel.id] ?? (ci === 0 ? action.webhookId : "")} disabled={disabled} onChange={(e) => setProfileReference(index, "webhook", channel.id, e.target.value)} className={inputCls}>
                                                    <option value="">Selecione um webhook…</option>
                                                    {options.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                                                </select>
                                            </label>;
                                        })}
                                    </div>
                                ) : (
                                    <select aria-label={`${itemNoun} ${index + 1}: webhook de saída`} value={profileChannels[0] ? action.webhookIdsByChannel?.[profileChannels[0].id] ?? action.webhookId : action.webhookId} disabled={disabled} onChange={(e) => update(index, { webhookId: e.target.value, ...(profileChannels[0] ? { webhookIdsByChannel: { ...action.webhookIdsByChannel, [profileChannels[0].id]: e.target.value } } : {}) })} className={inputCls}>
                                        <option value="">Selecione um webhook…</option>
                                        {referenceOptions(webhooks, profileChannels[0]?.id ?? "").map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                                    </select>
                                )}
                                {webhooks.length === 0 && (
                                    <p className="text-[11px] text-ios-orange mt-1">
                                        Nenhum webhook de saída cadastrado
                                        ainda.
                                    </p>
                                )}
                            </div>
                        )}
                    </div>
                );
            })}

            {/* Adicionar ação */}
            {!disabled && allowedTypes.length > 0 && (
                <div className="flex items-center gap-2">
                    <select
                        value={newType}
                        onChange={(e) =>
                            setNewType(e.target.value as IgActionType)
                        }
                        aria-label={`Tipo da nova ${itemNoun.toLowerCase()}`}
                        className="min-h-11 flex-1 min-w-0 bg-ios-background border border-ios-separator rounded-lg p-2 text-sm focus:border-ios-blue outline-none"
                    >
                        {allowedTypes.map((t) => (
                            <option key={t} value={t}>
                                {ACTION_TYPE_LABELS[t]}
                            </option>
                        ))}
                    </select>
                    <button
                        type="button"
                        onClick={add}
                        className="min-h-11 flex items-center gap-1 px-3 py-2 rounded-lg bg-ios-blue text-white text-[13px] font-semibold hover:bg-blue-600 transition-colors"
                    >
                        <Plus size={14} /> {itemNoun}
                    </button>
                </div>
            )}
        </div>
    );
}
