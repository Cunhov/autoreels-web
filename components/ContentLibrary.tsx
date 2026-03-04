'use client';
import { useState, useEffect, useCallback, useMemo } from 'react';
import { Grid as GridComponent } from 'react-window';
import { AutoSizer } from 'react-virtualized-auto-sizer';
import { getPublicUrl } from '@/lib/storage';
import { useSession } from 'next-auth/react';
import {
    Folder, Video, MoreVertical,
    Upload, Plus, ArrowLeft, Check, Trash2, Edit2, Search,
    ChevronRight, Move, Filter, X, Grid as GridIcon, List as ListIcon,
    ArrowDownAZ, ArrowUpAZ, ArrowDown01, ArrowUp01, TextCursorInput,
    ExternalLink, Eye, CornerDownRight
} from 'lucide-react';
import IOSButton from './IOSButton';
import { useDropzone } from 'react-dropzone';
import { useRouter, useSearchParams } from 'next/navigation';
import MoveContentModal from './MoveContentModal';
import { useUpload } from '@/contexts/UploadContext';
import IOSToast, { ToastType } from './IOSToast';
import { useRef } from 'react';
import EditContentModal from './EditContentModal';
import ImageEditorModal from './ImageEditorModal';
import { Palette } from 'lucide-react';

const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

const formatTime = (seconds: number) => {
    if (!isFinite(seconds) || seconds < 0) return '--';
    if (seconds < 60) return `${Math.floor(seconds)}s`;
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}m ${s}s`;
};

interface ContentItem {
    id: string;
    type: 'image' | 'video' | 'carousel_folder' | 'carousel_item';
    name: string;
    title?: string;
    caption?: string;
    url?: string;
    path?: string;
    tags?: string[];
    description?: string;
    parent_id?: string | null;
    created_at: string;
    size?: number; // bytes
    duration?: number; // seconds
    thumbnail_url?: string; // Add thumbnail URL for carousel preview
}

/** Tags are stored as JSON string in DB. Normalize to array safely. */
function normalizeTags(raw: unknown): string[] {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw as string[];
    if (typeof raw === 'string') {
        try { return JSON.parse(raw); } catch { return []; }
    }
    return [];
}

function normalizeItem(item: any): ContentItem {
    return { ...item, tags: normalizeTags(item.tags) };
}

interface ContentLibraryProps {
    mode?: 'manage' | 'select';
    onSelectionChange?: (selectedIds: string[]) => void;
    initialSelection?: string[];
    allowedTypes?: string[]; // 'video', 'image', 'carousel'
    disableUrlNavigation?: boolean;
}

const GridCell = ({ columnIndex, rowIndex, style, data }: any) => {
    const {
        columnCount,
        sortedItems,
        handleDragStart,
        handleDragEnd,
        handleDragOver,
        handleDragLeave,
        handleDrop,
        mode,
        disableUrlNavigation,
        toggleSelection,
        setInternalFolderId,
        router,
        selectedIds,
        dropTargetId,
        draggedItems,
        openEditModal,
        openImageEditor,
        deleteItem,
        openMoveModal,
        formatBytes,
        formatTime,
    } = data;

    const index = rowIndex * columnCount + columnIndex;
    if (index >= sortedItems.length) return null; // Empty slots at end of last row
    const item = sortedItems[index];

    return (
        <div style={{ ...style, padding: '0.5rem' }}>
            <div
                key={item.id}
                draggable={item.type !== 'carousel_folder'}
                onDragStart={(e) => item.type !== 'carousel_folder' && handleDragStart(e, item.id)}
                onDragEnd={handleDragEnd}
                onDragOver={(e) => handleDragOver(e, item.id, item)}
                onDragLeave={handleDragLeave}
                onDrop={(e) => item.type === 'carousel_folder' && handleDrop(e, item.id)}
                onClick={() => {
                    if (item.type === 'carousel_folder') {
                        if (mode === 'select' && disableUrlNavigation) {
                            toggleSelection(item.id);
                        } else {
                            disableUrlNavigation ? setInternalFolderId(item.id) : router.push(`/content?folderId=${item.id}`);
                        }
                    } else {
                        toggleSelection(item.id);
                    }
                }}
                className={`
                    w-full h-full group relative aspect-square rounded-2xl border overflow-hidden cursor-pointer transition-all duration-200
                    ${selectedIds.includes(item.id)
                        ? 'ring-2 ring-ios-blue border-transparent shadow-lg scale-[1.02]'
                        : 'border-ios-separator hover:border-ios-blue/50 hover:shadow-md'}
                    ${dropTargetId === item.id ? 'ring-2 ring-green-500 scale-105 bg-green-50 dark:bg-green-900/20' : ''}
                    ${draggedItems.includes(item.id) ? 'opacity-50' : ''}
                    bg-ios-card
                `}
            >
                {/* Thumbnail Content */}
                {item.type === 'carousel_folder' ? (
                    <div className="w-full h-full flex flex-col items-center justify-center bg-blue-50/50 dark:bg-blue-900/5 hover:bg-blue-50 dark:hover:bg-blue-900/10 transition-colors relative overflow-hidden">
                        {item.thumbnail_url ? (
                            <>
                                <img src={item.thumbnail_url} className="absolute inset-0 w-full h-full object-cover opacity-60 blur-[1px] group-hover:blur-0 transition-all duration-300" />
                                <div className="absolute inset-0 bg-white/30 dark:bg-black/30 group-hover:bg-transparent transition-colors" />
                                <div className="relative z-10 flex flex-col items-center">
                                    <Folder size={48} strokeWidth={1.5} className="text-white drop-shadow-lg fill-white/20" />
                                </div>
                            </>
                        ) : (
                            <Folder size={48} strokeWidth={1} className="text-blue-400 fill-blue-400/20" />
                        )}

                        <span className={`text-xs font-medium mt-3 px-3 text-center truncate w-full relative z-10 flex-shrink-0 ${item.thumbnail_url ? 'text-white drop-shadow-md' : 'text-ios-secondary'}`}>
                            {item.name}
                        </span>
                    </div>
                ) : (
                    <div className="w-full h-full relative">
                        {item.type === 'video' ? (
                            <div className="w-full h-full bg-gray-900 flex items-center justify-center relative">
                                {/* No <video> tag — avoids loading/decoding video frames (saves RAM & CPU) */}
                                <div className="w-12 h-12 rounded-full bg-white/10 border border-white/20 flex items-center justify-center">
                                    <Video className="text-white/70 fill-white/20" size={22} />
                                </div>
                            </div>
                        ) : (
                            <img src={item.url} alt={item.name} className="w-full h-full object-cover" />
                        )}

                        {/* Overlay Info (Gradient) */}
                        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent p-3 pt-8 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col justify-end">
                            <p className="text-white text-xs font-medium truncate drop-shadow-sm">{item.name}</p>
                            {/* Size / Duration Badge */}
                            <div className="flex items-center gap-2 mt-1 text-[10px] text-gray-200">
                                {item.size && <span>{formatBytes(item.size)}</span>}
                                {item.duration ? <span>• {formatTime(item.duration)}</span> : null}
                            </div>
                        </div>
                    </div>
                )}

                {/* Selection Checkbox */}
                {selectedIds.includes(item.id) && (
                    <div className="absolute top-2 right-2 bg-ios-blue text-white rounded-full p-1 shadow-sm z-20 animate-in zoom-in duration-200">
                        <Check size={12} strokeWidth={3} />
                    </div>
                )}

                {/* Bottom Left: Enter Folder Button */}
                {item.type === 'carousel_folder' && (
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            disableUrlNavigation ? setInternalFolderId(item.id) : router.push(`/content?folderId=${item.id}`);
                        }}
                        className="absolute bottom-2 left-2 p-1.5 bg-black/50 hover:bg-black/70 backdrop-blur text-white rounded-full shadow-sm transition-all z-20 opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
                        title="Open Folder"
                    >
                        <CornerDownRight size={14} />
                    </button>
                )}

                {/* Bottom Right: Preview Button */}
                <button
                    onClick={(e) => {
                        e.stopPropagation();
                        window.open(item.url, '_blank');
                    }}
                    className="absolute bottom-2 right-2 p-1.5 bg-black/50 hover:bg-black/70 backdrop-blur text-white rounded-full shadow-sm transition-all z-20 opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
                    title="Preview"
                >
                    <Eye size={14} />
                </button>

                {/* Hover Actions (Context Menu triggers) */}
                <div className="absolute top-2 right-2 flex flex-col gap-1 opacity-0 group-hover:opacity-100 transition-opacity z-10 translate-x-2 group-hover:translate-x-0 duration-200">
                    <button
                        onClick={(e) => { e.stopPropagation(); openEditModal([item]); }}
                        className="p-1.5 bg-white/90 dark:bg-black/90 backdrop-blur text-ios-text rounded-full shadow-sm hover:text-blue-500 transition-colors"
                        title="Edit Metadata"
                    >
                        <Edit2 size={12} />
                    </button>
                    {(item.type === 'image' || item.type === 'carousel_item') && (
                        <button
                            onClick={(e) => { e.stopPropagation(); openImageEditor(item); }}
                            className="p-1.5 bg-white/90 dark:bg-black/90 backdrop-blur text-ios-text rounded-full shadow-sm hover:text-purple-500 transition-colors"
                            title="Edit Image"
                        >
                            <Palette size={12} />
                        </button>
                    )}
                    {mode === 'manage' && (
                        <>
                            <button
                                onClick={(e) => { e.stopPropagation(); openMoveModal([item]); }}
                                className="p-1.5 bg-white/90 dark:bg-black/90 backdrop-blur text-ios-text rounded-full shadow-sm hover:text-blue-500 transition-colors"
                                title="Move"
                            >
                                <Move size={12} />
                            </button>
                            <button
                                onClick={(e) => deleteItem(e, item)}
                                className="p-1.5 bg-white/90 dark:bg-black/90 backdrop-blur text-ios-text rounded-full shadow-sm hover:text-red-500 transition-colors"
                                title="Delete"
                            >
                                <Trash2 size={12} />
                            </button>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
};

export default function ContentLibrary({
    mode = 'manage',
    onSelectionChange,
    initialSelection = [],
    allowedTypes = ['video', 'image', 'carousel_folder', 'carousel_item'],
    disableUrlNavigation = false
}: ContentLibraryProps) {
    const router = useRouter();
    const searchParams = useSearchParams();
    const { data: session } = useSession();

    // URL state for navigation
    const urlFolderId = searchParams.get('folderId') || null;
    const [internalFolderId, setInternalFolderId] = useState<string | null>(null);

    // Effective Folder ID based on navigation mode
    const currentFolderId = disableUrlNavigation ? internalFolderId : urlFolderId;

    const [items, setItems] = useState<ContentItem[]>([]);
    // Track the folder object for the current ID (for name display)
    const [currentFolder, setCurrentFolder] = useState<ContentItem | null>(null);
    const [folderPath, setFolderPath] = useState<ContentItem[]>([]);

    const [loading, setLoading] = useState(true);
    const [selectedIds, setSelectedIds] = useState<string[]>(initialSelection);
    const [search, setSearch] = useState('');
    const [showFilters, setShowFilters] = useState(false);
    const [filterTags, setFilterTags] = useState<string[]>([]);
    const [excludeTags, setExcludeTags] = useState<string[]>([]);
    const [filterTypes, setFilterTypes] = useState<string[]>([]);
    const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
    const [sizeFilter, setSizeFilter] = useState<'all' | 'small' | 'medium' | 'large'>('all');
    const [durationFilter, setDurationFilter] = useState<'all' | 'short' | 'medium' | 'long'>('all');

    // Pagination state
    const [totalCount, setTotalCount] = useState(0);
    const [hasMore, setHasMore] = useState(false);
    const [currentOffset, setCurrentOffset] = useState(0);
    const [loadingMore, setLoadingMore] = useState(false);
    const [selectAllServer, setSelectAllServer] = useState(false);
    const [bulkLoading, setBulkLoading] = useState(false);
    const PAGE_SIZE = 100;
    const scrollContainerRef = useRef<HTMLDivElement>(null);

    // Drag-drop items into folders
    const [draggedItems, setDraggedItems] = useState<string[]>([]);
    const [dropTargetId, setDropTargetId] = useState<string | null>(null);

    // Sorting inside folders
    const [sortBy, setSortBy] = useState<'name-asc' | 'name-desc' | 'created-asc' | 'created-desc'>('name-asc');

    // Bulk rename modal
    const [isBulkRenameOpen, setIsBulkRenameOpen] = useState(false);
    const [bulkRenamePrefix, setBulkRenamePrefix] = useState('');
    const [selectionOrder, setSelectionOrder] = useState<string[]>([]);

    // Modal states
    const [isMoveModalOpen, setIsMoveModalOpen] = useState(false);
    const [moveItems, setMoveItems] = useState<ContentItem[]>([]);

    // Edit Modal State
    const [isEditModalOpen, setIsEditModalOpen] = useState(false);
    const [itemsToEdit, setItemsToEdit] = useState<ContentItem[]>([]);
    const [editingItem, setEditingItem] = useState<ContentItem | null>(null); // Legacy, kept for logic but unused if we switch full to modal

    // Image Editor State
    const [imageEditorItem, setImageEditorItem] = useState<ContentItem | null>(null);
    const [isImageEditorOpen, setIsImageEditorOpen] = useState(false);

    // Global Upload Queue
    const { addFiles, addFolderFiles } = useUpload();

    // Toast State
    const [toast, setToast] = useState<{ msg: string; type: ToastType; show: boolean }>({ msg: '', type: 'success', show: false });

    // File Input Ref for Upload Button
    const fileInputRef = useRef<HTMLInputElement>(null);

    // -------------------------------------------------------------------------
    // Data Fetching & Navigation
    // -------------------------------------------------------------------------

    // Fetch current folder details and its ancestors for Breadcrumbs
    useEffect(() => {
        const fetchFolderDetails = async () => {
            if (!currentFolderId) {
                setCurrentFolder(null);
                setFolderPath([]);
                return;
            }

            try {
                const res = await fetch(`/api/content-items/${currentFolderId}`);
                if (!res.ok) throw new Error('Folder not found');
                const folder = await res.json();
                setCurrentFolder(folder);

                const path: ContentItem[] = [folder];
                let pid = folder.parent_id;
                while (pid) {
                    const parentRes = await fetch(`/api/content-items/${pid}`);
                    if (!parentRes.ok) break;
                    const parent = await parentRes.json();
                    if (parent) {
                        path.unshift(parent as ContentItem);
                        pid = parent.parent_id;
                    } else {
                        pid = null; // stop if not found
                    }
                    if (path.length > 10) break;
                }
                setFolderPath(path);

            } catch (err) {
                console.error('Error fetching folder info:', err);
                // Redirect to root if not found?
                router.push('/content');
            }
        };

        fetchFolderDetails();
        fetchContent(currentFolderId);
    }, [currentFolderId, router, disableUrlNavigation]); // Added disableUrlNavigation dependency to re-run if prop changes (unlikely) but correct. Removed currentFolderId from deps of fetchContent call if it was separate, but it's inside effect.


    const fetchContent = async (folderId: string | null) => {
        setLoading(true);
        setCurrentOffset(0);
        setSelectAllServer(false);
        try {
            const res = await fetch(`/api/content-items?parent_id=${folderId || ''}&limit=${PAGE_SIZE}&offset=0`);
            if (!res.ok) throw new Error('Failed to fetch items');
            const json = await res.json();
            const data = json.items || json;

            setItems((data as any[]).map(normalizeItem));
            setTotalCount(json.totalCount ?? data.length);
            setHasMore(json.hasMore ?? false);
            setCurrentOffset(PAGE_SIZE);
        } catch (error) {
            console.error('Error fetching content:', error);
        } finally {
            setLoading(false);
        }
    };

    const loadMore = useCallback(async () => {
        if (loadingMore || !hasMore) return;
        setLoadingMore(true);
        try {
            const res = await fetch(`/api/content-items?parent_id=${currentFolderId || ''}&limit=${PAGE_SIZE}&offset=${currentOffset}`);
            if (!res.ok) throw new Error('Failed to fetch more items');
            const json = await res.json();
            const data = json.items || json;

            setItems(prev => [...prev, ...(data as any[]).map(normalizeItem)]);
            setTotalCount(json.totalCount ?? (items.length + data.length));
            setHasMore(json.hasMore ?? false);
            setCurrentOffset(prev => prev + PAGE_SIZE);
        } catch (error) {
            console.error('Error loading more content:', error);
        } finally {
            setLoadingMore(false);
        }
    }, [loadingMore, hasMore, currentFolderId, currentOffset, items.length]);

    // Update parent selection callback
    useEffect(() => {
        if (mode === 'select' && onSelectionChange) {
            onSelectionChange(selectedIds);
        }
    }, [selectedIds, mode, onSelectionChange]);


    // -------------------------------------------------------------------------
    // Actions (Upload, Drop, Create Folder)
    // -------------------------------------------------------------------------

    const onDrop = useCallback(async (acceptedFiles: File[]) => {
        try {
            if (!session?.user || acceptedFiles.length === 0) return;

            // Detect if any files have webkitRelativePath (folder upload)
            const hasFolderStructure = acceptedFiles.some(f => (f as any).webkitRelativePath && (f as any).webkitRelativePath.includes('/'));

            if (hasFolderStructure) {
                await addFolderFiles(acceptedFiles);
            } else {
                addFiles(acceptedFiles, currentFolderId || undefined);
            }

            setToast({ msg: 'Uploads queued. Check the Uploads tab for details.', show: true, type: 'info' });
        } catch (error) {
            console.error(error);
        }
    }, [currentFolderId, addFiles, addFolderFiles, session]);

    const { getRootProps, getInputProps, isDragActive } = useDropzone({
        onDrop,
        noClick: true,
        noKeyboard: true
    });

    const createFolder = async () => {
        const name = prompt('Enter folder name:');
        if (!name) return;

        try {
            const res = await fetch('/api/content-items', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name,
                    type: 'carousel_folder',
                    parent_id: currentFolderId
                })
            });
            if (!res.ok) throw new Error('Failed to create folder');
            fetchContent(currentFolderId);
        } catch (error) {
            console.error(error);
        }
    };


    // -------------------------------------------------------------------------
    // Selection & CRUD Logic
    // -------------------------------------------------------------------------

    const toggleSelection = (id: string) => {
        if (selectedIds.includes(id)) {
            setSelectedIds(selectedIds.filter(sid => sid !== id));
            setSelectionOrder(selectionOrder.filter(sid => sid !== id));
        } else {
            setSelectedIds([...selectedIds, id]);
            setSelectionOrder([...selectionOrder, id]);
        }
    };

    // Drag-drop handlers for moving items into folders
    const handleDragStart = (e: React.DragEvent, itemId: string) => {
        e.stopPropagation();
        // If item is selected, drag all selected; otherwise just this one
        const itemsToDrag = selectedIds.includes(itemId) ? selectedIds : [itemId];
        setDraggedItems(itemsToDrag);
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', itemsToDrag.join(','));
    };

    const handleDragOver = (e: React.DragEvent, targetId: string | null, targetItem: ContentItem | null) => {
        e.preventDefault();
        e.stopPropagation();
        // Only allow dropping on folders
        if (targetItem && targetItem.type === 'carousel_folder' && !draggedItems.includes(targetItem.id)) {
            setDropTargetId(targetId);
            e.dataTransfer.dropEffect = 'move';
        } else if (targetId === null && currentFolderId) {
            // Allow dropping to move to root (when dragging over empty area)
            setDropTargetId('root');
            e.dataTransfer.dropEffect = 'move';
        }
    };

    const handleDragLeave = (e: React.DragEvent) => {
        e.preventDefault();
        setDropTargetId(null);
    };

    const handleDrop = async (e: React.DragEvent, targetId: string | null) => {
        e.preventDefault();
        e.stopPropagation();
        setDropTargetId(null);

        if (draggedItems.length === 0) return;

        const newParentId = targetId === 'root' ? null : targetId;

        try {
            // Move all dragged items to the target folder
            for (const itemId of draggedItems) {
                await fetch(`/api/content-items/${itemId}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ parent_id: newParentId })
                });
            }
            setToast({ msg: `Moved ${draggedItems.length} item(s)`, type: 'success', show: true });
            fetchContent(currentFolderId);
            setSelectedIds([]);
            setSelectionOrder([]);
        } catch (error) {
            console.error('Move failed:', error);
            setToast({ msg: 'Failed to move items', type: 'error', show: true });
        }
        setDraggedItems([]);
    };

    const handleDragEnd = () => {
        setDraggedItems([]);
        setDropTargetId(null);
    };

    // Bulk rename in selection order — uses server-side bulk endpoint
    const handleBulkRename = async () => {
        if (!bulkRenamePrefix.trim() || selectionOrder.length === 0) return;

        try {
            setBulkLoading(true);
            const res = await fetch('/api/content-items/bulk', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'rename',
                    ids: selectionOrder,
                    data: { prefix: bulkRenamePrefix.trim() }
                })
            });
            if (!res.ok) throw new Error('Bulk rename failed');
            const result = await res.json();
            setToast({ msg: `Renamed ${result.affected} items`, type: 'success', show: true });
            setIsBulkRenameOpen(false);
            setBulkRenamePrefix('');
            setSelectedIds([]);
            setSelectionOrder([]);
            setSelectAllServer(false);
            fetchContent(currentFolderId);
        } catch (error) {
            console.error('Rename failed:', error);
            setToast({ msg: 'Failed to rename items', type: 'error', show: true });
        } finally {
            setBulkLoading(false);
        }
    };

    const deleteItem = async (e: React.MouseEvent, item: ContentItem) => {
        e.stopPropagation();
        const message = item.type === 'carousel_folder'
            ? `Delete folder "${item.name}" and ALL its contents? This cannot be undone.`
            : 'Delete this item?';

        if (!confirm(message)) return;

        try {
            await doDelete(item);
            fetchContent(currentFolderId);
            // If we deleted selected items, cleanup
            setSelectedIds(selectedIds.filter(id => id !== item.id));
        } catch (error) {
            console.error('Delete failed:', error);
        }
    };

    // Robust delete function
    const doDelete = async (item: ContentItem) => {
        // If file, delete from storage
        if (item.path) {
            await fetch(`/api/storage?path=${encodeURIComponent(item.path)}`, { method: 'DELETE' });
        }

        // Use RPC or Client-side recursion?
        // Since we enabled CASCADE in DB, we just need to delete the row.
        // HOWEVER, we should technically delete the storage files of children too.
        // DB won't auto-delete storage files. 
        // For a perfectly clean system, we need to fetch all descendants with 'path' != null and delete them from storage.

        if (item.type === 'carousel_folder') {
            // Fetch all descendants recursively to clean up storage (Optional but recommended)
            // For this MVP step, we will rely on DB Cascade for record cleanup. 
            // Storage orphan cleanup is a maintenance task usually. 
            // Implementing full recursive storage cleanup client-side can be slow for large folders.
            // Let's stick to simple record delete for now, noting that files might remain in bucket.
        }

        const res = await fetch(`/api/content-items/${item.id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('Delete failed');
    };

    const handleRename = async () => {
        // Legacy rename function - redirecting to openEditModal
        if (editingItem) openEditModal([editingItem]);
    };

    const openEditModal = (items: ContentItem[]) => {
        setItemsToEdit(items);
        setIsEditModalOpen(true);
    };

    const onEditComplete = () => {
        fetchContent(currentFolderId);
        setSelectedIds([]);
        setItemsToEdit([]);
    };

    // Triggered when "Move" is clicked on an item or selection
    const openMoveModal = (items: ContentItem[]) => {
        setMoveItems(items);
        setIsMoveModalOpen(true);
    };

    const onMoveComplete = () => {
        fetchContent(currentFolderId);
        setSelectedIds([]);
        setSelectAllServer(false);
    };

    const openImageEditor = (item: ContentItem) => {
        setImageEditorItem(item);
        setIsImageEditorOpen(true);
    };

    const handleImageEditorSave = async (dataUrl: string) => {
        if (!imageEditorItem) return;

        try {
            setLoading(true);
            setToast({ msg: 'Saving edited image...', type: 'info', show: true });

            // Convert DataURL to Blob/File
            const res = await fetch(dataUrl);
            const blob = await res.blob();
            const file = new File([blob], `edited_${imageEditorItem.name}`, { type: 'image/png' });

            if (!session?.user) throw new Error("Not authenticated");

            const userId = (session.user as any).id;
            const fileName = `${userId}/${Math.random().toString(36).substring(2)}.png`;

            // Upload via chunked local API
            const CHUNK_SIZE = 5 * 1024 * 1024;
            const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
            for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
                const start = chunkIndex * CHUNK_SIZE;
                const end = Math.min(start + CHUNK_SIZE, file.size);
                const chunk = file.slice(start, end);

                let retries = 0;
                let success = false;
                while (!success && retries < 3) {
                    try {
                        const uploadRes = await fetch('/api/upload-chunk', {
                            method: 'POST',
                            headers: {
                                'x-chunk-index': chunkIndex.toString(),
                                'x-total-chunks': totalChunks.toString(),
                                'x-file-name': fileName
                            },
                            body: chunk
                        });
                        if (!uploadRes.ok) {
                            const err = await uploadRes.json().catch(() => ({}));
                            throw new Error((err as any).error || 'Failed to upload edited image chunk');
                        }
                        success = true;
                    } catch (err) {
                        retries++;
                        if (retries >= 3) throw err;
                        await new Promise(r => setTimeout(r, 1000 * retries));
                    }
                }
            }

            const publicUrl = getPublicUrl(fileName);

            // Insert into DB
            const dbRes = await fetch('/api/content-items', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: `Edited ${imageEditorItem.name}`,
                    type: 'image',
                    url: publicUrl,
                    path: fileName,
                    parent_id: currentFolderId,
                    size: file.size,
                    duration: 0
                })
            });

            if (!dbRes.ok) throw new Error('Failed to save image metadata in DB');

            setToast({ msg: 'Image saved successfully', type: 'success', show: true });
            fetchContent(currentFolderId);
            setIsImageEditorOpen(false);
            setImageEditorItem(null);

        } catch (error: any) {
            console.error('Save failed:', error);
            setToast({ msg: 'Failed to save image: ' + error.message, type: 'error', show: true });
        } finally {
            setLoading(false);
        }
    };

    // -------------------------------------------------------------------------
    // Renders
    // -------------------------------------------------------------------------

    // Caluclate all unique tags from current items
    const allTags = useMemo(() => {
        const tags = new Set<string>();
        items.forEach(item => item.tags?.forEach(t => tags.add(t)));
        return Array.from(tags).sort();
    }, [items]);

    const filteredItems = items.filter(item => {
        const term = search.toLowerCase();
        // 1. Text match (Name, Title, Caption, Tags)
        const matchesText = !term || (
            item.name.toLowerCase().includes(term) ||
            (item.title && item.title.toLowerCase().includes(term)) ||
            (item.caption && item.caption.toLowerCase().includes(term)) ||
            (item.tags && item.tags.some(t => t.toLowerCase().includes(term)))
        );

        // 2. Tag Inclusion Filter
        const matchesIncludedTags = filterTags.length === 0 || filterTags.every(t => item.tags?.includes(t));

        // 3. Tag Exclusion Filter
        const matchesExcludedTags = excludeTags.some(t => item.tags?.includes(t));

        // 4. Type Filter
        const matchesType = filterTypes.length === 0 || filterTypes.some(t => {
            if (t === 'carousel_folder') return item.type === 'carousel_folder';
            if (t === 'image') return item.type === 'image' || item.type === 'carousel_item'; // simplified
            if (t === 'video') return item.type === 'video';
            return false;
        });

        // 5. Size Filter
        const matchesSize = sizeFilter === 'all' || (() => {
            const size = item.size || 0;
            if (sizeFilter === 'small') return size < 5 * 1024 * 1024; // < 5MB
            if (sizeFilter === 'medium') return size >= 5 * 1024 * 1024 && size < 20 * 1024 * 1024; // 5-20MB
            if (sizeFilter === 'large') return size >= 20 * 1024 * 1024; // > 20MB
            return true;
        })();

        // 6. Duration Filter (Videos only effectively, others are 0 or null)
        const matchesDuration = durationFilter === 'all' || (() => {
            if (item.type !== 'video' && item.type !== 'carousel_item') return true; // Keep non-videos
            const duration = item.duration || 0;
            if (durationFilter === 'short') return duration < 15; // < 15s
            if (durationFilter === 'medium') return duration >= 15 && duration <= 60; // 15-60s
            if (durationFilter === 'long') return duration > 60; // > 60s
            return true;
        })();

        // 7. Allowed Types Filter (from prop)
        const matchesAllowedType = allowedTypes.some(t => {
            if (t === 'carousel_folder') return item.type === 'carousel_folder';
            if (t === 'image') return item.type === 'image' || item.type === 'carousel_item';
            if (t === 'video') return item.type === 'video';
            if (t === 'carousel_item') return item.type === 'carousel_item';
            return false;
        });

        return matchesText && matchesIncludedTags && !matchesExcludedTags && matchesType && matchesSize && matchesDuration && matchesAllowedType;
    });

    // Apply sorting
    const sortedItems = useMemo(() => {
        return [...filteredItems].sort((a, b) => {
            // Folders always come first
            if (a.type === 'carousel_folder' && b.type !== 'carousel_folder') return -1;
            if (a.type !== 'carousel_folder' && b.type === 'carousel_folder') return 1;

            switch (sortBy) {
                case 'name-asc':
                    return a.name.localeCompare(b.name, undefined, { numeric: true });
                case 'name-desc':
                    return b.name.localeCompare(a.name, undefined, { numeric: true });
                case 'created-asc':
                    return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
                case 'created-desc':
                    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
                default:
                    return 0;
            }
        });
    }, [filteredItems, sortBy]);

    const handleSelectAll = () => {
        const allFilteredIds = sortedItems.map(i => i.id);
        const allSelected = allFilteredIds.every(id => selectedIds.includes(id));

        if (allSelected || selectAllServer) {
            // Deselect everything
            setSelectedIds([]);
            setSelectionOrder([]);
            setSelectAllServer(false);
        } else {
            // Select all visible ones in order
            const newSet = new Set([...selectedIds, ...allFilteredIds]);
            setSelectedIds(Array.from(newSet));
            const newOrder = [...selectionOrder, ...allFilteredIds.filter(id => !selectionOrder.includes(id))];
            setSelectionOrder(newOrder);
        }
    };

    const handleSelectAllServer = () => {
        if (selectAllServer) {
            setSelectAllServer(false);
            setSelectedIds([]);
            setSelectionOrder([]);
        } else {
            // Select all loaded items and set server flag
            const allFilteredIds = sortedItems.map(i => i.id);
            setSelectedIds(allFilteredIds);
            setSelectionOrder(allFilteredIds);
            setSelectAllServer(true);
        }
    };

    // Build filter params for server-side bulk ops
    const buildFilterParams = useCallback(() => {
        const params: Record<string, string> = {};
        if (currentFolderId) params.parent_id = currentFolderId;
        else params.parent_id = '';
        if (filterTypes.length > 0) params.types = filterTypes.join(',');
        if (search.trim()) params.search = search.trim();
        return params;
    }, [currentFolderId, filterTypes, search]);

    // Bulk delete handler — uses server-side bulk endpoint
    const handleBulkDelete = async () => {
        const count = selectAllServer ? totalCount : selectedIds.length;
        if (!confirm(`Delete ${count} items? This cannot be undone.`)) return;
        try {
            setBulkLoading(true);
            const body: any = { action: 'delete' };
            if (selectAllServer) {
                body.all = true;
                body.filters = buildFilterParams();
            } else {
                body.ids = selectedIds;
            }
            const res = await fetch('/api/content-items/bulk', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            if (!res.ok) throw new Error('Bulk delete failed');
            const result = await res.json();
            setToast({ msg: `Deleted ${result.affected} items`, type: 'success', show: true });
            setSelectedIds([]);
            setSelectionOrder([]);
            setSelectAllServer(false);
            fetchContent(currentFolderId);
        } catch (error) {
            console.error('Bulk delete failed:', error);
            setToast({ msg: 'Failed to delete items', type: 'error', show: true });
        } finally {
            setBulkLoading(false);
        }
    };


    // Handle scroll for infinite loading
    const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
        const el = e.currentTarget;
        if (el.scrollHeight - el.scrollTop - el.clientHeight < 300 && hasMore && !loadingMore) {
            loadMore();
        }
    }, [hasMore, loadingMore, loadMore]);

    // If we are in 'select' mode (Planner), we generally want to return ID of the item.
    // However, if we select a Folder, we might mean "Use this carousel".

    return (
        <div className="flex flex-col h-full bg-ios-background relative" {...getRootProps()}>
            <input {...getInputProps()} />

            {/* Toolbar */}
            <div className="px-4 py-3 border-b border-ios-separator flex flex-col gap-3 bg-ios-background/80 backdrop-blur-md sticky top-0 z-10 transition-all">

                {/* Top Row: Path & Actions */}
                <div className="flex items-center justify-between gap-4">
                    {/* Breadcrumbs / Back */}
                    <div className="flex items-center gap-1 overflow-hidden">
                        {currentFolderId ? (
                            <div className="flex items-center text-sm font-medium">
                                <button
                                    onClick={() => disableUrlNavigation ? setInternalFolderId(null) : router.push('/content')}
                                    className="hover:bg-black/5 p-1 rounded-md text-ios-secondary hover:text-ios-text transition-colors"
                                >
                                    Library
                                </button>
                                {folderPath.map((item) => (
                                    <div key={item.id} className="flex items-center">
                                        <ChevronRight size={14} className="text-gray-400 mx-1 flex-shrink-0" />
                                        <button
                                            onClick={() => disableUrlNavigation ? setInternalFolderId(item.id) : router.push(`/content?folderId=${item.id}`)}
                                            className="hover:bg-black/5 p-1 rounded-md truncate max-w-[100px] hover:text-ios-text transition-colors"
                                            title={item.name}
                                        >
                                            {item.name}
                                        </button>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <h2 className="text-xl font-bold text-ios-text">Library</h2>
                        )}
                    </div>

                    {/* Selection Actions & Select All */}
                    <div className="flex items-center gap-2">
                        {/* Sort Dropdown — always visible */}
                        <select
                            value={sortBy}
                            onChange={(e) => setSortBy(e.target.value as any)}
                            title="Sort order"
                            aria-label="Sort order"
                            className="text-xs bg-ios-card border border-ios-separator rounded-lg px-2 py-1.5 focus:border-ios-blue outline-none"
                        >
                            <option value="name-asc">A→Z</option>
                            <option value="name-desc">Z→A</option>
                            <option value="created-asc">Oldest</option>
                            <option value="created-desc">Newest</option>
                        </select>

                        {/* Select All / Deselect All Toggle */}
                        {sortedItems.length > 0 && (
                            <div className="flex items-center gap-1">
                                <button
                                    onClick={handleSelectAll}
                                    className={`text-xs font-semibold px-3 py-1.5 rounded-lg border transition-all ${sortedItems.every(i => selectedIds.includes(i.id))
                                        ? 'bg-ios-blue text-white border-ios-blue'
                                        : 'bg-ios-card border-ios-separator text-ios-blue hover:bg-ios-blue/5'
                                        }`}
                                >
                                    {selectAllServer ? `Deselect All` : sortedItems.every(i => selectedIds.includes(i.id)) ? 'Deselect All' : `Select All`}
                                </button>
                                {totalCount > items.length && selectedIds.length > 0 && !selectAllServer && (
                                    <button
                                        onClick={handleSelectAllServer}
                                        className="text-xs font-semibold px-3 py-1.5 rounded-lg border bg-amber-50 border-amber-300 text-amber-700 hover:bg-amber-100 transition-all"
                                    >
                                        Select All {totalCount}
                                    </button>
                                )}
                            </div>
                        )}

                        {/* Selection Actions */}
                        {selectedIds.length > 0 && mode === 'manage' && (
                            <div className="flex items-center gap-1 bg-blue-50 dark:bg-blue-900/20 px-2 py-1 rounded-lg border border-blue-100 dark:border-blue-900/30">
                                <span className="text-xs font-semibold text-ios-blue mr-1">{selectedIds.length} selected</span>
                                {/* Bulk Rename Button */}
                                <button
                                    onClick={() => setIsBulkRenameOpen(true)}
                                    className="p-1 hover:bg-blue-200 dark:hover:bg-blue-800 rounded text-ios-blue"
                                    title="Rename in Order"
                                >
                                    <TextCursorInput size={14} />
                                </button>
                                <button
                                    onClick={() => openMoveModal(items.filter(i => selectedIds.includes(i.id)))}
                                    className="p-1 hover:bg-blue-200 dark:hover:bg-blue-800 rounded text-ios-blue"
                                    title="Move Selected"
                                >
                                    <Move size={14} />
                                </button>
                                <button
                                    onClick={handleBulkDelete}
                                    disabled={bulkLoading}
                                    className="p-1 hover:bg-red-100 dark:hover:bg-red-900/30 rounded text-red-500 disabled:opacity-50"
                                    title="Delete Selected"
                                >
                                    {bulkLoading ? <div className="animate-spin rounded-full h-3.5 w-3.5 border-b-2 border-red-500" /> : <Trash2 size={14} />}
                                </button>
                            </div>
                        )}

                        {/* Edit Action for Selection */}
                        {selectedIds.length > 0 && mode === 'manage' && (
                            <IOSButton
                                variant="secondary"
                                onClick={() => openEditModal(items.filter(i => selectedIds.includes(i.id)))}
                                className="!py-1.5 !px-3 text-sm flex items-center gap-1"
                            >
                                <Edit2 size={14} /> Edit
                            </IOSButton>
                        )}

                        <IOSButton variant="secondary" onClick={createFolder} className="!py-1.5 !px-3 text-sm flex items-center gap-1">
                            <Plus size={16} /> Folder
                        </IOSButton>

                        <div className="relative">
                            <IOSButton variant="primary" onClick={() => fileInputRef.current?.click()} className="!py-1.5 !px-3 text-sm flex items-center gap-1">
                                <Upload size={16} /> Upload
                            </IOSButton>
                            <input
                                ref={fileInputRef}
                                id="file-upload" type="file" multiple className="hidden"
                                onChange={(e) => {
                                    if (e.target.files?.length) onDrop(Array.from(e.target.files));
                                }}
                            />
                        </div>
                    </div>
                </div>

                {/* Search & Bulk Actions */}
                <div className="relative w-full flex items-center gap-2">
                    <div className="relative flex-1">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
                        <input
                            type="text"
                            placeholder="Search name, caption, tags..."
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            className="w-full bg-ios-card/50 border border-ios-separator rounded-xl py-2 pl-10 pr-4 text-sm focus:outline-none focus:ring-1 focus:ring-ios-blue transition-all"
                        />
                    </div>

                    {/* Total count badge */}
                    {!loading && totalCount > 0 && (
                        <span className="text-xs text-ios-secondary bg-ios-card border border-ios-separator px-2.5 py-2 rounded-xl whitespace-nowrap">
                            {selectedIds.length > 0 ? `${selectedIds.length} / ${totalCount}` : `${totalCount} items`}
                        </span>
                    )}

                    <button
                        onClick={() => setShowFilters(!showFilters)}
                        className={`p-2 rounded-xl transition-colors ${showFilters ? 'bg-ios-blue text-white shadow-sm' : 'bg-ios-card border border-ios-separator text-ios-secondary hover:text-ios-text'}`}
                    >
                        <Filter size={18} />
                    </button>
                    {/* View Toggle */}
                    <div className="flex bg-ios-card/50 rounded-xl border border-ios-separator p-1 gap-1">
                        <button
                            onClick={() => setViewMode('grid')}
                            className={`p-1.5 rounded-lg transition-colors ${viewMode === 'grid' ? 'bg-ios-blue text-white shadow-sm' : 'text-ios-secondary hover:text-ios-text'}`}
                            title="Grid View"
                        >
                            <GridIcon size={16} />
                        </button>
                        <button
                            onClick={() => setViewMode('list')}
                            className={`p-1.5 rounded-lg transition-colors ${viewMode === 'list' ? 'bg-ios-blue text-white shadow-sm' : 'text-ios-secondary hover:text-ios-text'}`}
                            title="List View"
                        >
                            <ListIcon size={16} />
                        </button>
                    </div>
                </div>

                {/* Filter Panel */}
                {showFilters && (
                    <div className="animate-in slide-in-from-top-2 fade-in duration-200 bg-ios-card/50 border border-ios-separator rounded-xl p-4 space-y-4">
                        <div>
                            <span className="text-xs font-medium text-ios-secondary uppercase tracking-wide mb-2 block">Include Tags</span>
                            <div className="flex flex-wrap gap-2">
                                {allTags.map(tag => (
                                    <button
                                        key={tag}
                                        onClick={() => {
                                            if (filterTags.includes(tag)) setFilterTags(filterTags.filter(t => t !== tag));
                                            else setFilterTags([...filterTags, tag]);
                                        }}
                                        className={`text-xs px-2 py-1 rounded-md border transition-colors ${filterTags.includes(tag)
                                            ? 'bg-ios-blue text-white border-ios-blue'
                                            : 'bg-ios-background border-ios-separator text-ios-secondary hover:border-ios-blue'
                                            }`}
                                    >
                                        {tag}
                                    </button>
                                ))}
                                {allTags.length === 0 && <span className="text-xs text-gray-400">No tags found.</span>}
                            </div>
                        </div>

                        <div>
                            <span className="text-xs font-medium text-ios-secondary uppercase tracking-wide mb-2 block">Content Type</span>
                            <div className="flex flex-wrap gap-2">
                                {[
                                    { id: 'carousel_folder', label: 'Folders / Carousels' },
                                    { id: 'image', label: 'Images' },
                                    { id: 'video', label: 'Videos' }
                                ].map(type => (
                                    <button
                                        key={type.id}
                                        onClick={() => {
                                            if (filterTypes.includes(type.id)) setFilterTypes(filterTypes.filter(t => t !== type.id));
                                            else setFilterTypes([...filterTypes, type.id]);
                                        }}
                                        className={`text-xs px-2 py-1 rounded-md border transition-colors ${filterTypes.includes(type.id)
                                            ? 'bg-ios-blue text-white border-ios-blue'
                                            : 'bg-ios-background border-ios-separator text-ios-secondary hover:border-ios-blue'
                                            }`}
                                    >
                                        {type.label}
                                    </button>
                                ))}
                            </div>
                        </div>

                        <div>
                            <span className="text-xs font-medium text-ios-secondary uppercase tracking-wide mb-2 block">Exclude Tags</span>
                            <div className="flex flex-wrap gap-2">
                                {allTags.map(tag => (
                                    <button
                                        key={tag}
                                        onClick={() => {
                                            if (excludeTags.includes(tag)) setExcludeTags(excludeTags.filter(t => t !== tag));
                                            else setExcludeTags([...excludeTags, tag]);
                                        }}
                                        className={`text-xs px-2 py-1 rounded-md border transition-colors ${excludeTags.includes(tag)
                                            ? 'bg-red-500 text-white border-red-500'
                                            : 'bg-ios-background border-ios-separator text-ios-secondary hover:border-red-500'
                                            }`}
                                    >
                                        {tag}
                                    </button>
                                ))}
                            </div>
                        </div>
                    </div>
                )}
            </div>

            {/* Drag Overlay */}
            {
                isDragActive && (
                    <div className="absolute inset-0 bg-ios-blue/10 border-2 border-dashed border-ios-blue z-50 flex items-center justify-center backdrop-blur-sm m-4 rounded-xl pointer-events-none">
                        <p className="text-ios-blue font-bold text-lg bg-white/80 dark:bg-black/50 px-6 py-3 rounded-full shadow-sm">Drop to upload here</p>
                    </div>
                )
            }

            {/* Grid */}
            {/* Select All Server Banner */}
            {selectAllServer && (
                <div className="mx-4 mt-2 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl flex items-center justify-between">
                    <span className="text-sm font-medium text-amber-800 dark:text-amber-200">
                        All {totalCount} items in this folder are selected
                    </span>
                    <button
                        onClick={() => { setSelectAllServer(false); setSelectedIds([]); setSelectionOrder([]); }}
                        className="text-xs font-semibold text-amber-700 hover:text-amber-900 underline"
                    >
                        Clear selection
                    </button>
                </div>
            )}

            <div className="flex-1 overflow-y-auto p-4 scroller" ref={scrollContainerRef} onScroll={handleScroll}>
                {loading ? (
                    <div className="flex justify-center p-12">
                        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-ios-blue"></div>
                    </div>
                ) : sortedItems.length === 0 ? (
                    <div className="text-center py-20 text-ios-secondary flex flex-col items-center gap-4">
                        <div className="w-16 h-16 bg-gray-100 dark:bg-gray-800 rounded-full flex items-center justify-center">
                            <Folder size={32} className="text-gray-300" />
                        </div>
                        <div>
                            <p className="font-medium text-lg">Current folder is empty</p>
                            <p className="text-sm mt-1 opacity-70">Drag and drop files or create a new folder.</p>
                        </div>
                    </div>
                ) : (
                    viewMode === 'list' ? (
                        <div className="bg-ios-card border border-ios-separator rounded-xl overflow-hidden shadow-sm">
                            <table className="min-w-full">
                                {/* Sortable column headers */}
                                <thead className="bg-ios-background/80 backdrop-blur-sm sticky top-0 z-10">
                                    <tr className="border-b border-ios-separator">
                                        {/* Checkbox select-all */}
                                        <th scope="col" className="w-10 pl-4 pr-2 py-3">
                                            <button
                                                onClick={(e) => { e.stopPropagation(); handleSelectAll(); }}
                                                className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-all ${sortedItems.length > 0 && sortedItems.every(i => selectedIds.includes(i.id))
                                                    ? 'bg-ios-blue border-ios-blue text-white'
                                                    : 'border-ios-separator hover:border-ios-blue'
                                                    }`}
                                                title="Select / Deselect All"
                                            >
                                                {sortedItems.length > 0 && sortedItems.every(i => selectedIds.includes(i.id)) && <Check size={12} />}
                                            </button>
                                        </th>
                                        <th scope="col"
                                            className="px-3 py-3 text-left text-xs font-semibold text-ios-secondary uppercase tracking-wider cursor-pointer hover:text-ios-text select-none"
                                            onClick={() => setSortBy(s => s === 'name-asc' ? 'name-desc' : 'name-asc')}
                                        >
                                            <div className="flex items-center gap-1">
                                                Name
                                                {sortBy.startsWith('name') && <span className="text-ios-blue">{sortBy === 'name-asc' ? '↑' : '↓'}</span>}
                                            </div>
                                        </th>
                                        <th scope="col" className="px-3 py-3 text-left text-xs font-semibold text-ios-secondary uppercase tracking-wider hidden sm:table-cell">Type</th>
                                        <th scope="col" className="px-3 py-3 text-left text-xs font-semibold text-ios-secondary uppercase tracking-wider hidden md:table-cell">Size</th>
                                        <th scope="col" className="px-3 py-3 text-left text-xs font-semibold text-ios-secondary uppercase tracking-wider hidden lg:table-cell">Duration</th>
                                        <th scope="col"
                                            className="px-3 py-3 text-left text-xs font-semibold text-ios-secondary uppercase tracking-wider cursor-pointer hover:text-ios-text select-none hidden xl:table-cell"
                                            onClick={() => setSortBy(s => s === 'created-desc' ? 'created-asc' : 'created-desc')}
                                        >
                                            <div className="flex items-center gap-1">
                                                Date
                                                {sortBy.startsWith('created') && <span className="text-ios-blue">{sortBy === 'created-asc' ? '↑' : '↓'}</span>}
                                            </div>
                                        </th>
                                        <th scope="col" className="px-3 py-3 text-right text-xs font-semibold text-ios-secondary uppercase tracking-wider">Actions</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-ios-separator/50">
                                    {sortedItems.map((item) => {
                                        const isSelected = selectedIds.includes(item.id);
                                        return (
                                            <tr
                                                key={item.id}
                                                onClick={() => {
                                                    if (item.type === 'carousel_folder') {
                                                        if (mode === 'select' && disableUrlNavigation) {
                                                            toggleSelection(item.id);
                                                        } else {
                                                            disableUrlNavigation ? setInternalFolderId(item.id) : router.push(`/content?folderId=${item.id}`);
                                                        }
                                                    } else {
                                                        toggleSelection(item.id);
                                                    }
                                                }}
                                                className={`group cursor-pointer transition-colors duration-100 ${isSelected
                                                    ? 'bg-blue-50 dark:bg-blue-900/15'
                                                    : 'hover:bg-ios-background/60'
                                                    }`}
                                            >
                                                {/* Checkbox */}
                                                <td className="pl-4 pr-2 py-3 w-10" onClick={(e) => { e.stopPropagation(); toggleSelection(item.id); }}>
                                                    <div className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-all flex-shrink-0 ${isSelected
                                                        ? 'bg-ios-blue border-ios-blue text-white'
                                                        : 'border-ios-separator group-hover:border-ios-blue/50'
                                                        }`}>
                                                        {isSelected && <Check size={12} />}
                                                    </div>
                                                </td>

                                                {/* Name + thumbnail + meta */}
                                                <td className="px-3 py-2.5">
                                                    <div className="flex items-center gap-3 min-w-0">
                                                        {/* Thumbnail */}
                                                        <div className="flex-shrink-0 h-12 w-12 rounded-lg overflow-hidden bg-gray-100 dark:bg-gray-800 flex items-center justify-center border border-ios-separator relative">
                                                            {item.type === 'carousel_folder' ? (
                                                                item.thumbnail_url ? (
                                                                    <>
                                                                        <img src={item.thumbnail_url} className="w-full h-full object-cover opacity-80" alt="" />
                                                                        <div className="absolute inset-0 flex items-center justify-center bg-black/20">
                                                                            <Folder size={18} className="text-white drop-shadow" />
                                                                        </div>
                                                                    </>
                                                                ) : (
                                                                    <Folder size={22} className="text-blue-400" />
                                                                )
                                                            ) : item.type === 'video' ? (
                                                                /* No <video> tag — static placeholder saves RAM/CPU */
                                                                <div className="w-full h-full bg-gray-800 flex items-center justify-center">
                                                                    <Video size={16} className="text-white/60" />
                                                                </div>
                                                            ) : (
                                                                <img className="w-full h-full object-cover" src={item.url} alt="" />
                                                            )}
                                                        </div>
                                                        {/* Text info */}
                                                        <div className="min-w-0 flex-1">
                                                            <p className="text-sm font-medium text-ios-text truncate max-w-xs" title={item.name}>{item.name}</p>
                                                            {item.caption && <p className="text-xs text-ios-secondary truncate max-w-xs mt-0.5" title={item.caption}>{item.caption}</p>}
                                                            {item.tags && item.tags.length > 0 && (
                                                                <div className="flex flex-wrap gap-1 mt-1">
                                                                    {item.tags.slice(0, 3).map(tag => (
                                                                        <span key={tag} className="inline-block text-[10px] px-1.5 py-0.5 rounded bg-ios-blue/10 text-ios-blue font-medium leading-none">
                                                                            {tag}
                                                                        </span>
                                                                    ))}
                                                                    {item.tags.length > 3 && <span className="text-[10px] text-ios-secondary">+{item.tags.length - 3}</span>}
                                                                </div>
                                                            )}
                                                        </div>
                                                    </div>
                                                </td>

                                                {/* Type badge */}
                                                <td className="px-3 py-2.5 whitespace-nowrap hidden sm:table-cell">
                                                    <span className={`px-2 py-0.5 inline-flex text-xs font-semibold rounded-full ${item.type === 'video'
                                                        ? 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300'
                                                        : item.type === 'carousel_folder'
                                                            ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
                                                            : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
                                                        }`}>
                                                        {item.type === 'carousel_folder' ? 'Carousel' : item.type === 'video' ? 'Video' : 'Image'}
                                                    </span>
                                                </td>

                                                {/* Size */}
                                                <td className="px-3 py-2.5 whitespace-nowrap text-sm text-ios-secondary hidden md:table-cell">
                                                    {formatBytes(item.size || 0)}
                                                </td>

                                                {/* Duration */}
                                                <td className="px-3 py-2.5 whitespace-nowrap text-sm text-ios-secondary hidden lg:table-cell">
                                                    {item.duration ? formatTime(item.duration) : <span className="text-ios-separator">—</span>}
                                                </td>

                                                {/* Date */}
                                                <td className="px-3 py-2.5 whitespace-nowrap text-xs text-ios-secondary hidden xl:table-cell">
                                                    {new Date(item.created_at).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: '2-digit' })}
                                                </td>

                                                {/* Actions */}
                                                <td className="px-3 py-2.5 whitespace-nowrap text-right" onClick={(e) => e.stopPropagation()}>
                                                    {mode === 'manage' && (
                                                        <div className="flex items-center justify-end gap-0.5">
                                                            <button
                                                                onClick={(e) => { e.stopPropagation(); openEditModal([item]); }}
                                                                className="p-1.5 rounded-lg text-ios-secondary hover:text-ios-blue hover:bg-ios-blue/10 transition-colors"
                                                                title="Edit metadata"
                                                            >
                                                                <Edit2 size={15} />
                                                            </button>
                                                            {item.type === 'image' && (
                                                                <button
                                                                    onClick={(e) => { e.stopPropagation(); openImageEditor(item); }}
                                                                    className="p-1.5 rounded-lg text-ios-secondary hover:text-violet-500 hover:bg-violet-500/10 transition-colors"
                                                                    title="Edit image"
                                                                >
                                                                    <Palette size={15} />
                                                                </button>
                                                            )}
                                                            <button
                                                                onClick={(e) => { e.stopPropagation(); openMoveModal([item]); }}
                                                                className="p-1.5 rounded-lg text-ios-secondary hover:text-ios-blue hover:bg-ios-blue/10 transition-colors"
                                                                title="Move"
                                                            >
                                                                <Move size={15} />
                                                            </button>
                                                            <button
                                                                onClick={(e) => deleteItem(e, item)}
                                                                className="p-1.5 rounded-lg text-ios-secondary hover:text-red-500 hover:bg-red-500/10 transition-colors"
                                                                title="Delete"
                                                            >
                                                                <Trash2 size={15} />
                                                            </button>
                                                        </div>
                                                    )}
                                                    {mode === 'select' && (
                                                        <div
                                                            onClick={() => toggleSelection(item.id)}
                                                            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-semibold cursor-pointer transition-all ${isSelected
                                                                ? 'bg-ios-blue border-ios-blue text-white'
                                                                : 'bg-ios-background border-ios-separator text-ios-secondary hover:border-ios-blue hover:text-ios-blue'
                                                                }`}
                                                        >
                                                            {isSelected ? <Check size={12} /> : <div className="w-3 h-3 border-2 border-current rounded-sm" />}
                                                            <span className="hidden sm:inline">{isSelected ? 'Selected' : 'Select'}</span>
                                                        </div>
                                                    )}
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>

                            {/* Footer: load more */}
                            {(loadingMore || (hasMore && !loadingMore)) && (
                                <div className="border-t border-ios-separator/50 px-4 py-3 flex items-center justify-between bg-ios-background/50">
                                    <span className="text-xs text-ios-secondary">Showing {items.length} of {totalCount} items</span>
                                    {loadingMore ? (
                                        <div className="flex items-center gap-2 text-xs text-ios-secondary">
                                            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-ios-blue" />
                                            Loading…
                                        </div>
                                    ) : (
                                        <button
                                            onClick={loadMore}
                                            className="text-xs font-semibold text-ios-blue hover:underline px-3 py-1.5 rounded-lg hover:bg-ios-blue/5 transition-colors"
                                        >
                                            Load more
                                        </button>
                                    )}
                                </div>
                            )}
                        </div>
                    ) : (
                        <AutoSizer
                            renderProp={({ height, width }: { height: number | undefined; width: number | undefined }): React.ReactElement => {
                                // Calculate how many columns fit
                                // Assuming min item width of ~150px (h-40) + gap
                                const MIN_ITEM_WIDTH = 160;
                                const w = width || 0;
                                const h = height || 0;
                                const columnCount = Math.max(2, Math.floor(w / MIN_ITEM_WIDTH));
                                const rowCount = Math.ceil(sortedItems.length / columnCount);

                                // Width per item is exact to fill the area, height matches to keep purely square
                                const columnWidth = w / columnCount;
                                const rowHeight = columnWidth; // aspect-square

                                const itemData = {
                                    columnCount,
                                    sortedItems,
                                    handleDragStart,
                                    handleDragEnd,
                                    handleDragOver,
                                    handleDragLeave,
                                    handleDrop,
                                    mode,
                                    disableUrlNavigation,
                                    toggleSelection,
                                    setInternalFolderId,
                                    router,
                                    selectedIds,
                                    dropTargetId,
                                    draggedItems,
                                    openEditModal,
                                    openImageEditor,
                                    deleteItem,
                                    openMoveModal,
                                    formatBytes,
                                    formatTime
                                };

                                return (
                                    <>
                                        <GridComponent
                                            className="scroller outline-none"
                                            columnCount={columnCount}
                                            columnWidth={columnWidth}
                                            rowCount={rowCount}
                                            rowHeight={rowHeight}
                                            style={{ height: h, width: w }}
                                            {...({ itemData } as any)}
                                        >
                                            {GridCell as any}
                                        </GridComponent>
                                        {loadingMore && (
                                            <div className="flex justify-center py-4">
                                                <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-ios-blue" />
                                            </div>
                                        )}
                                        {hasMore && !loadingMore && (
                                            <div className="text-center py-3">
                                                <button onClick={loadMore} className="text-sm text-ios-blue hover:underline">Load more ({items.length} of {totalCount})</button>
                                            </div>
                                        )}
                                    </>
                                );
                            }}
                        />
                    )
                )}
            </div>

            {/* Rename Dialog (Simple prompt handling via state effect is redundant if we use window.prompt, 
               but if we wanted a custom modal we'd render it here. For now window.prompt in handler is enough 
               but we set state just to track intended target if we were to upgrade UI) */}

            < MoveContentModal
                isOpen={isMoveModalOpen}
                onClose={() => setIsMoveModalOpen(false)}
                itemsToMove={moveItems}
                onMoveComplete={onMoveComplete}
            />

            <EditContentModal
                isOpen={isEditModalOpen}
                onClose={() => setIsEditModalOpen(false)}
                itemsToEdit={itemsToEdit}
                onEditComplete={onEditComplete}
            />

            {
                imageEditorItem && (
                    <ImageEditorModal
                        isOpen={isImageEditorOpen}
                        onClose={() => setIsImageEditorOpen(false)}
                        imageUrl={imageEditorItem.url || ''}
                        onSave={handleImageEditorSave}
                    />
                )
            }

            {/* Bulk Rename Modal */}
            {
                isBulkRenameOpen && (
                    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
                        <div className="bg-ios-card w-full max-w-md rounded-2xl p-6 shadow-2xl">
                            <h3 className="text-lg font-semibold text-ios-text mb-4">Rename {selectionOrder.length} Items in Order</h3>
                            <p className="text-sm text-ios-secondary mb-4">
                                Items will be renamed as: <code className="bg-ios-background px-2 py-1 rounded">prefix_001</code>, <code className="bg-ios-background px-2 py-1 rounded">prefix_002</code>, etc.
                            </p>
                            <input
                                type="text"
                                value={bulkRenamePrefix}
                                onChange={(e) => setBulkRenamePrefix(e.target.value)}
                                placeholder="Enter prefix (e.g., slide)"
                                className="w-full bg-ios-background border border-ios-separator rounded-xl px-4 py-3 text-[17px] focus:outline-none focus:border-ios-blue focus:ring-1 focus:ring-ios-blue mb-4"
                                autoFocus
                            />
                            <div className="flex justify-end gap-2">
                                <IOSButton variant="secondary" onClick={() => { setIsBulkRenameOpen(false); setBulkRenamePrefix(''); }}>
                                    Cancel
                                </IOSButton>
                                <IOSButton variant="primary" onClick={handleBulkRename} disabled={!bulkRenamePrefix.trim()}>
                                    Rename
                                </IOSButton>
                            </div>
                        </div>
                    </div>
                )
            }

            <IOSToast
                message={toast.msg}
                type={toast.type}
                isVisible={toast.show}
                onClose={() => setToast(prev => ({ ...prev, show: false }))}
            />
        </div >
    );
}
