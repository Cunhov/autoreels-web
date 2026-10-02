"use client";
import { useCallback, useEffect, useState } from "react";
import {
    AlertTriangle,
    ListOrdered,
    Loader2,
    Plus,
    Save,
    Trash2,
} from "lucide-react";
import IOSButton from "@/components/IOSButton";
import IOSCard from "@/components/IOSComponents";
import IOSSwitch from "@/components/IOSSwitch";
import IOSToast from "@/components/IOSToast";
import ActionListEditor from "./ActionListEditor";
import type {
    ChannelLite,
    IgActionDraft,
    IgActionType,
    IgSequence,
} from "./types";
import {
    apiFetch,
    asString,
    channelLabel,
    extractItems,
    isRecord,
    newActionDraft,
    normalizeChannel,
    normalizeSequence,
    serializeActionPayload,
} from "./types";

const inputCls =
    "w-full bg-ios-background border border-ios-separator rounded-lg p-2 text-sm focus:border-ios-blue outline-none placeholder:text-gray-400";

const SEQUENCE_ACTION_TYPES: IgActionType[] = [
    "dm_text",
    "dm_buttons",
    "dm_quick_replies",
    "dm_media",
    "ai_reply",
];

interface SequenceForm {
    id: string | null;
    name: string;
    channelId: string;
    enabled: boolean;
    steps: IgActionDraft[];
}

function formFromSequence(s: IgSequence): SequenceForm {
    return {
        id: s.id,
        name: s.name,
        channelId: s.channelId,
        enabled: s.enabled,
        steps:
            s.steps.length > 0
                ? s.steps
                : [newActionDraft("dm_text", 0)],
    };
}

export default function SequenceEditor() {
    const [sequences, setSequences] = useState<IgSequence[]>([]);
    const [channels, setChannels] = useState<ChannelLite[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [form, setForm] = useState<SequenceForm | null>(null);
    const [saving, setSaving] = useState(false);
    const [deleting, setDeleting] = useState(false);

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

    const load = useCallback(async () => {
        setLoading(true);
        setError("");
        try {
            const raw = await apiFetch<unknown>("/api/ig/sequences");
            setSequences(
                extractItems(raw, ["sequences", "items"]).map(
                    normalizeSequence,
                ),
            );
        } catch (e: unknown) {
            setError(
                e instanceof Error
                    ? e.message
                    : "Falha ao carregar sequências.",
            );
        } finally {
            setLoading(false);
        }
        try {
            const rawCh = await apiFetch<unknown>("/api/channels");
            setChannels(
                extractItems(rawCh, ["channels"])
                    .map(normalizeChannel)
                    .filter((c) => c.platform.toLowerCase() === "instagram"),
            );
        } catch {
            /* seletor fica vazio */
        }
    }, []);

    useEffect(() => {
        load();
    }, [load]);

    function newSequence() {
        setForm({
            id: null,
            name: "",
            channelId: channels[0]?.id ?? "",
            enabled: true,
            steps: [newActionDraft("dm_text", 0)],
        });
    }

    async function save() {
        if (!form) return;
        if (!form.name.trim()) {
            showToast("Informe um nome para a sequência.", "error");
            return;
        }
        if (!form.channelId) {
            showToast("Selecione o canal da sequência.", "error");
            return;
        }
        if (
            form.steps.some(
                (s) =>
                    ["dm_text", "dm_buttons", "dm_quick_replies", "dm_media"].includes(
                        s.type,
                    ) && s.textVariants.filter((t) => t.trim() !== "").length === 0,
            )
        ) {
            showToast(
                "Todo passo de texto precisa de pelo menos uma variação.",
                "error",
            );
            return;
        }
        setSaving(true);
        try {
            const body = {
                name: form.name.trim(),
                channelId: form.channelId,
                enabled: form.enabled,
                steps: form.steps.map((s, i) =>
                    serializeActionPayload(s, i, "camel"),
                ),
            };
            if (form.id) {
                await apiFetch<unknown>(`/api/ig/sequences/${form.id}`, {
                    method: "PATCH",
                    body: JSON.stringify(body),
                });
                showToast("Sequência atualizada ✓");
            } else {
                const raw = await apiFetch<unknown>("/api/ig/sequences", {
                    method: "POST",
                    body: JSON.stringify(body),
                });
                const rec = isRecord(raw) ? raw : {};
                const nested = isRecord(rec.sequence) ? rec.sequence : {};
                const newId = asString(rec.id) || asString(nested.id);
                showToast("Sequência criada ✓");
                if (newId) {
                    setForm({ ...form, id: newId });
                }
            }
            await load();
        } catch (e: unknown) {
            showToast(
                e instanceof Error ? e.message : "Falha ao salvar sequência.",
                "error",
            );
        } finally {
            setSaving(false);
        }
    }

    async function remove() {
        if (!form?.id) return;
        if (!window.confirm(`Excluir a sequência "${form.name}"?`)) return;
        setDeleting(true);
        try {
            await apiFetch<unknown>(`/api/ig/sequences/${form.id}`, {
                method: "DELETE",
            });
            showToast("Sequência excluída");
            setForm(null);
            await load();
        } catch (e: unknown) {
            showToast(
                e instanceof Error ? e.message : "Falha ao excluir.",
                "error",
            );
        } finally {
            setDeleting(false);
        }
    }

    return (
        <div className="space-y-4">
            <IOSToast
                message={toast?.msg ?? ""}
                type={toast?.type}
                isVisible={toast !== null}
                onClose={closeToast}
            />

            <div className="flex items-center justify-between gap-3">
                <p className="text-[13px] text-ios-text-secondary">
                    {sequences.length} sequência(s) — mensagens de acompanhamento
                    enviadas na ordem e nos intervalos definidos.
                </p>
                <IOSButton
                    variant="primary"
                    className="!py-2 !px-3 flex items-center gap-1 shrink-0"
                    onClick={newSequence}
                >
                    <Plus size={15} /> Nova sequência
                </IOSButton>
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
                        onClick={load}
                    >
                        Tentar de novo
                    </IOSButton>
                </IOSCard>
            ) : (
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-start">
                    {/* Lista */}
                    <div className="space-y-2">
                        {sequences.length === 0 && !form && (
                            <IOSCard className="p-8 text-center text-ios-text-secondary">
                                <ListOrdered
                                    size={36}
                                    className="mx-auto mb-3 opacity-30"
                                    strokeWidth={1}
                                />
                                <p className="text-[13px]">
                                    Nenhuma sequência ainda.
                                </p>
                                <p className="text-[12px] mt-2">
                                    Crie uma sequência, escolha o perfil e escreva as mensagens.
                                    Depois, selecione “Iniciar sequência” em uma automação para usá-la.
                                </p>
                            </IOSCard>
                        )}
                        {sequences.map((s) => {
                            const active = form?.id === s.id;
                            return (
                                <button
                                    key={s.id}
                                    type="button"
                                    onClick={() =>
                                        setForm(formFromSequence(s))
                                    }
                                    className={`w-full text-left p-3 rounded-xl border transition-colors ${
                                        active
                                            ? "border-ios-blue bg-ios-blue/5"
                                            : "border-ios-separator bg-ios-card hover:bg-ios-gray-6"
                                    }`}
                                >
                                    <div className="flex items-center gap-2">
                                        <span className="flex-1 min-w-0 text-[14px] font-semibold text-ios-text truncate">
                                            {s.name}
                                        </span>
                                        <span
                                            className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full uppercase ${
                                                s.enabled
                                                    ? "bg-ios-green/15 text-ios-green"
                                                    : "bg-ios-gray-5 text-ios-text-secondary"
                                            }`}
                                        >
                                            {s.enabled ? "ativa" : "pausada"}
                                        </span>
                                    </div>
                                    <p className="text-[11px] text-ios-text-secondary mt-0.5">
                                        {s.steps.length} passo(s)
                                        {s.channelId
                                            ? ` · canal ${s.channelId.slice(0, 8)}…`
                                            : ""}
                                    </p>
                                </button>
                            );
                        })}
                    </div>

                    {/* Editor */}
                    <div className="lg:col-span-2">
                        {form ? (
                            <IOSCard className="p-5 space-y-4">
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                    <div>
                                        <label htmlFor="sequence-name" className="text-xs font-medium text-ios-text mb-1 block">
                                            Nome *
                                        </label>
                                        <input
                                            id="sequence-name"
                                            value={form.name}
                                            onChange={(e) =>
                                                setForm({
                                                    ...form,
                                                    name: e.target.value,
                                                })
                                            }
                                            placeholder="Ex.: Follow-up 3 dias"
                                            className={inputCls}
                                        />
                                    </div>
                                    <div>
                                        <label htmlFor="sequence-channel" className="text-xs font-medium text-ios-text mb-1 block">
                                            Canal *
                                        </label>
                                        <select
                                            id="sequence-channel"
                                            value={form.channelId}
                                            onChange={(e) =>
                                                setForm({
                                                    ...form,
                                                    channelId: e.target.value,
                                                })
                                            }
                                            className={inputCls}
                                        >
                                            <option value="">
                                                Selecione um canal…
                                            </option>
                                            {channels.map((c) => (
                                                <option
                                                    key={c.id}
                                                    value={c.id}
                                                >
                                                    {channelLabel(c)}
                                                </option>
                                            ))}
                                        </select>
                                    </div>
                                </div>
                                <div className="flex items-center justify-between">
                                    <span className="text-sm font-medium text-ios-text">
                                        Sequência ativa
                                    </span>
                                    <IOSSwitch
                                        checked={form.enabled}
                                        onChange={(enabled) =>
                                            setForm({ ...form, enabled })
                                        }
                                        ariaLabel="Sequência ativa"
                                    />
                                </div>

                                <div>
                                    <h3 className="text-[15px] font-bold text-ios-text mb-2">
                                        Passos
                                    </h3>
                                    <ActionListEditor
                                        itemNoun="Passo"
                                        actions={form.steps}
                                        onChange={(steps) =>
                                            setForm({ ...form, steps })
                                        }
                                        allowedTypes={SEQUENCE_ACTION_TYPES}
                                        profileChannels={channels.filter((channel) => channel.id === form.channelId)}
                                    />
                                </div>

                                <div className="flex items-center justify-between gap-2 pt-1">
                                    {form.id ? (
                                        <button
                                            type="button"
                                            onClick={remove}
                                            disabled={deleting}
                                            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-[13px] font-semibold text-ios-red hover:bg-ios-red/10 disabled:opacity-40"
                                        >
                                            {deleting ? (
                                                <Loader2
                                                    size={14}
                                                    className="animate-spin"
                                                />
                                            ) : (
                                                <Trash2 size={14} />
                                            )}
                                            Excluir
                                        </button>
                                    ) : (
                                        <span />
                                    )}
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
                                            <Save size={15} />
                                        )}
                                        {form.id ? "Salvar" : "Criar"}
                                    </IOSButton>
                                </div>
                            </IOSCard>
                        ) : (
                            <IOSCard className="p-10 text-center text-ios-text-secondary">
                                <ListOrdered
                                    size={36}
                                    className="mx-auto mb-3 opacity-20"
                                    strokeWidth={1}
                                />
                                <p className="text-[14px]">
                                    Selecione uma sequência para editar ou
                                    crie uma nova.
                                </p>
                            </IOSCard>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
