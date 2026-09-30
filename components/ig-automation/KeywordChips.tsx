"use client";
import { useState } from "react";
import { Plus, X } from "lucide-react";

interface KeywordChipsProps {
    values: string[];
    onChange: (next: string[]) => void;
    placeholder?: string;
    ariaLabel: string;
    disabled?: boolean;
    /** Máximo de chips (0 = sem limite). */
    max?: number;
}

/**
 * Editor de listas curtas em chips (keywords, negativas, media ids...).
 * Enter ou vírgula adiciona; Backspace com input vazio remove o último.
 */
export default function KeywordChips({
    values,
    onChange,
    placeholder = "Digite e pressione Enter",
    ariaLabel,
    disabled = false,
    max = 0,
}: KeywordChipsProps) {
    const [draft, setDraft] = useState("");

    const add = () => {
        const v = draft.trim();
        if (!v) return;
        if (max > 0 && values.length >= max) return;
        if (!values.some((k) => k.toLowerCase() === v.toLowerCase())) {
            onChange([...values, v]);
        }
        setDraft("");
    };

    const remove = (index: number) => {
        onChange(values.filter((_, i) => i !== index));
    };

    return (
        <div className="space-y-2">
            {values.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                    {values.map((k, i) => (
                        <span
                            key={`${k}-${i}`}
                            className="inline-flex items-center gap-1 max-w-full bg-ios-blue/10 text-ios-blue rounded-full pl-2.5 pr-1 py-0.5 text-[12px] font-medium"
                        >
                            <span className="truncate">{k}</span>
                            <button
                                type="button"
                                onClick={() => remove(i)}
                                disabled={disabled}
                                aria-label={`Remover ${k}`}
                                className="p-0.5 rounded-full hover:bg-ios-blue/20 transition-colors disabled:opacity-40"
                            >
                                <X size={12} />
                            </button>
                        </span>
                    ))}
                </div>
            )}
            {!disabled && (max === 0 || values.length < max) && (
                <div className="flex items-center gap-2">
                    <input
                        value={draft}
                        onChange={(e) => {
                            const val = e.target.value;
                            if (val.includes(",")) {
                                const parts = val
                                    .split(",")
                                    .map((p) => p.trim())
                                    .filter(Boolean);
                                let next = [...values];
                                for (const p of parts) {
                                    if (
                                        (max === 0 || next.length < max) &&
                                        !next.some(
                                            (k) =>
                                                k.toLowerCase() ===
                                                p.toLowerCase(),
                                        )
                                    ) {
                                        next = [...next, p];
                                    }
                                }
                                onChange(next);
                                setDraft("");
                            } else {
                                setDraft(val);
                            }
                        }}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") {
                                e.preventDefault();
                                add();
                            } else if (
                                e.key === "Backspace" &&
                                draft === "" &&
                                values.length > 0
                            ) {
                                remove(values.length - 1);
                            }
                        }}
                        onBlur={add}
                        placeholder={placeholder}
                        aria-label={ariaLabel}
                        className="flex-1 min-w-0 bg-ios-background border border-ios-separator rounded-lg px-2.5 py-1.5 text-sm focus:border-ios-blue outline-none placeholder:text-gray-400"
                    />
                    <button
                        type="button"
                        onClick={add}
                        aria-label="Adicionar"
                        className="p-1.5 rounded-lg bg-ios-blue/10 text-ios-blue hover:bg-ios-blue/20 transition-colors"
                    >
                        <Plus size={14} />
                    </button>
                </div>
            )}
        </div>
    );
}
