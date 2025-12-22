'use client';
import { useState, useEffect, useCallback, useMemo } from 'react';
import { supabase } from '@/lib/supabase';
import {
    Folder, Video, MoreVertical,
    Upload, Plus, ArrowLeft, Check, Trash2, Edit2, Search,
    ChevronRight, Move, Filter, X, Grid, List as ListIcon
} from 'lucide-react';
import IOSButton from './IOSButton';
import { useDropzone } from 'react-dropzone';
import { useRouter, useSearchParams } from 'next/navigation';
import MoveContentModal from './MoveContentModal';
import UploadProgressPanel, { UploadTask } from './UploadProgressPanel';
import IOSToast, { ToastType } from './IOSToast';
import { useRef } from 'react';
import EditContentModal from './EditContentModal';

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
    const [showFilters, setShowFilters] = useState(false);
    const [filterTags, setFilterTags] = useState<string[]>([]);
    const [excludeTags, setExcludeTags] = useState<string[]>([]);
    const [filterTypes, setFilterTypes] = useState<string[]>([]);
    const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
    const [sizeFilter, setSizeFilter] = useState<'all' | 'small' | 'medium' | 'large'>('all');
    const [durationFilter, setDurationFilter] = useState<'all' | 'short' | 'medium' | 'long'>('all');

    // Modal states
    const [isMoveModalOpen, setIsMoveModalOpen] = useState(false);
    const [moveItems, setMoveItems] = useState<ContentItem[]>([]);

    // Edit Modal State
    const [isEditModalOpen, setIsEditModalOpen] = useState(false);
    const [itemsToEdit, setItemsToEdit] = useState<ContentItem[]>([]);
    const [editingItem, setEditingItem] = useState<ContentItem | null>(null); // Legacy, kept for logic but unused if we switch full to modal

    // Upload Queue State
    const [uploadQueue, setUploadQueue] = useState<UploadTask[]>([]);
    const [isUploadPanelOpen, setIsUploadPanelOpen] = useState(false);
    const uploadingRef = useRef(false); // Ref to track if queue processing is active
    const [uploadMetrics, setUploadMetrics] = useState({ speed: '', eta: '' });
    const startTimeRef = useRef<number>(0);
    const startBytesRef = useRef<number>(0);

    // Toast State
    const [toast, setToast] = useState<{ msg: string; type: ToastType; show: boolean }>({ msg: '', type: 'success', show: false });

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

    // -------------------------------------------------------------------------
    // Upload Queue Processing
    // -------------------------------------------------------------------------

    const processUploadQueue = async () => {
        if (uploadingRef.current) return;

        // Find next pending task
        // We need to use functional state update pattern carefully or refs
        // Simplest is to find the first 'pending' in the current queue state
        // But inside async function, state might be verify stale? 
        // We will call this function recursively/iteratively using state updater to get fresh queue

        setUploadQueue(prev => {
            const nextTaskIndex = prev.findIndex(t => t.status === 'pending');
            if (nextTaskIndex === -1) {
                uploadingRef.current = false;
                setUploading(false);
                return prev;
            }

            // Start processing
            uploadingRef.current = true;
            const nextTask = prev[nextTaskIndex];

            // Trigger the upload logic asynchronously
            executeUpload(nextTask);

            return prev;
        });
    };

    // Execute single upload with XHR
    const executeUpload = async (task: UploadTask) => {
        if (!task.storagePath) {
            console.error("Missing storage path for task", task);
            setUploadQueue(prev => prev.map(t => t.id === task.id ? { ...t, status: 'error', error: "Internal Error: Missing path" } : t));
            processUploadQueue();
            return;
        }

        try {
            // Update status to uploading
            setUploadQueue(prev => prev.map(t => t.id === task.id ? { ...t, status: 'uploading' } : t));

            const { data: { session } } = await supabase.auth.getSession();
            if (!session) throw new Error("No session");

            // XHR Upload
            await new Promise<void>((resolve, reject) => {
                const xhr = new XMLHttpRequest();
                // Construct URL: Project URL + Storage API info
                const projectId = process.env.NEXT_PUBLIC_SUPABASE_URL?.split('//')[1].split('.')[0];
                const uploadUrl = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/instagram-videos/${task.storagePath}`;

                xhr.open('POST', uploadUrl);

                xhr.setRequestHeader('Authorization', `Bearer ${session.access_token}`);
                xhr.setRequestHeader('x-upsert', 'true'); // Optional: overwrite
                xhr.setRequestHeader('apikey', process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);

                // Track progress
                xhr.upload.onprogress = (e) => {
                    if (e.lengthComputable) {
                        const percent = (e.loaded / e.total) * 100;
                        setUploadQueue(prev => prev.map(t => t.id === task.id ? { ...t, progress: percent } : t));
                    }
                };

                xhr.onload = async () => {
                    if (xhr.status >= 200 && xhr.status < 300) {
                        resolve();
                    } else {
                        reject(new Error(`Upload failed with status ${xhr.status}`));
                    }
                };

                xhr.onerror = () => reject(new Error("Network error"));

                xhr.send(task.file);
            });

            // Insert into DB
            const { data: publicUrlData } = supabase.storage
                .from('instagram-videos')
                .getPublicUrl(task.storagePath!);

            let type = 'video';
            const ft = task.forceType;
            if (ft) {
                type = ft;
            } else if (task.file.type.startsWith('image/')) {
                type = task.dbParentId ? 'carousel_item' : 'image';
            } else if (task.file.type.startsWith('video/')) {
                type = task.dbParentId ? 'carousel_item' : 'video';
            }

            const { data: insertedData, error: insertError } = await supabase.from('content_items').insert({
                user_id: session.user.id,
                name: task.file.name,
                type,
                url: publicUrlData.publicUrl,
                path: task.storagePath,
                parent_id: task.dbParentId,
                size: task.file.size,
                duration: (task as any).duration || 0
            }).select().single();

            if (insertError) throw insertError;

            // Mark completed
            setUploadQueue(prev => prev.map(t => t.id === task.id ? { ...t, status: 'completed', progress: 100 } : t));

            // Real-time Update: Optimistically add to list if in current folder
            if (task.dbParentId === currentFolderId || (!task.dbParentId && !currentFolderId)) {
                // If we got the inserted data back, we can safely add it to state
                if (insertedData) {
                    setItems(prev => [insertedData as ContentItem, ...prev]);
                } else {
                    // Fallback to fetch
                    fetchContent(currentFolderId);
                }
            }

        } catch (error: any) {
            console.error('Task failed:', error);
            setUploadQueue(prev => prev.map(t => t.id === task.id ? { ...t, status: 'error', error: error.message } : t));
        } finally {
            // Process next
            processUploadQueue();
        }
    };

    // Global Metrics Calculation
    useEffect(() => {
        if (!uploadingRef.current || uploadQueue.length === 0) return;

        const totalSize = uploadQueue.reduce((acc, t) => acc + t.size, 0);
        const uploadedSize = uploadQueue.reduce((acc, t) => {
            if (t.status === 'completed') return acc + t.size;
            if (t.status === 'uploading') return acc + (t.size * (t.progress / 100));
            return acc;
        }, 0);

        if (startTimeRef.current > 0) {
            const now = Date.now();
            const elapsed = (now - startTimeRef.current) / 1000; // seconds
            if (elapsed > 1) { // Wait for stable sample
                const speed = uploadedSize / elapsed; // bytes per second
                const remaining = totalSize - uploadedSize;
                const eta = speed > 0 ? remaining / speed : 0;

                setUploadMetrics({
                    speed: `${formatBytes(speed)}/s`,
                    eta: formatTime(eta)
                });
            }
        }
    }, [uploadQueue]); // Updates on every progress tick

    // Monitor for completion
    useEffect(() => {
        if (uploadQueue.length === 0) return;

        const allComplete = uploadQueue.every(t => t.status === 'completed' || t.status === 'error');
        const anyError = uploadQueue.some(t => t.status === 'error');
        const completedCount = uploadQueue.filter(t => t.status === 'completed').length;

        // Only trigger if we were recently uploading (simple check: queue exists and all done)
        // We need to ensure we don't spam toasts. 
        // We can check if isUploadPanelOpen is true to imply user is watching.

        if (allComplete && isUploadPanelOpen) {
            if (anyError) {
                setToast({ msg: `Upload finished with ${completedCount} successes and some errors.`, type: 'error', show: true });
            } else {
                setToast({ msg: `Successfully uploaded ${completedCount} files.`, type: 'success', show: true });
                // Optional: Close panel after delay?
                setTimeout(() => setIsUploadPanelOpen(false), 2000);
            }
            // Reset uploading ref just in case
            uploadingRef.current = false;
        }
    }, [uploadQueue, isUploadPanelOpen]);

    const onDrop = useCallback(async (acceptedFiles: File[]) => {
        try {
            const { data: { session } } = await supabase.auth.getSession();
            if (!session) return;

            setIsUploadPanelOpen(true);
            setUploading(true);

            // Reset metrics start only if new session
            if (!uploadingRef.current) {
                startTimeRef.current = Date.now();
                startBytesRef.current = 0;
            }

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

            const newTasks: any[] = [];

            // 1. Prepare Standalone
            for (const file of standaloneFiles) {
                const fileExt = file.name.split('.').pop();
                const fileName = `${session.user.id}/${Math.random().toString(36).substring(2)}.${fileExt}`;

                newTasks.push({
                    id: Math.random().toString(36),
                    file,
                    progress: 0,
                    status: 'pending',
                    targetName: file.name,
                    size: file.size,
                    storagePath: fileName,
                    dbParentId: currentFolderId,
                    forceType: null
                });
            }

            // 2. Prepare Folders (create DB folders immediately)
            if (currentFolderId) {
                // Flatten
                for (const groupName in folderGroups) {
                    for (const file of folderGroups[groupName]) {
                        const fileExt = file.name.split('.').pop();
                        const fileName = `${session.user.id}/${Math.random().toString(36).substring(2)}.${fileExt}`;

                        // Calculate duration for video
                        let duration = 0;
                        if (file.type.startsWith('video/')) {
                            try {
                                const videoEl = document.createElement('video');
                                videoEl.preload = 'metadata';
                                videoEl.src = URL.createObjectURL(file);
                                await new Promise((resolve) => {
                                    videoEl.onloadedmetadata = () => {
                                        duration = videoEl.duration;
                                        URL.revokeObjectURL(videoEl.src);
                                        resolve(null);
                                    };
                                    videoEl.onerror = () => {
                                        URL.revokeObjectURL(videoEl.src);
                                        resolve(null);
                                    }
                                });
                            } catch (e) {
                                console.error("Error getting duration", e);
                            }
                        }

                        newTasks.push({
                            id: Math.random().toString(36),
                            file,
                            progress: 0,
                            status: 'pending',
                            targetName: file.name,
                            size: file.size,
                            storagePath: fileName,
                            dbParentId: currentFolderId,
                            forceType: null,
                            duration // Pass duration to task to be inserted
                        });
                    }
                }
            } else {
                for (const [folderName, groupFiles] of Object.entries(folderGroups)) {
                    // Create folder
                    const { data: folderData, error } = await supabase.from('content_items').insert({
                        user_id: session.user.id,
                        name: folderName,
                        type: 'carousel_folder',
                        parent_id: null
                    }).select().single();

                    if (folderData) {
                        for (const file of groupFiles) {
                            const fileExt = file.name.split('.').pop();
                            const fileName = `${session.user.id}/${Math.random().toString(36).substring(2)}.${fileExt}`;

                            let duration = 0;
                            if (file.type.startsWith('video/')) {
                                try {
                                    const videoEl = document.createElement('video');
                                    videoEl.preload = 'metadata';
                                    videoEl.src = URL.createObjectURL(file);
                                    await new Promise((resolve) => {
                                        videoEl.onloadedmetadata = () => {
                                            duration = videoEl.duration;
                                            URL.revokeObjectURL(videoEl.src);
                                            resolve(null);
                                        };
                                        videoEl.onerror = () => {
                                            URL.revokeObjectURL(videoEl.src);
                                            resolve(null);
                                        }
                                    });
                                } catch (e) {
                                    console.error("Error getting duration", e);
                                }
                            }

                            newTasks.push({
                                id: Math.random().toString(36),
                                file,
                                progress: 0,
                                status: 'pending',
                                targetName: `${folderName}/${file.name}`,
                                size: file.size,
                                storagePath: fileName,
                                dbParentId: folderData.id,
                                forceType: 'carousel_item',
                                duration
                            });
                        }
                    }
                }
            }

            setUploadQueue(prev => [...prev, ...newTasks]);

            // Kick off queue (timeout to allow state update)
            setTimeout(processUploadQueue, 100);

        } catch (error) {
            console.error(error);
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

        return matchesText && matchesIncludedTags && !matchesExcludedTags && matchesType && matchesSize && matchesDuration;
    });

    const handleSelectAll = () => {
        const allFilteredIds = filteredItems.map(i => i.id);
        const allSelected = allFilteredIds.every(id => selectedIds.includes(id));

        if (allSelected) {
            // Deselect only the visible ones
            setSelectedIds(selectedIds.filter(id => !allFilteredIds.includes(id)));
        } else {
            // Select all visible ones
            const newSet = new Set([...selectedIds, ...allFilteredIds]);
            setSelectedIds(Array.from(newSet));
        }
    };

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

                    {/* Selection Actions & Select All */}
                    <div className="flex items-center gap-2">
                        {/* Select All / Deselect All - Visible always or only when items exist? */}
                        {/* Select All / Deselect All Toggle */}
                        {filteredItems.length > 0 && (
                            <div className="flex items-center gap-1 mr-2">
                                <button
                                    onClick={handleSelectAll}
                                    className={`text-xs font-semibold px-3 py-1.5 rounded-lg border transition-all ${filteredItems.every(i => selectedIds.includes(i.id))
                                        ? 'bg-ios-blue text-white border-ios-blue'
                                        : 'bg-ios-card border-ios-separator text-ios-blue hover:bg-ios-blue/5'
                                        }`}
                                >
                                    {filteredItems.every(i => selectedIds.includes(i.id)) ? 'Deselect All' : 'Select All'}
                                </button>
                            </div>
                        )}

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

                        {/* Edit Action for Selection */}
                        {selectedIds.length > 0 && mode === 'manage' && (
                            <IOSButton
                                variant="secondary"
                                onClick={() => openEditModal(items.filter(i => selectedIds.includes(i.id)))}
                                className="!py-1.5 !px-3 text-sm flex items-center gap-1 mr-2"
                            >
                                <Edit2 size={14} /> Edit
                            </IOSButton>
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

                    {/* Select All shortcut in Search Row */}
                    {filteredItems.length > 0 && (
                        <button
                            onClick={handleSelectAll}
                            className={`flex items-center gap-1.5 px-3 py-2 rounded-xl border text-sm font-medium transition-all ${filteredItems.every(i => selectedIds.includes(i.id))
                                    ? 'bg-ios-blue text-white border-ios-blue shadow-sm'
                                    : 'bg-ios-card border-ios-separator text-ios-secondary hover:text-ios-blue hover:border-ios-blue/30'
                                }`}
                            title={filteredItems.every(i => selectedIds.includes(i.id)) ? 'Deselect All' : 'Select All'}
                        >
                            {filteredItems.every(i => selectedIds.includes(i.id)) ? <Check size={16} /> : <div className="w-4 h-4 border-2 border-current rounded-sm" />}
                            <span className="hidden sm:inline">Select All</span>
                        </button>
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
                            <Grid size={16} />
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
                    viewMode === 'list' ? (
                        <div className="bg-ios-card border border-ios-separator rounded-xl overflow-hidden shadow-sm">
                            <table className="min-w-full divide-y divide-ios-separator">
                                <thead className="bg-ios-background">
                                    <tr>
                                        <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-ios-secondary uppercase tracking-wider">Name</th>
                                        <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-ios-secondary uppercase tracking-wider">Type</th>
                                        <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-ios-secondary uppercase tracking-wider">Size</th>
                                        <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-ios-secondary uppercase tracking-wider">Duration</th>
                                        <th scope="col" className="px-6 py-3 text-right text-xs font-medium text-ios-secondary uppercase tracking-wider">Actions</th>
                                    </tr>
                                </thead>
                                <tbody className="bg-ios-card divide-y divide-ios-separator">
                                    {filteredItems.map((item) => (
                                        <tr
                                            key={item.id}
                                            onClick={() => {
                                                if (item.type === 'carousel_folder') {
                                                    router.push(`/content?folderId=${item.id}`);
                                                } else {
                                                    toggleSelection(item.id);
                                                }
                                            }}
                                            className={`
                                        cursor-pointer transition-colors hover:bg-ios-background/50
                                        ${selectedIds.includes(item.id) ? 'bg-blue-50 dark:bg-blue-900/10' : ''}
                                    `}
                                        >
                                            <td className="px-6 py-4 whitespace-nowrap">
                                                <div className="flex items-center">
                                                    <div className="flex-shrink-0 h-10 w-10 rounded-lg overflow-hidden bg-gray-100 dark:bg-gray-800 flex items-center justify-center border border-ios-separator">
                                                        {item.type === 'carousel_folder' ? (
                                                            <Folder size={20} className="text-blue-400" />
                                                        ) : item.type === 'video' ? (
                                                            <div className="relative w-full h-full">
                                                                <video src={item.url} className="w-full h-full object-cover" />
                                                                <div className="absolute inset-0 flex items-center justify-center bg-black/20">
                                                                    <Video size={14} className="text-white" />
                                                                </div>
                                                            </div>
                                                        ) : (
                                                            <img className="h-10 w-10 object-cover" src={item.url} alt="" />
                                                        )}
                                                    </div>
                                                    <div className="ml-4">
                                                        <div className="text-sm font-medium text-ios-text">{item.name}</div>
                                                    </div>
                                                </div>
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap">
                                                <span className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full 
                                            ${item.type === 'video' ? 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300' :
                                                        item.type === 'carousel_folder' ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300' :
                                                            'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'}`}>
                                                    {item.type === 'carousel_folder' ? 'Folder' : item.type === 'video' ? 'Video' : 'Image'}
                                                </span>
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap text-sm text-ios-secondary">
                                                {formatBytes(item.size || 0)}
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap text-sm text-ios-secondary">
                                                {item.duration ? formatTime(item.duration) : '-'}
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                                                {mode === 'manage' && (
                                                    <div className="flex justify-end gap-2">
                                                        <button onClick={(e) => { e.stopPropagation(); openEditModal([item]); }} className="text-ios-secondary hover:text-ios-blue">
                                                            <Edit2 size={16} />
                                                        </button>
                                                        <button onClick={(e) => { e.stopPropagation(); openMoveModal([item]); }} className="text-ios-secondary hover:text-ios-blue">
                                                            <Move size={16} />
                                                        </button>
                                                        <button onClick={(e) => deleteItem(e, item)} className="text-ios-secondary hover:text-red-500">
                                                            <Trash2 size={16} />
                                                        </button>
                                                    </div>
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
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
                                                {/* Size / Duration Badge */}
                                                <div className="flex items-center gap-2 mt-1 text-[10px] text-gray-200">
                                                    {item.size && <span>{formatBytes(item.size)}</span>}
                                                    {item.duration ? <span>• {formatTime(item.duration)}</span> : null}
                                                </div>
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
                                                onClick={(e) => { e.stopPropagation(); openEditModal([item]); }}
                                                className="p-1.5 bg-white/90 dark:bg-black/90 backdrop-blur text-ios-text rounded-full shadow-sm hover:text-blue-500 transition-colors"
                                                title="Edit"
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
                    )
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

            <EditContentModal
                isOpen={isEditModalOpen}
                onClose={() => setIsEditModalOpen(false)}
                itemsToEdit={itemsToEdit}
                onEditComplete={onEditComplete}
            />

            <UploadProgressPanel
                tasks={uploadQueue}
                isOpen={isUploadPanelOpen}
                onClose={() => setIsUploadPanelOpen(false)}
                metrics={uploadMetrics}
            />

            <IOSToast
                message={toast.msg}
                type={toast.type}
                isVisible={toast.show}
                onClose={() => setToast(prev => ({ ...prev, show: false }))}
            />
        </div >
    );
}
