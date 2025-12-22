'use client';
import { useState, useEffect, useCallback, useMemo } from 'react';
import { supabase } from '@/lib/supabase';
import {
    Folder, Video, MoreVertical,
    Upload, Plus, ArrowLeft, Check, Trash2, Edit2, Search,
    ChevronRight, Move
} from 'lucide-react';
import IOSButton from './IOSButton';
import { useDropzone } from 'react-dropzone';
import { useRouter, useSearchParams } from 'next/navigation';
import MoveContentModal from './MoveContentModal';

interface ContentItem {
    id: string;
    type: 'image' | 'video' | 'carousel_folder' | 'carousel_item';
    name: string;
    url?: string;
    path?: string;
    tags?: string[];
    description?: string;
    parent_id?: string | null;
    created_at: string;
}

interface ContentLibraryProps {
    mode?: 'manage' | 'select';
    onSelectionChange?: (selectedIds: string[]) => void;
    initialSelection?: string[];
    allowedTypes?: string[]; // 'video', 'image', 'carousel'
}

export default function ContentLibrary({
    mode = 'manage',
    onSelectionChange,
    initialSelection = [],
    allowedTypes = ['video', 'image', 'carousel_folder']
}: ContentLibraryProps) {
    const router = useRouter();
    const searchParams = useSearchParams();

    // URL state for navigation
    const currentFolderId = searchParams.get('folderId') || null;

    const [items, setItems] = useState<ContentItem[]>([]);
    // Track the folder object for the current ID (for name display)
    const [currentFolder, setCurrentFolder] = useState<ContentItem | null>(null);
    const [folderPath, setFolderPath] = useState<ContentItem[]>([]);

    const [loading, setLoading] = useState(true);
    const [selectedIds, setSelectedIds] = useState<string[]>(initialSelection);
    const [uploading, setUploading] = useState(false);
    const [search, setSearch] = useState('');

    // Modal states
    const [isMoveModalOpen, setIsMoveModalOpen] = useState(false);
    const [moveItems, setMoveItems] = useState<ContentItem[]>([]);
    const [editingItem, setEditingItem] = useState<ContentItem | null>(null); // For rename

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
                // 1. Get current folder info
                const { data: folder, error } = await supabase
                    .from('content_items')
                    .select('*')
                    .eq('id', currentFolderId)
                    .single();

                if (error) throw error;
                setCurrentFolder(folder);

                // 2. Build path (Recursive or iterative up-query)
                // For simplified approach with depth < 5 usually, we can just trace up parents
                // Or better, we can assume a simplified breadcrumb for now or fetch hierarchy 
                // Creating a recursive CTE function in Supabase is best, but here let's do simple:
                // Just fetching the current folder is enough for the title. 
                // Full breadcrumb path needs recursive fetching.

                // Let's implement a simple "trace up" for breadcrumbs locally
                // Or rely on a separate recursive fetch if needed.
                // For now, let's keep it simple: Show "..." > Parent > Current
                // Or attempting to fetch recursive parents.

                const path: ContentItem[] = [folder];
                let pid = folder.parent_id;
                while (pid) {
                    const { data: parent } = await supabase
                        .from('content_items')
                        .select('id, name, parent_id, type') // Minimal select
                        .eq('id', pid)
                        .single();
                    if (parent) {
                        path.unshift(parent as ContentItem);
                        pid = parent.parent_id;
                    } else {
                        pid = null; // stop if not found
                    }
                    // Circuit breaker
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
    }, [currentFolderId, router]);


    const fetchContent = async (folderId: string | null) => {
        setLoading(true);
        try {
            let query = supabase
                .from('content_items')
                .select('*')
                .order('created_at', { ascending: false });

            if (folderId) {
                query = query.eq('parent_id', folderId);
            } else {
                query = query.is('parent_id', null);
            }

            const { data, error } = await query;
            if (error) throw error;
            setItems(data || []);
        } catch (error) {
            console.error('Error fetching content:', error);
        } finally {
            setLoading(false);
        }
    };

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
        setUploading(true);
        try {
            const { data: { session } } = await supabase.auth.getSession();
            if (!session) return;

            // Grouping logic for folders dropped... (same as before)
            // But now we respect `currentFolderId` from URL

            const folderGroups: Record<string, File[]> = {};
            const standaloneFiles: File[] = [];

            acceptedFiles.forEach((file: any) => {
                const cleanPath = (file.path || file.name).replace(/^\//, '');
                const parts = cleanPath.split('/');
                if (parts.length > 1) {
                    const folderName = parts[0];
                    if (!folderGroups[folderName]) folderGroups[folderName] = [];
                    folderGroups[folderName].push(file);
                } else {
                    standaloneFiles.push(file);
                }
            });

            // Helper to upload a single file
            const uploadSingleFile = async (file: File, parentId: string | null = null, forceType: string | null = null) => {
                const fileExt = file.name.split('.').pop();
                const fileName = `${session.user.id}/${Math.random().toString(36).substring(2)}.${fileExt}`;
                const filePath = fileName;

                const { error: uploadError } = await supabase.storage
                    .from('instagram-videos')
                    .upload(filePath, file);

                if (uploadError) throw uploadError;

                const { data: publicUrlData } = supabase.storage
                    .from('instagram-videos')
                    .getPublicUrl(filePath);

                let type = 'video';
                if (forceType) {
                    type = forceType;
                } else if (file.type.startsWith('image/')) {
                    type = parentId ? 'carousel_item' : 'image';
                } else if (file.type.startsWith('video/')) {
                    type = parentId ? 'carousel_item' : 'video';
                }

                await supabase.from('content_items').insert({
                    user_id: session.user.id,
                    name: file.name,
                    type,
                    url: publicUrlData.publicUrl,
                    path: filePath,
                    parent_id: parentId
                });
            };

            // 1. Process Standalone Files
            for (const file of standaloneFiles) {
                await uploadSingleFile(file, currentFolderId);
            }

            // 2. Process Folder Groups
            // If in root, create new folders. If inside a folder, flatten (simple logic for now)
            if (currentFolderId) {
                // Flatten into current folder
                for (const groupName in folderGroups) {
                    for (const file of folderGroups[groupName]) {
                        await uploadSingleFile(file, currentFolderId);
                    }
                }
            } else {
                // Create folders at root
                for (const [folderName, groupFiles] of Object.entries(folderGroups)) {
                    const { data: folderData, error: folderError } = await supabase
                        .from('content_items')
                        .insert({
                            user_id: session.user.id,
                            name: folderName,
                            type: 'carousel_folder',
                            parent_id: null
                        })
                        .select()
                        .single();

                    if (folderError || !folderData) {
                        console.error('Failed to create folder:', folderName);
                        continue;
                    }
                    for (const file of groupFiles) {
                        await uploadSingleFile(file, folderData.id, 'carousel_item');
                    }
                }
            }

            fetchContent(currentFolderId);
        } catch (error) {
            console.error('Upload failed:', error);
            alert('Upload failed');
        } finally {
            setUploading(false);
        }
    }, [currentFolderId]);

    const { getRootProps, getInputProps, isDragActive } = useDropzone({
        onDrop,
        noClick: true,
        noKeyboard: true
    });

    const createFolder = async () => {
        const name = prompt('Enter folder name:');
        if (!name) return;

        try {
            const { data: { session } } = await supabase.auth.getSession();
            if (!session) return;

            await supabase.from('content_items').insert({
                user_id: session.user.id,
                name,
                type: 'carousel_folder',
                parent_id: currentFolderId
            });
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
        } else {
            setSelectedIds([...selectedIds, id]);
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
            await supabase.storage.from('instagram-videos').remove([item.path]);
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

        const { error } = await supabase.from('content_items').delete().eq('id', item.id);
        if (error) throw error;
    };

    const handleRename = async () => {
        if (!editingItem) return;
        const newName = prompt('New name:', editingItem.name);
        if (!newName || newName === editingItem.name) {
            setEditingItem(null);
            return;
        }

        try {
            const { error } = await supabase
                .from('content_items')
                .update({ name: newName })
                .eq('id', editingItem.id);

            if (error) throw error;
            fetchContent(currentFolderId);
        } catch (error) {
            console.error('Rename failed', error);
            alert('Rename failed');
        } finally {
            setEditingItem(null);
        }
    };

    // Triggered when "Move" is clicked on an item or selection
    const openMoveModal = (items: ContentItem[]) => {
        setMoveItems(items);
        setIsMoveModalOpen(true);
    };

    const onMoveComplete = () => {
        fetchContent(currentFolderId);
        setSelectedIds([]);
    };

    // -------------------------------------------------------------------------
    // Renders
    // -------------------------------------------------------------------------

    const filteredItems = items.filter(item =>
        item.name.toLowerCase().includes(search.toLowerCase())
    );

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
                                    onClick={() => router.push('/content')}
                                    className="hover:bg-black/5 p-1 rounded-md text-ios-secondary hover:text-ios-text transition-colors"
                                >
                                    Library
                                </button>
                                {folderPath.map((item) => (
                                    <div key={item.id} className="flex items-center">
                                        <ChevronRight size={14} className="text-gray-400 mx-1 flex-shrink-0" />
                                        <button
                                            onClick={() => router.push(`/content?folderId=${item.id}`)}
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

                    <div className="flex items-center gap-2">
                        {/* Selection Actions */}
                        {selectedIds.length > 0 && mode === 'manage' && (
                            <div className="mr-2 flex items-center gap-1 bg-blue-50 dark:bg-blue-900/20 px-2 py-1 rounded-lg border border-blue-100 dark:border-blue-900/30">
                                <span className="text-xs font-semibold text-ios-blue mr-1">{selectedIds.length} selected</span>
                                <button
                                    onClick={() => openMoveModal(items.filter(i => selectedIds.includes(i.id)))}
                                    className="p-1 hover:bg-blue-200 dark:hover:bg-blue-800 rounded text-ios-blue"
                                    title="Move Selected"
                                >
                                    <Move size={14} />
                                </button>
                                <button
                                    onClick={async () => {
                                        if (!confirm(`Delete ${selectedIds.length} items?`)) return;
                                        // Bulk delete
                                        for (const id of selectedIds) {
                                            const item = items.find(i => i.id === id);
                                            if (item) await doDelete(item);
                                        }
                                        setSelectedIds([]);
                                        fetchContent(currentFolderId);
                                    }}
                                    className="p-1 hover:bg-red-100 dark:hover:bg-red-900/30 rounded text-red-500"
                                    title="Delete Selected"
                                >
                                    <Trash2 size={14} />
                                </button>
                            </div>
                        )}

                        <IOSButton variant="secondary" onClick={createFolder} className="!py-1.5 !px-3 text-sm flex items-center gap-1">
                            <Plus size={16} /> Folder
                        </IOSButton>

                        <div className="relative">
                            <IOSButton variant="primary" disabled={uploading} className="!py-1.5 !px-3 text-sm flex items-center gap-1">
                                <label htmlFor="file-upload" className="flex items-center gap-1 cursor-pointer">
                                    <Upload size={16} /> {uploading ? 'Uploading...' : 'Upload'}
                                </label>
                            </IOSButton>
                            <input
                                id="file-upload" type="file" multiple className="hidden"
                                onChange={(e) => {
                                    if (e.target.files?.length) onDrop(Array.from(e.target.files));
                                }}
                            />
                        </div>
                    </div>
                </div>

                {/* Search */}
                <div className="relative w-full">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
                    <input
                        type="text"
                        placeholder="Search files and folders..."
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        className="w-full bg-ios-card/50 border border-ios-separator rounded-xl py-2 pl-10 pr-4 text-sm focus:outline-none focus:ring-1 focus:ring-ios-blue transition-all"
                    />
                </div>
            </div>

            {/* Drag Overlay */}
            {isDragActive && (
                <div className="absolute inset-0 bg-ios-blue/10 border-2 border-dashed border-ios-blue z-50 flex items-center justify-center backdrop-blur-sm m-4 rounded-xl pointer-events-none">
                    <p className="text-ios-blue font-bold text-lg bg-white/80 dark:bg-black/50 px-6 py-3 rounded-full shadow-sm">Drop to upload here</p>
                </div>
            )}

            {/* Grid */}
            <div className="flex-1 overflow-y-auto p-4 scroller">
                {loading ? (
                    <div className="flex justify-center p-12">
                        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-ios-blue"></div>
                    </div>
                ) : filteredItems.length === 0 ? (
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
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
                        {filteredItems.map(item => (
                            <div
                                key={item.id}
                                onClick={() => {
                                    if (item.type === 'carousel_folder') {
                                        // Navigate into folder
                                        router.push(`/content?folderId=${item.id}`);
                                    } else {
                                        toggleSelection(item.id);
                                    }
                                }}
                                className={`
                                    group relative aspect-square rounded-2xl border overflow-hidden cursor-pointer transition-all duration-200
                                    ${selectedIds.includes(item.id)
                                        ? 'ring-2 ring-ios-blue border-transparent shadow-lg scale-[1.02]'
                                        : 'border-ios-separator hover:border-ios-blue/50 hover:shadow-md'}
                                    bg-ios-card
                                `}
                            >
                                {/* Thumbnail Content */}
                                {item.type === 'carousel_folder' ? (
                                    <div className="w-full h-full flex flex-col items-center justify-center bg-blue-50/50 dark:bg-blue-900/5 hover:bg-blue-50 dark:hover:bg-blue-900/10 transition-colors">
                                        <Folder size={48} strokeWidth={1} className="text-blue-400 fill-blue-400/20" />
                                        <span className="text-xs font-medium mt-3 px-3 text-center truncate w-full text-ios-secondary">{item.name}</span>
                                    </div>
                                ) : (
                                    <>
                                        {item.type === 'video' ? (
                                            <div className="w-full h-full bg-black flex items-center justify-center relative">
                                                <video src={item.url} className="w-full h-full object-cover opacity-80" />
                                                <div className="absolute inset-0 flex items-center justify-center">
                                                    <div className="w-10 h-10 rounded-full bg-white/20 backdrop-blur-md flex items-center justify-center">
                                                        <Video className="text-white fill-white" size={18} />
                                                    </div>
                                                </div>
                                            </div>
                                        ) : (
                                            <img src={item.url} alt={item.name} className="w-full h-full object-cover" />
                                        )}

                                        {/* Overlay Info (Gradient) */}
                                        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent p-3 pt-8 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col justify-end">
                                            <p className="text-white text-xs font-medium truncate drop-shadow-sm">{item.name}</p>
                                        </div>
                                    </>
                                )}

                                {/* Selection Checkbox */}
                                {selectedIds.includes(item.id) && (
                                    <div className="absolute top-2 right-2 bg-ios-blue text-white rounded-full p-1 shadow-sm z-20 animate-in zoom-in duration-200">
                                        <Check size={12} strokeWidth={3} />
                                    </div>
                                )}

                                {/* Hover Actions (Context Menu triggers) */}
                                {mode === 'manage' && (
                                    <div className="absolute top-2 right-2 flex flex-col gap-1 opacity-0 group-hover:opacity-100 transition-opacity z-10 translate-x-2 group-hover:translate-x-0 duration-200">
                                        <button
                                            onClick={(e) => { e.stopPropagation(); setEditingItem(item); handleRename(); }}
                                            className="p-1.5 bg-white/90 dark:bg-black/90 backdrop-blur text-ios-text rounded-full shadow-sm hover:text-blue-500 transition-colors"
                                            title="Rename"
                                        >
                                            <Edit2 size={12} />
                                        </button>
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
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* Rename Dialog (Simple prompt handling via state effect is redundant if we use window.prompt, 
               but if we wanted a custom modal we'd render it here. For now window.prompt in handler is enough 
               but we set state just to track intended target if we were to upgrade UI) */}

            <MoveContentModal
                isOpen={isMoveModalOpen}
                onClose={() => setIsMoveModalOpen(false)}
                itemsToMove={moveItems}
                onMoveComplete={onMoveComplete}
            />
        </div>
    );
}
