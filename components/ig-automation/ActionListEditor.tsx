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
    allowedTypes = ACTION_TYPES,
    disabled = false,
    itemNoun = "Ação",
}: ActionListEditorProps) {
    const [newType, setNewType] = useState<IgActionType>(allowedTypes[0] ?? "dm_text");

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

    return (
        <div className="space-y-3">
            {actions.length === 0 && (
                <div className="p-4 rounded-xl border border-dashed border-ios-separator text-center text-[13px] text-ios-text-secondary">
                    Nenhuma {itemNoun.toLowerCase()} configurada ainda.
                </div>
            )}

            {actions.map((action, index) => {
                const isText = TEXT_ACTION_TYPES.includes(action.type);
                // FIX-B4-UI: private_reply só aceita botões web_url (mesma regra
                // da validação/Graph no backend).
                const privateReply = action.type === "private_reply";
                const showButtons =
                    BUTTON_ACTION_TYPES.includes(action.type) ||
                    action.buttons.length > 0;
                const showQuick =
                    QUICK_REPLY_ACTION_TYPES.includes(action.type) ||
                    action.quickReplies.length > 0;

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
                                {ACTION_TYPE_LABELS[action.type]}
                            </span>
                            <button
                                type="button"
                                onClick={() => move(index, index - 1)}
                                disabled={disabled || index === 0}
                                aria-label={`Mover ${itemNoun.toLowerCase()} ${index + 1} para cima`}
                                className="p-1.5 rounded-lg text-ios-text-secondary hover:bg-ios-gray-5 transition-colors disabled:opacity-30"
                            >
                                <ChevronUp size={16} />
                            </button>
                            <button
                                type="button"
                                onClick={() => move(index, index + 1)}
                                disabled={disabled || index === actions.length - 1}
                                aria-label={`Mover ${itemNoun.toLowerCase()} ${index + 1} para baixo`}
                                className="p-1.5 rounded-lg text-ios-text-secondary hover:bg-ios-gray-5 transition-colors disabled:opacity-30"
                            >
                                <ChevronDown size={16} />
                            </button>
                            <button
                                type="button"
                                onClick={() => remove(index)}
                                disabled={disabled}
                                aria-label={`Remover ${itemNoun.toLowerCase()} ${index + 1}`}
                                className="p-1.5 rounded-lg text-ios-red hover:bg-ios-red/10 transition-colors disabled:opacity-30"
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
                                            {ACTION_TYPE_LABELS[t]}
                                        </option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <FieldLabel hint="Tempo de espera antes desta ação.">
                                    Delay (segundos)
                                </FieldLabel>
                                <input
                                    type="number"
                                    aria-label={`${itemNoun} ${index + 1}: atraso em segundos`}
                                    min={0}
                                    value={action.delaySeconds}
                                    disabled={disabled}
                                    onChange={(e) =>
                                        update(index, {
                                            delaySeconds: Math.max(
                                                0,
                                                Number(e.target.value) || 0,
                                            ),
                                        })
                                    }
                                    className={inputCls}
                                />
                            </div>
                        </div>

                        {/* Variações de texto */}
                        {isText && (
                            <div>
                                <FieldLabel hint="Uma variação por linha — a mais adequada é sorteada a cada envio.">
                                    Variações de texto
                                </FieldLabel>
                                <textarea
                                    rows={3}
                                    aria-label={`${itemNoun} ${index + 1}: variações de texto`}
                                    value={action.textVariants.join("\n")}
                                    disabled={disabled}
                                    onChange={(e) =>
                                        update(index, {
                                            textVariants:
                                                e.target.value.split("\n"),
                                        })
                                    }
                                    placeholder={
                                        action.type === "public_comment_reply"
                                            ? "Ex.: Oi {username}! Enviei os detalhes na sua DM 💬"
                                            : "Ex.: Oi {username}! Aqui está o que você pediu…"
                                    }
                                    className={`${inputCls} font-mono`}
                                />
                                <p className="text-[10px] text-ios-text-secondary mt-1">
                                    Placeholders: {"{username}"},{" "}
                                    {"{first_name}"}, {"{substancia.nome}"},{" "}
                                    {"{substancia.descricao}"},{" "}
                                    {"{substancia.acao}"},{" "}
                                    {"{substancia.dosagem}"},{" "}
                                    {"{substancia.duracao}"},{" "}
                                    {"{substancia.url}"}
                                </p>
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
                                <select
                                    aria-label={`${itemNoun} ${index + 1}: sequência a iniciar`}
                                    value={action.sequenceId}
                                    disabled={disabled}
                                    onChange={(e) =>
                                        update(index, {
                                            sequenceId: e.target.value,
                                        })
                                    }
                                    className={inputCls}
                                >
                                    <option value="">
                                        Selecione uma sequência…
                                    </option>
                                    {sequences.map((s) => (
                                        <option key={s.id} value={s.id}>
                                            {s.name}
                                        </option>
                                    ))}
                                </select>
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
                                <select
                                    aria-label={`${itemNoun} ${index + 1}: webhook de saída`}
                                    value={action.webhookId}
                                    disabled={disabled}
                                    onChange={(e) =>
                                        update(index, {
                                            webhookId: e.target.value,
                                        })
                                    }
                                    className={inputCls}
                                >
                                    <option value="">
                                        Selecione um webhook…
                                    </option>
                                    {webhooks.map((w) => (
                                        <option key={w.id} value={w.id}>
                                            {w.name}
                                        </option>
                                    ))}
                                </select>
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
                        className="flex-1 min-w-0 bg-ios-background border border-ios-separator rounded-lg p-2 text-sm focus:border-ios-blue outline-none"
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
                        className="flex items-center gap-1 px-3 py-2 rounded-lg bg-ios-blue text-white text-[13px] font-semibold hover:bg-blue-600 transition-colors"
                    >
                        <Plus size={14} /> {itemNoun}
                    </button>
                </div>
            )}
        </div>
    );
}
