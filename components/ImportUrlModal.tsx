'use client';
import { useState, useEffect } from 'react';
import { X, Globe, Folder, ChevronRight, Check } from 'lucide-react';
import IOSButton from './IOSButton';

interface FolderItem {
    id: string;
    name: string;
    parent_id?: string | null;
}

interface ImportUrlModalProps {
    currentFolderId: string | null;
    onClose: () => void;
    onImported: (name: string) => void;
}

/** Import a media file from a public URL into the content library. */
export default function ImportUrlModal({ currentFolderId, onClose, onImported }: ImportUrlModalProps) {
    const [url, setUrl] = useState('');
    const [name, setName] = useState('');
    const [folders, setFolders] = useState<FolderItem[]>([]);
    const [loadingFolders, setLoadingFolders] = useState(false);
    const [currentPath, setCurrentPath] = useState<FolderItem[]>([]);
    const [selectedFolderId, setSelectedFolderId] = useState<string | null>(currentFolderId);
    const [importing, setImporting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Fetch folders for the current directory level (same pattern as MoveContentModal)
    async function fetchFolders(parentId: string | null) {
        setLoadingFolders(true);
        try {
            const params = new URLSearchParams({ type: 'carousel_folder', limit: '500' });
            // Root level: omit parent_id entirely (API treats missing as NULL)
            if (parentId) params.set('parent_id', parentId);
            const res = await fetch(`/api/content-items?${params.toString()}`);
            if (!res.ok) throw new Error('Failed to fetch folders');
            const json = await res.json();
            setFolders((json.items || json || []) as FolderItem[]);
        } catch {
            setFolders([]);
        } finally {
            setLoadingFolders(false);
        }
    }

    useEffect(() => {
        setSelectedFolderId(currentFolderId);
        fetchFolders(null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const handleFolderClick = (folder: FolderItem) => {
        setCurrentPath([...currentPath, folder]);
        setSelectedFolderId(folder.id);
        fetchFolders(folder.id);
    };

    const handleRootClick = () => {
        setCurrentPath([]);
        fetchFolders(null);
        setSelectedFolderId(null);
    };

    const handleImport = async () => {
        if (!url.trim()) {
            setError('Informe a URL do arquivo.');
            return;
        }
        setImporting(true);
        setError(null);
        try {
            const res = await fetch('/api/import-url', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url: url.trim(),
                    name: name.trim() || undefined,
                    parent_id: selectedFolderId,
                }),
            });
            const json = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(json.error || 'Falha ao importar o arquivo.');
            onImported(json.name || 'Item importado');
            onClose();
        } catch (e: unknown) {
            const message = (e as { message?: string })?.message || 'Falha ao importar o arquivo.';
            setError(message);
        } finally {
            setImporting(false);
        }
    };

    const targetFolderName = currentPath.length > 0 ? currentPath[currentPath.length - 1].name : 'Biblioteca (raiz)';

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-in fade-in duration-200" role="presentation" onClick={onClose}>
            <div role="dialog" aria-modal="true" aria-labelledby="import-url-title" tabIndex={-1} onClick={(e)=>e.stopPropagation()} className="bg-white dark:bg-zinc-900 w-full max-w-md rounded-2xl shadow-2xl flex flex-col max-h-[85dvh] overflow-hidden">
                {/* Header */}
                <div className="p-4 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between">
                    <h3 id="import-url-title" className="font-semibold text-lg flex items-center gap-2">
                        <Globe size={18} className="text-blue-500" />
                        Importar de URL
                    </h3>
                    <button onClick={onClose} className="p-1 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors">
                        <X size={20} className="text-gray-500" />
                    </button>
                </div>

                {/* Body */}
                <div className="flex-1 overflow-y-auto p-4 space-y-4">
                    {/* URL input */}
                    <div>
                        <label className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1.5 block">
                            URL da mídia (vídeo ou imagem)
                        </label>
                        <input
                            type="url"
                            value={url}
                            onChange={(e) => setUrl(e.target.value)}
                            placeholder="https://exemplo.com/video.mp4"
                            autoFocus
                            className="w-full bg-gray-50 dark:bg-zinc-950/50 border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                        />
                        <p className="text-[11px] text-gray-400 mt-1.5">
                            Limite de 300 MB. O arquivo será baixado para a sua biblioteca.
                        </p>
                    </div>

                    {/* Optional name */}
                    <div>
                        <label className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1.5 block">
                            Nome (opcional)
                        </label>
                        <input
                            type="text"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="Nome do item na biblioteca"
                            className="w-full bg-gray-50 dark:bg-zinc-950/50 border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                        />
                    </div>

                    {/* Folder picker */}
                    <div>
                        <label className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1.5 block">
                            Pasta de destino
                        </label>
                        <div className="bg-gray-50 dark:bg-zinc-950/50 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
                            {/* Breadcrumbs */}
                            <div className="px-3 py-2 border-b border-gray-100 dark:border-gray-800 flex items-center overflow-x-auto whitespace-nowrap scrollbar-hide text-sm">
                                <button
                                    onClick={handleRootClick}
                                    className={`flex items-center hover:text-blue-500 transition-colors ${currentPath.length === 0 ? 'font-semibold text-blue-600' : 'text-gray-600'}`}
                                >
                                    Biblioteca
                                </button>
                                {currentPath.map((folder, index) => (
                                    <div key={folder.id} className="flex items-center">
                                        <ChevronRight size={14} className="text-gray-400 mx-1" />
                                        <button
                                            onClick={() => {
                                                const newPath = currentPath.slice(0, index + 1);
                                                setCurrentPath(newPath);
                                                fetchFolders(folder.id);
                                                setSelectedFolderId(folder.id);
                                            }}
                                            className={`hover:text-blue-500 transition-colors ${index === currentPath.length - 1 ? 'font-semibold text-blue-600' : 'text-gray-600'}`}
                                        >
                                            {folder.name}
                                        </button>
                                    </div>
                                ))}
                            </div>

                            {/* Folder list */}
                            <div className="max-h-44 overflow-y-auto p-2 space-y-1">
                                {loadingFolders ? (
                                    <div className="flex justify-center py-6">
                                        <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-500"></div>
                                    </div>
                                ) : (
                                    <>
                                        {/* Current level as target */}
                                        <div className={`flex items-center gap-2.5 p-2.5 rounded-lg border border-dashed text-gray-500 ${selectedFolderId === (currentPath.length > 0 ? currentPath[currentPath.length - 1].id : null) ? 'border-blue-300 bg-blue-50 dark:bg-blue-900/10 text-blue-600' : 'border-gray-200 dark:border-gray-700'}`}>
                                            <Folder size={16} />
                                            <span className="flex-1 text-sm truncate">Salvar em: {targetFolderName}</span>
                                            {(selectedFolderId === (currentPath.length > 0 ? currentPath[currentPath.length - 1].id : null)) && <Check size={15} className="text-blue-500" />}
                                        </div>
                                        {folders.length === 0 && (
                                            <p className="text-center text-gray-400 py-3 text-xs">Nenhuma subpasta aqui</p>
                                        )}
                                        {folders.map(folder => (
                                            <button
                                                key={folder.id}
                                                onClick={() => handleFolderClick(folder)}
                                                className="w-full flex items-center gap-2.5 p-2.5 hover:bg-gray-100 dark:hover:bg-gray-800/60 rounded-lg transition-colors text-left group"
                                            >
                                                <Folder size={16} className="text-blue-500 shrink-0" />
                                                <span className="flex-1 text-sm truncate text-gray-800 dark:text-gray-100">{folder.name}</span>
                                                <ChevronRight size={14} className="text-gray-400 group-hover:text-gray-600" />
                                            </button>
                                        ))}
                                    </>
                                )}
                            </div>
                        </div>
                    </div>

                    {/* Inline error */}
                    {error && (
                        <div className="bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800/40 rounded-lg px-3 py-2 text-xs text-red-600 dark:text-red-400">
                            {error}
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="p-4 border-t border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-zinc-950/50 flex justify-end gap-3">
                    <IOSButton variant="secondary" onClick={onClose} disabled={importing} className="!py-2 !px-4 text-sm">
                        Cancelar
                    </IOSButton>
                    <IOSButton variant="primary" onClick={handleImport} disabled={importing} className="!py-2 !px-4 text-sm">
                        {importing
                            ? <span className="flex items-center gap-2"><span className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></span> Importando…</span>
                            : 'Importar'}
                    </IOSButton>
                </div>
            </div>
        </div>
    );
}
