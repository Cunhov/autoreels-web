'use client';
import { useState, useEffect } from 'react';
import { Folder, X, ChevronRight, Check } from 'lucide-react';
import IOSButton from './IOSButton';

interface ContentItem {
    id: string;
    parent_id?: string | null;
    name: string;
    type: 'carousel_folder' | 'carousel_item' | 'image' | 'video';
}

interface MoveContentModalProps {
    isOpen: boolean;
    onClose: () => void;
    itemsToMove: ContentItem[]; // Can be one or multiple
    onMoveComplete: () => void;
}

export default function MoveContentModal({ isOpen, onClose, itemsToMove, onMoveComplete }: MoveContentModalProps) {
    const [folders, setFolders] = useState<ContentItem[]>([]);
    const [loading, setLoading] = useState(false);
    const [currentPath, setCurrentPath] = useState<ContentItem[]>([]); // Breadcrumb path for navigation locally
    const [selectedDestination, setSelectedDestination] = useState<string | null>(null);
    const [moving, setMoving] = useState(false);

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
            const params = new URLSearchParams({ type: 'carousel_folder' });
            if (parentId) params.set('parent_id', parentId);
            else params.set('parent_id', 'null');

            const res = await fetch(`/api/content-items?${params.toString()}`);
            if (!res.ok) throw new Error('Failed to fetch folders');
            const data = await res.json();

            // Filter out folders that are being moved (can't move a folder into itself)
            const movingIds = itemsToMove.map(i => i.id);
            const filtered = (data || []).filter((f: ContentItem) => !movingIds.includes(f.id));

            setFolders(filtered as ContentItem[]);
        } catch (error) {
            console.error('Error fetching folders:', error);
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
        const parentId = newPath.length > 0 ? newPath[newPath.length - 1].id : null;
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
            const updates = itemsToMove.map(item => ({
                id: item.id,
                parent_id: selectedDestination
            }));

            for (const update of updates) {
                const res = await fetch(`/api/content-items/${update.id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ parent_id: selectedDestination })
                });
                if (!res.ok) throw new Error('Failed to move item');
            }

            onMoveComplete();
            onClose();
        } catch (error) {
            console.error('Move failed:', error);
            alert('Failed to move items');
        } finally {
            setMoving(false);
        }
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-in fade-in duration-200">
            <div className="bg-white dark:bg-zinc-900 w-full max-w-md rounded-2xl shadow-2xl flex flex-col max-h-[80vh] overflow-hidden">
                {/* Header */}
                <div className="p-4 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between">
                    <h3 className="font-semibold text-lg">Move {itemsToMove.length} Item{itemsToMove.length !== 1 ? 's' : ''}</h3>
                    <button onClick={onClose} className="p-1 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors">
                        <X size={20} className="text-gray-500" />
                    </button>
                </div>

                {/* Breadcrumbs */}
                <div className="px-4 py-2 bg-gray-50 dark:bg-zinc-950/50 border-b border-gray-100 dark:border-gray-800 flex items-center overflow-x-auto whitespace-nowrap scrollbar-hide text-sm">
                    <button
                        onClick={handleRootClick}
                        className={`flex items-center hover:text-blue-500 transition-colors ${currentPath.length === 0 ? 'font-semibold text-blue-600' : 'text-gray-600'}`}
                    >
                        Library
                    </button>
                    {currentPath.map((folder, index) => (
                        <div key={folder.id} className="flex items-center">
                            <ChevronRight size={14} className="text-gray-400 mx-1" />
                            <button
                                onClick={() => {
                                    // Navigate to this specific crumb
                                    const newPath = currentPath.slice(0, index + 1);
                                    setCurrentPath(newPath);
                                    fetchFolders(folder.id);
                                    setSelectedDestination(folder.id);
                                }}
                                className={`hover:text-blue-500 transition-colors ${index === currentPath.length - 1 ? 'font-semibold text-blue-600' : 'text-gray-600'}`}
                            >
                                {folder.name}
                            </button>
                        </div>
                    ))}
                </div>

                {/* Folder List */}
                <div className="flex-1 overflow-y-auto p-2 min-h-[200px]">
                    {loading ? (
                        <div className="flex justify-center py-8"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-500"></div></div>
                    ) : (
                        <div className="space-y-1">
                            {/* Option to stay/select current level */}
                            <div
                                onClick={() => {/* Current level is already selected via destination state, this is just visual confirmation */ }}
                                className={`flex items-center gap-3 p-3 rounded-xl border border-dashed border-gray-200 dark:border-gray-700 text-gray-500 mb-2
                                    ${(selectedDestination === (currentPath.length > 0 ? currentPath[currentPath.length - 1].id : null)) ? 'bg-blue-50 dark:bg-blue-900/10 border-blue-200 text-blue-600' : ''}
                                `}
                            >
                                <div className="p-2 bg-gray-100 dark:bg-gray-800 rounded-lg">
                                    <Folder size={20} />
                                </div>
                                <div className="flex-1">
                                    <p className="font-medium text-sm">Target: {currentPath.length > 0 ? currentPath[currentPath.length - 1].name : 'Root Library'}</p>
                                </div>
                                {(selectedDestination === (currentPath.length > 0 ? currentPath[currentPath.length - 1].id : null)) && <Check size={16} className="text-blue-500" />}
                            </div>

                            {folders.length === 0 && (
                                <p className="text-center text-gray-400 py-4 text-sm">No subfolders here</p>
                            )}

                            {folders.map(folder => (
                                <div
                                    key={folder.id}
                                    onClick={() => handleFolderClick(folder)}
                                    className="flex items-center gap-3 p-3 hover:bg-gray-50 dark:hover:bg-gray-800/50 rounded-xl cursor-pointer transition-colors group"
                                >
                                    <div className="p-2 bg-blue-50 dark:bg-blue-900/20 text-blue-500 rounded-lg">
                                        <Folder size={20} />
                                    </div>
                                    <div className="flex-1">
                                        <p className="font-medium text-sm text-gray-900 dark:text-gray-100">{folder.name}</p>
                                    </div>
                                    <ChevronRight size={16} className="text-gray-400 group-hover:text-gray-600" />
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="p-4 border-t border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-zinc-950/50 flex justify-end gap-3">
                    <IOSButton variant="secondary" onClick={onClose} disabled={moving} className="!py-2 !px-4 text-sm">
                        Cancel
                    </IOSButton>
                    <IOSButton variant="primary" onClick={handleMove} disabled={moving} className="!py-2 !px-4 text-sm w-24 flex justifyContent-center">
                        {moving ? <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div> : 'Move Here'}
                    </IOSButton>
                </div>
            </div>
        </div>
    );
}
