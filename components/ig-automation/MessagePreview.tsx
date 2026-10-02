"use client";
import type { IgActionDraft, IgSimulationResult } from "./types";
import { ACTION_TYPE_LABELS } from "./types";

interface Props {
    result: IgSimulationResult | null;
    actions: IgActionDraft[];
    profileLabel?: string;
}

export default function MessagePreview({ result, actions, profileLabel }: Props) {
    const tested = result !== null;
    const sampleActions = actions.filter(action => [
        "public_comment_reply", "private_reply", "dm_text", "dm_buttons", "dm_quick_replies", "dm_media",
    ].includes(action.type));
    return (
        <section aria-live="polite" className="rounded-xl border border-ios-separator bg-ios-background p-4 space-y-3">
            <div>
                <h3 className="font-semibold text-sm text-ios-text">{tested ? "Resultado do teste" : "Prévia de exemplo"}</h3>
                {tested ? (
                    <p className="text-xs text-ios-text-secondary">{result.matched ? `Regra encontrada: ${result.matched.name}` : "Nenhuma regra correspondeu"}</p>
                ) : (
                    <p className="text-xs text-ios-text-secondary">Contato de exemplo: Cliente{profileLabel ? ` · Perfil Instagram: ${profileLabel}` : ""}. Execute um teste para preencher as variáveis com os dados do evento.</p>
                )}
            </div>
            {tested ? (
                result.actions.length ? result.actions.map((action, i) => (
                    <article key={`${action.actionId}-${i}`} className="rounded-lg bg-ios-gray-5 p-3">
                        <p className="text-[11px] font-medium text-ios-text-secondary mb-1">Etapa {i + 1} · {ACTION_TYPE_LABELS[action.type]}</p>
                        {action.renderedText && <p className="text-sm text-ios-text whitespace-pre-wrap break-words">{action.renderedText}</p>}
                        {action.buttons?.map((button, j) => <span key={j} className="mt-2 mr-2 inline-block rounded-lg border border-ios-separator px-3 py-1.5 text-xs text-ios-blue">{button.title}</span>)}
                    </article>
                )) : <p className="text-sm text-ios-text-secondary">Nenhuma mensagem será enviada para este evento.</p>
            ) : (
                sampleActions.length ? sampleActions.map((action, i) => (
                    <article key={action.id ?? `${action.type}-${i}`} className="rounded-lg bg-ios-gray-5 p-3">
                        <p className="text-[11px] font-medium text-ios-text-secondary mb-1">Etapa {i + 1} · {ACTION_TYPE_LABELS[action.type]}</p>
                        {action.textVariants[0]?.trim() ? <p className="text-sm text-ios-text whitespace-pre-wrap break-words">{action.textVariants[0]}</p> : <p className="text-sm italic text-ios-text-secondary">Escreva uma mensagem para ver a prévia.</p>}
                        {action.buttons.map((button, j) => <span key={j} className="mt-2 mr-2 inline-block rounded-lg border border-ios-separator px-3 py-1.5 text-xs text-ios-blue">{button.title || "Título do botão"}</span>)}
                    </article>
                )) : <p className="text-sm text-ios-text-secondary">As ações configuradas não geram uma mensagem de texto direta.</p>
            )}
            {!tested && <p className="text-[11px] text-ios-text-secondary">Variáveis como {"{username}"} e informações do catálogo são preenchidas no teste.</p>}
        </section>
    );
}
