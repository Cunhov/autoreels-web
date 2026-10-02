"use client";
import { useState, useEffect } from "react";
import { Folder, X, ChevronRight, Check } from "lucide-react";
import IOSButton from "./IOSButton";
import { useDialogA11y } from "@/lib/dialog-a11y";

interface ContentItem {
    id: string;
    parent_id?: string | null;
    name: string;
    type: "carousel_folder" | "carousel_item" | "image" | "video";
}

interface MoveContentModalProps {
    isOpen: boolean;
    onClose: () => void;
    itemsToMove: ContentItem[]; // Can be one or multiple
    onMoveComplete: () => void;
}

export default function MoveContentModal({
    isOpen,
    onClose,
    itemsToMove,
    onMoveComplete,
}: MoveContentModalProps) {
    const [folders, setFolders] = useState<ContentItem[]>([]);
    const [loading, setLoading] = useState(false);
    const [currentPath, setCurrentPath] = useState<ContentItem[]>([]); // Breadcrumb path for navigation locally
    const [selectedDestination, setSelectedDestination] = useState<
        string | null
    >(null);
    const [moving, setMoving] = useState(false);
    const dialogRef = useDialogA11y(isOpen, onClose);

    // Fetch folders for the current directory level
    useEffect(() => {
        if (isOpen) {
            fetchFolders(null);
            setSelectedDestination(null);
            setCurrentPath([]);
        }
    }, [isOpen]);

    async function fetchFolders(parentId: string | null) {
        setLoading(true);
        try {
            const params = new URLSearchParams({ type: "carousel_folder" });
            // Root level: omit parent_id entirely (the API treats a missing
            // param as NULL). Sending the literal string 'null' filtered by
            // parent_id='null', which never matches — root folders were hidden.
            if (parentId) params.set("parent_id", parentId);

            const res = await fetch(`/api/content-items?${params.toString()}`);
            if (!res.ok) throw new Error("Falha ao carregar as pastas.");
            const json = await res.json();
            const data = json.items || json; // Support both paginated and legacy response

            // Filter out folders that are being moved (can't move a folder into itself)
            const movingIds = itemsToMove.map((i) => i.id);
            const filtered = (data || []).filter(
                (f: ContentItem) => !movingIds.includes(f.id),
            );

            setFolders(filtered as ContentItem[]);
        } catch (error) {
            console.error("Error fetching folders:", error);
        } finally {
            setLoading(false);
        }
    }

    const handleFolderClick = (folder: ContentItem) => {
        // Navigate into folder
        setCurrentPath([...currentPath, folder]);
        fetchFolders(folder.id);
        setSelectedDestination(folder.id);
    };

    const handleBackClick = () => {
        const newPath = [...currentPath];
        newPath.pop();
        setCurrentPath(newPath);
        const parentId =
            newPath.length > 0 ? newPath[newPath.length - 1].id : null;
        fetchFolders(parentId);
        setSelectedDestination(parentId);
    };

    const handleRootClick = () => {
        setCurrentPath([]);
        fetchFolders(null);
        setSelectedDestination(null);
    };

    const handleMove = async () => {
        setMoving(true);
        try {
            // Single bulk request instead of N sequential PATCHes.
            const res = await fetch("/api/content-items/bulk", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    action: "move",
                    ids: itemsToMove.map((item) => item.id),
                    data: { parent_id: selectedDestination },
                }),
            });
            const json = await res.json().catch(() => ({}));
            if (!res.ok) {
                throw new Error(
                    (json as { error?: string })?.error ||
                        "Falha ao mover os itens.",
                );
            }

            onMoveComplete();
            onClose();
        } catch (error) {
            console.error("Falha ao mover:", error);
            alert(
                error instanceof Error ? error.message : "Falha ao mover os itens.",
            );
        } finally {
            setMoving(false);
        }
    };

    if (!isOpen) return null;

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-in fade-in duration-200"
            role="presentation"
            onClick={onClose}
        >
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="move-content-title"
                tabIndex={-1}
                onClick={(e) => e.stopPropagation()}
                className="bg-white dark:bg-zinc-900 w-full max-w-md rounded-2xl shadow-2xl flex flex-col max-h-[85dvh] overflow-hidden"
            >
                {/* Header */}
                <div className="p-4 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between">
                    <h3
                        id="move-content-title"
                        className="font-semibold text-lg"
                    >
                        Mover {itemsToMove.length} {itemsToMove.length !== 1 ? "itens" : "item"}
                    </h3>
                    <button
                        onClick={onClose}
                        aria-label="Fechar"
                        className="min-h-11 min-w-11 p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors"
                    >
                        <X size={20} className="text-gray-500" />
                    </button>
                </div>

                {/* Breadcrumbs */}
                <div className="px-4 py-2 bg-gray-50 dark:bg-zinc-950/50 border-b border-gray-100 dark:border-gray-800 flex items-center overflow-x-auto whitespace-nowrap scrollbar-hide text-sm">
                    <button
                        type="button"
                        onClick={handleRootClick}
                        className={`min-h-11 px-2 flex items-center hover:text-blue-500 transition-colors ${currentPath.length === 0 ? "font-semibold text-blue-600" : "text-gray-600"}`}
                    >
                        Biblioteca
                    </button>
                    {currentPath.map((folder, index) => (
                        <div key={folder.id} className="flex items-center">
                            <ChevronRight
                                size={14}
                                className="text-gray-400 mx-1"
                            />
                            <button
                                type="button"
                                onClick={() => {
                                    // Navigate to this specific crumb
                                    const newPath = currentPath.slice(
                                        0,
                                        index + 1,
                                    );
                                    setCurrentPath(newPath);
                                    fetchFolders(folder.id);
                                    setSelectedDestination(folder.id);
                                }}
                                className={`min-h-11 px-2 hover:text-blue-500 transition-colors ${index === currentPath.length - 1 ? "font-semibold text-blue-600" : "text-gray-600"}`}
                            >
                                {folder.name}
                            </button>
                        </div>
                    ))}
                </div>

                {/* Folder List */}
                <div className="flex-1 overflow-y-auto p-2 min-h-[200px]">
                    {loading ? (
                        <div className="flex justify-center py-8">
                            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-500"></div>
                        </div>
                    ) : (
                        <div className="space-y-1">
                            {/* Option to stay/select current level */}
                            <div
                                onClick={() => {
                                    /* Current level is already selected via destination state, this is just visual confirmation */
                                }}
                                className={`flex items-center gap-3 p-3 rounded-xl border border-dashed border-gray-200 dark:border-gray-700 text-gray-500 mb-2
                                    ${selectedDestination === (currentPath.length > 0 ? currentPath[currentPath.length - 1].id : null) ? "bg-blue-50 dark:bg-blue-900/10 border-blue-200 text-blue-600" : ""}
                                `}
                            >
                                <div className="p-2 bg-gray-100 dark:bg-gray-800 rounded-lg">
                                    <Folder size={20} />
                                </div>
                                <div className="flex-1">
                                    <p className="font-medium text-sm">
                                        Destino:{" "}
                                        {currentPath.length > 0
                                            ? currentPath[
                                                  currentPath.length - 1
                                              ].name
                                            : "Biblioteca (raiz)"}
                                    </p>
                                </div>
                                {selectedDestination ===
                                    (currentPath.length > 0
                                        ? currentPath[currentPath.length - 1].id
                                        : null) && (
                                    <Check
                                        size={16}
                                        className="text-blue-500"
                                    />
                                )}
                            </div>

                            {folders.length === 0 && (
                                <p className="text-center text-gray-400 py-4 text-sm">
                                    Nenhuma subpasta aqui
                                </p>
                            )}

                            {folders.map((folder) => (
                                <button
                                    type="button"
                                    key={folder.id}
                                    onClick={() => handleFolderClick(folder)}
                                    aria-label={`Abrir pasta ${folder.name} como destino`}
                                    className="w-full text-left flex items-center gap-3 p-3 hover:bg-gray-50 dark:hover:bg-gray-800/50 rounded-xl transition-colors group"
                                >
                                    <div className="p-2 bg-blue-50 dark:bg-blue-900/20 text-blue-500 rounded-lg">
                                        <Folder size={20} />
                                    </div>
                                    <div className="flex-1">
                                        <p className="font-medium text-sm text-gray-900 dark:text-gray-100">
                                            {folder.name}
                                        </p>
                                    </div>
                                    <ChevronRight
                                        size={16}
                                        className="text-gray-400 group-hover:text-gray-600"
                                    />
                                </button>
                            ))}
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="p-4 border-t border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-zinc-950/50 flex justify-end gap-3">
                    <IOSButton
                        variant="secondary"
                        onClick={onClose}
                        disabled={moving}
                        className="!py-2 !px-4 text-sm"
                    >
                        Cancelar
                    </IOSButton>
                    <IOSButton
                        variant="primary"
                        onClick={handleMove}
                        disabled={moving}
                        className="!py-2 !px-4 text-sm w-24 flex justifyContent-center"
                    >
                        {moving ? (
                            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                        ) : (
                            "Mover para cá"
                        )}
                    </IOSButton>
                </div>
            </div>
        </div>
    );
}
