"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
    AlertTriangle,
    Download,
    FlaskConical,
    Loader2,
    Pencil,
    Plus,
    Search,
    Trash2,
    X,
} from "lucide-react";
import IOSButton from "@/components/IOSButton";
import IOSCard from "@/components/IOSComponents";
import IOSSwitch from "@/components/IOSSwitch";
import IOSToast from "@/components/IOSToast";
import { useDialogA11y } from "@/lib/dialog-a11y";
import KeywordChips from "./KeywordChips";
import type { IgSubstance } from "./types";
import { ApiError, apiFetch, extractItems, isRecord, normalizeSubstance } from "./types";

const inputCls =
    "w-full bg-ios-background border border-ios-separator rounded-lg p-2 text-sm focus:border-ios-blue outline-none placeholder:text-gray-400";

interface FormState {
    keyword: string;
    name: string;
    keywords: string[];
    description: string;
    action: string;
    dosage: string;
    duration: string;
    url: string;
    enabled: boolean;
}

const emptyForm: FormState = {
    keyword: "",
    name: "",
    keywords: [],
    description: "",
    action: "",
    dosage: "",
    duration: "",
    url: "",
    enabled: true,
};

function toForm(s: IgSubstance): FormState {
    return {
        keyword: s.keyword,
        name: s.name,
        keywords: s.keywords,
        description: s.description,
        action: s.action,
        dosage: s.dosage,
        duration: s.duration,
        url: s.url,
        enabled: s.enabled,
    };
}

export default function SubstanceManager() {
    const [items, setItems] = useState<IgSubstance[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [search, setSearch] = useState("");
    const [modalOpen, setModalOpen] = useState(false);
    const dialogRef = useDialogA11y(modalOpen, () => setModalOpen(false));
    const [editingId, setEditingId] = useState<string | null>(null);
    const [form, setForm] = useState<FormState>(emptyForm);
    const [saving, setSaving] = useState(false);
    const [deletingId, setDeletingId] = useState<string | null>(null);
    const [importOpen, setImportOpen] = useState(false);
    const [importText, setImportText] = useState("");
    const [importing, setImporting] = useState(false);
    const [togglingId, setTogglingId] = useState<string | null>(null);

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
            const raw = await apiFetch<unknown>("/api/ig/substances");
            const list = extractItems(raw, ["substances", "items"]).map(
                normalizeSubstance,
            );
            setItems(list);
        } catch (e: unknown) {
            setError(
                e instanceof Error
                    ? e.message
                    : "Falha ao carregar o catálogo.",
            );
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        load();
    }, [load]);

    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        if (!q) return items;
        return items.filter(
            (s) =>
                s.keyword.toLowerCase().includes(q) ||
                s.name.toLowerCase().includes(q) ||
                s.keywords.some((k) => k.toLowerCase().includes(q)),
        );
    }, [items, search]);

    function openCreate() {
        setEditingId(null);
        setForm(emptyForm);
        setModalOpen(true);
    }

    function openEdit(s: IgSubstance) {
        setEditingId(s.id);
        setForm(toForm(s));
        setModalOpen(true);
    }

    async function saveSubstance() {
        if (!form.keyword.trim() || !form.name.trim()) {
            showToast("Informe a palavra-chave e o nome.", "error");
            return;
        }
        setSaving(true);
        try {
            const body = {
                keyword: form.keyword.trim().toLowerCase(),
                name: form.name.trim(),
                keywords: form.keywords,
                description: form.description,
                action: form.action,
                dosage: form.dosage,
                duration: form.duration,
                url: form.url.trim(),
                enabled: form.enabled,
            };
            if (editingId) {
                await apiFetch<unknown>(`/api/ig/substances/${editingId}`, {
                    method: "PATCH",
                    body: JSON.stringify(body),
                });
                showToast("Substância atualizada ✓");
            } else {
                await apiFetch<unknown>("/api/ig/substances", {
                    method: "POST",
                    body: JSON.stringify(body),
                });
                showToast("Substância criada ✓");
            }
            setModalOpen(false);
            load();
        } catch (e: unknown) {
            showToast(
                e instanceof Error ? e.message : "Falha ao salvar substância.",
                "error",
            );
        } finally {
            setSaving(false);
        }
    }

    async function toggleEnabled(s: IgSubstance) {
        setTogglingId(s.id);
        try {
            await apiFetch<unknown>(`/api/ig/substances/${s.id}`, {
                method: "PATCH",
                body: JSON.stringify({ enabled: !s.enabled }),
            });
            setItems((prev) =>
                prev.map((x) =>
                    x.id === s.id ? { ...x, enabled: !s.enabled } : x,
                ),
            );
        } catch (e: unknown) {
            showToast(
                e instanceof Error
                    ? e.message
                    : "Falha ao atualizar substância.",
                "error",
            );
        } finally {
            setTogglingId(null);
        }
    }

    async function remove(s: IgSubstance) {
        if (!window.confirm(`Excluir a substância "${s.name}"?`)) return;
        setDeletingId(s.id);
        try {
            await apiFetch<unknown>(`/api/ig/substances/${s.id}`, {
                method: "DELETE",
            });
            setItems((prev) => prev.filter((x) => x.id !== s.id));
            showToast("Substância excluída");
        } catch (e: unknown) {
            showToast(
                e instanceof Error ? e.message : "Falha ao excluir.",
                "error",
            );
        } finally {
            setDeletingId(null);
        }
    }

    async function runImport() {
        let parsed: unknown;
        try {
            parsed = JSON.parse(importText) as unknown;
        } catch {
            showToast("JSON inválido — verifique o texto colado.", "error");
            return;
        }
        const arr = Array.isArray(parsed)
            ? parsed
            : isRecord(parsed) && Array.isArray(parsed.substances)
              ? parsed.substances
              : null;
        if (!arr || arr.length === 0) {
            showToast(
                'Envie um array JSON ou {"substances":[...]}.',
                "error",
            );
            return;
        }
        setImporting(true);
        try {
            const raw = await apiFetch<unknown>("/api/ig/substances/import", {
                method: "POST",
                body: JSON.stringify({ substances: arr }),
            });
            const rec = isRecord(raw) ? raw : {};
            const imported = Number(rec.imported) || 0;
            const updated = Number(rec.updated) || 0;
            const count = imported + updated || arr.length;
            showToast(`${count} substância(s) importada(s) ✓`);
            setImportOpen(false);
            setImportText("");
            load();
        } catch (e: unknown) {
            if (e instanceof ApiError && e.status === 404) {
                showToast(
                    "Não foi possível importar o catálogo. Tente novamente.",
                    "error",
                );
            } else {
                showToast(
                    e instanceof Error
                        ? e.message
                        : "Falha ao importar substâncias.",
                    "error",
                );
            }
        } finally {
            setImporting(false);
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

            {/* Barra de ações */}
            <div className="flex flex-col sm:flex-row gap-3">
                <div className="relative flex-1">
                    <Search
                        className="absolute left-3 top-1/2 -translate-y-1/2 text-ios-text-secondary"
                        size={16}
                    />
                    <input
                        type="text"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Buscar por palavra-chave ou nome…"
                        aria-label="Buscar substâncias"
                        className="w-full bg-ios-card border border-ios-separator rounded-xl py-2.5 pl-9 pr-4 text-[15px] focus:outline-none focus:ring-1 focus:ring-ios-blue"
                    />
                </div>
                <div className="flex gap-2">
                    <IOSButton
                        variant="secondary"
                        className="!py-2 !px-3 flex items-center gap-1"
                        onClick={() => setImportOpen((v) => !v)}
                    >
                        <Download size={15} /> Importar JSON
                    </IOSButton>
                    <IOSButton
                        variant="primary"
                        className="!py-2 !px-3 flex items-center gap-1"
                        onClick={openCreate}
                    >
                        <Plus size={15} /> Nova
                    </IOSButton>
                </div>
            </div>

            {/* Importar JSON do n8n */}
            {importOpen && (
                <IOSCard className="p-4 space-y-3">
                    <div className="flex items-center justify-between">
                        <h3 className="text-[15px] font-bold text-ios-text">
                            Importar catálogo
                        </h3>
                        <button
                            type="button"
                            onClick={() => setImportOpen(false)}
                            aria-label="Fechar importação"
                            className="p-1.5 rounded-lg text-ios-text-secondary hover:bg-ios-gray-5"
                        >
                            <X size={16} />
                        </button>
                    </div>
                    <p className="text-[11px] text-ios-text-secondary">
                        Cole o arquivo de catálogo em formato JSON (lista direta ou{" "}
                        <code>{'{"substances":[...]}'}</code>). Itens com a mesma
                        palavra-chave são atualizados. Os demais itens são mantidos.
                    </p>
                    <textarea
                        rows={6}
                        value={importText}
                        onChange={(e) => setImportText(e.target.value)}
                        placeholder='[{"keyword":"creatina","name":"Creatina", ...}]'
                        className={`${inputCls} font-mono`}
                    />
                    <IOSButton
                        variant="primary"
                        className="!py-2 !px-4 flex items-center gap-1"
                        onClick={runImport}
                        disabled={importing}
                    >
                        {importing ? (
                            <Loader2 size={15} className="animate-spin" />
                        ) : (
                            <Download size={15} />
                        )}
                        {importing ? "Importando…" : "Importar"}
                    </IOSButton>
                </IOSCard>
            )}

            {/* Conteúdo */}
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
            ) : filtered.length === 0 ? (
                <IOSCard className="p-12 text-center text-ios-text-secondary">
                    <FlaskConical
                        size={44}
                        className="mx-auto mb-3 opacity-30"
                        strokeWidth={1}
                    />
                    <h3 className="text-lg font-semibold mb-1 text-ios-text">
                        {items.length === 0
                            ? "Catálogo vazio"
                            : "Nenhum resultado"}
                    </h3>
                    <p className="text-[13px] max-w-sm mx-auto">
                        {items.length === 0
                            ? "Cadastre um item com nome, descrição e link. No editor de automações, escolha uma resposta do catálogo para preencher essas informações na mensagem."
                            : "Ajuste a busca para encontrar a substância."}
                    </p>
                </IOSCard>
            ) : (
                <IOSCard className="overflow-hidden">
                    <div className="overflow-x-auto">
                        <table className="w-full text-left text-[13px] min-w-[760px]">
                            <thead className="bg-ios-gray-6 text-ios-text-secondary text-[11px] uppercase tracking-wide">
                                <tr>
                                    <th className="px-3 py-2 font-semibold">
                                        Palavra-chave
                                    </th>
                                    <th className="px-3 py-2 font-semibold">
                                        Nome
                                    </th>
                                    <th className="px-3 py-2 font-semibold">
                                        Ação
                                    </th>
                                    <th className="px-3 py-2 font-semibold">
                                        Dosagem
                                    </th>
                                    <th className="px-3 py-2 font-semibold">
                                        Duração
                                    </th>
                                    <th className="px-3 py-2 font-semibold">
                                        Ativo
                                    </th>
                                    <th className="px-3 py-2 font-semibold text-right">
                                        Ações
                                    </th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-ios-separator">
                                {filtered.map((s) => (
                                    <tr
                                        key={s.id}
                                        className="hover:bg-ios-gray-6/60"
                                    >
                                        <td className="px-3 py-2 font-mono text-[12px] text-ios-blue">
                                            {s.keyword}
                                        </td>
                                        <td className="px-3 py-2">
                                            <p className="font-medium text-ios-text">
                                                {s.name}
                                            </p>
                                            {s.keywords.length > 0 && (
                                                <p className="text-[10px] text-ios-text-secondary truncate max-w-[180px]">
                                                    {s.keywords.join(", ")}
                                                </p>
                                            )}
                                        </td>
                                        <td className="px-3 py-2 text-ios-text-secondary max-w-[220px]">
                                            <span className="line-clamp-2">
                                                {s.action || "—"}
                                            </span>
                                        </td>
                                        <td className="px-3 py-2 text-ios-text-secondary">
                                            {s.dosage || "—"}
                                        </td>
                                        <td className="px-3 py-2 text-ios-text-secondary">
                                            {s.duration || "—"}
                                        </td>
                                        <td className="px-3 py-2">
                                            <IOSSwitch
                                                checked={s.enabled}
                                                onChange={() => toggleEnabled(s)}
                                                disabled={togglingId === s.id}
                                                ariaLabel={`Ativar ${s.name}`}
                                            />
                                        </td>
                                        <td className="px-3 py-2">
                                            <div className="flex items-center justify-end gap-1">
                                                <button
                                                    type="button"
                                                    onClick={() => openEdit(s)}
                                                    aria-label={`Editar ${s.name}`}
                                                    className="p-1.5 rounded-lg text-ios-blue hover:bg-ios-blue/10"
                                                >
                                                    <Pencil size={15} />
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => remove(s)}
                                                    disabled={deletingId === s.id}
                                                    aria-label={`Excluir ${s.name}`}
                                                    className="p-1.5 rounded-lg text-ios-red hover:bg-ios-red/10 disabled:opacity-40"
                                                >
                                                    {deletingId === s.id ? (
                                                        <Loader2
                                                            size={15}
                                                            className="animate-spin"
                                                        />
                                                    ) : (
                                                        <Trash2 size={15} />
                                                    )}
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </IOSCard>
            )}

            <p className="text-[11px] text-ios-text-secondary">
                {filtered.length} de {items.length} substância(s)
            </p>

            {/* Modal criar/editar */}
            {modalOpen && (
                <div
                    className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
                    role="presentation"
                    onClick={() => setModalOpen(false)}
                >
                    <div
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="substance-modal-title"
                        tabIndex={-1}
                        ref={dialogRef}
                        onClick={(e) => e.stopPropagation()}
                        className="bg-ios-card w-full max-w-lg max-h-[85dvh] rounded-3xl shadow-2xl flex flex-col overflow-hidden"
                    >
                        <div className="p-4 border-b border-ios-separator flex items-center justify-between">
                            <h2
                                id="substance-modal-title"
                                className="text-[17px] font-bold text-ios-text"
                            >
                                {editingId
                                    ? "Editar substância"
                                    : "Nova substância"}
                            </h2>
                            <button
                                type="button"
                                onClick={() => setModalOpen(false)}
                                aria-label="Fechar"
                                className="p-2 rounded-full text-ios-text-secondary hover:bg-ios-gray-5"
                            >
                                <X size={18} />
                            </button>
                        </div>
                        <div className="flex-1 overflow-y-auto p-4 space-y-3">
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                <div>
                                    <label htmlFor="substance-keyword" className="text-xs font-medium text-ios-text mb-1 block">
                                        Palavra-chave *
                                    </label>
                                    <input
                                        id="substance-keyword"
                                        value={form.keyword}
                                        data-autofocus
                                        onChange={(e) =>
                                            setForm({
                                                ...form,
                                                keyword: e.target.value,
                                            })
                                        }
                                        placeholder="creatina"
                                        className={`${inputCls} font-mono`}
                                    />
                                </div>
                                <div>
                                    <label htmlFor="substance-name" className="text-xs font-medium text-ios-text mb-1 block">
                                        Nome *
                                    </label>
                                    <input
                                        id="substance-name"
                                        value={form.name}
                                        onChange={(e) =>
                                            setForm({
                                                ...form,
                                                name: e.target.value,
                                            })
                                        }
                                        placeholder="Creatina"
                                        className={inputCls}
                                    />
                                </div>
                            </div>
                            <div>
                                <p className="text-xs font-medium text-ios-text mb-1">
                                    Sinônimos (keywords)
                                </p>
                                <KeywordChips
                                    values={form.keywords}
                                    onChange={(keywords) =>
                                        setForm({ ...form, keywords })
                                    }
                                    ariaLabel="Sinônimos da substância"
                                    placeholder="Ex.: creatine, monohidratada"
                                />
                            </div>
                            <div>
                                <label htmlFor="substance-description" className="text-xs font-medium text-ios-text mb-1 block">
                                    Descrição
                                </label>
                                <textarea
                                    rows={2}
                                    id="substance-description"
                                    value={form.description}
                                    onChange={(e) =>
                                        setForm({
                                            ...form,
                                            description: e.target.value,
                                        })
                                    }
                                    className={inputCls}
                                />
                            </div>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                <div>
                                    <label htmlFor="substance-action" className="text-xs font-medium text-ios-text mb-1 block">
                                        Ação
                                    </label>
                                    <input
                                        id="substance-action"
                                        value={form.action}
                                        onChange={(e) =>
                                            setForm({
                                                ...form,
                                                action: e.target.value,
                                            })
                                        }
                                        className={inputCls}
                                    />
                                </div>
                                <div>
                                    <label htmlFor="substance-dosage" className="text-xs font-medium text-ios-text mb-1 block">
                                        Dosagem
                                    </label>
                                    <input
                                        id="substance-dosage"
                                        value={form.dosage}
                                        onChange={(e) =>
                                            setForm({
                                                ...form,
                                                dosage: e.target.value,
                                            })
                                        }
                                        className={inputCls}
                                    />
                                </div>
                            </div>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                <div>
                                    <label htmlFor="substance-duration" className="text-xs font-medium text-ios-text mb-1 block">
                                        Duração
                                    </label>
                                    <input
                                        id="substance-duration"
                                        value={form.duration}
                                        onChange={(e) =>
                                            setForm({
                                                ...form,
                                                duration: e.target.value,
                                            })
                                        }
                                        className={inputCls}
                                    />
                                </div>
                                <div>
                                    <label htmlFor="substance-url" className="text-xs font-medium text-ios-text mb-1 block">
                                        URL
                                    </label>
                                    <input
                                        type="url"
                                        id="substance-url"
                                        value={form.url}
                                        onChange={(e) =>
                                            setForm({
                                                ...form,
                                                url: e.target.value,
                                            })
                                        }
                                        placeholder="https://…"
                                        className={`${inputCls} font-mono`}
                                    />
                                </div>
                            </div>
                            <div className="flex items-center justify-between p-2">
                                <span className="text-sm font-medium text-ios-text">
                                    Ativa no catálogo
                                </span>
                                <IOSSwitch
                                    checked={form.enabled}
                                    onChange={(enabled) =>
                                        setForm({ ...form, enabled })
                                    }
                                    ariaLabel="Substância ativa"
                                />
                            </div>
                        </div>
                        <div className="border-t border-ios-separator flex">
                            <button
                                type="button"
                                onClick={() => setModalOpen(false)}
                                className="flex-1 py-3.5 text-[16px] text-ios-blue font-medium border-r border-ios-separator hover:bg-ios-gray-6"
                            >
                                Cancelar
                            </button>
                            <button
                                type="button"
                                onClick={saveSubstance}
                                disabled={saving}
                                className="flex-1 py-3.5 text-[16px] text-ios-blue font-semibold hover:bg-ios-blue/5 disabled:opacity-40"
                            >
                                {saving ? "Salvando…" : "Salvar"}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
