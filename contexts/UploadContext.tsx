'use client';

import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { useSession } from 'next-auth/react';
import { createVideoThumbnailFile } from '@/lib/video-thumbnail';

export type UploadStatus = 'pending' | 'uploading' | 'frozen' | 'error' | 'completed' | 'canceled';

export interface UploadTask {
    id: string;
    file: File;
    name: string;
    size: number;
    progress: number;
    status: UploadStatus;
    folderPath: string;
    tags: string[];
    parentId?: string | null;   // DB parent_id for carousel_item
    forceType?: string | null;  // e.g. 'carousel_item'
    caption?: string | null;    // caption from .txt file
    errorMessage?: string;
    chunkSize: number;
    totalChunks: number;
    currentChunk: number;
    retryCount: number;
}

interface UploadContextType {
    tasks: UploadTask[];
    addFiles: (files: File[], folderId?: string | null, tags?: string[]) => void;
    addFolderFiles: (files: File[], parentFolderId?: string | null, tags?: string[]) => Promise<void>;
    cancelTask: (taskId: string) => void;
    retryTask: (taskId: string) => void;
    clearCompleted: () => void;
}

const UploadContext = createContext<UploadContextType | undefined>(undefined);

export function useUpload() {
    const context = useContext(UploadContext);
    if (!context) {
        throw new Error('useUpload must be used within an UploadProvider');
    }
    return context;
}

const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB chunks
const MAX_CONCURRENT = 2; // Maximum number of concurrent uploads
const FREEZE_TIMEOUT_MS = 30000; // 30s without progress = frozen (chunks of 5MB can take a while on slow links)
const RETRY_DELAY_MS = 5000; // delay before re-enqueuing a frozen upload
const MAX_AUTO_RETRIES = 2; // auto-retries before marking the task as failed

export function UploadProvider({ children }: { children: React.ReactNode }) {
    const { data: session } = useSession();
    const [tasks, setTasks] = useState<UploadTask[]>([]);
    const [activeUploads, setActiveUploads] = useState<Set<string>>(new Set());

    // Track abort controllers for active tasks
    const abortControllers = useRef<Map<string, AbortController>>(new Map());

    // Track byte progress timestamps to detect freezes
    const lastProgressMs = useRef<Map<string, number>>(new Map());

    // Track the last observed byte progress so slow-but-alive uploads are not frozen
    const lastProgressBytes = useRef<Map<string, number>>(new Map());

    // Timers for automatic retry of frozen uploads
    const retryTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

    // Enqueue a frozen task again after RETRY_DELAY_MS (only if it is still frozen)
    const scheduleRetry = useCallback((taskId: string) => {
        if (retryTimers.current.has(taskId)) return;

        const timer = setTimeout(() => {
            retryTimers.current.delete(taskId);
            setTasks(prev => prev.map(t => {
                if (t.id !== taskId || t.status !== 'frozen') return t;
                // Restart from chunk 0: the server temp file may hold a partial chunk.
                return { ...t, status: 'pending' as UploadStatus, progress: 0, currentChunk: 0 };
            }));
        }, RETRY_DELAY_MS);

        retryTimers.current.set(taskId, timer);
    }, []);

    // Clear any pending retry timer for a task
    const clearRetryTimer = useCallback((taskId: string) => {
        const timer = retryTimers.current.get(taskId);
        if (timer) {
            clearTimeout(timer);
            retryTimers.current.delete(taskId);
        }
    }, []);

    // Add new files to the queue (individual / loose files)
    const addFiles = useCallback((files: File[], folderId: string | null = null, tags: string[] = []) => {
        const newTasks: UploadTask[] = files.map(file => ({
            id: crypto.randomUUID(),
            file,
            name: file.name,
            size: file.size,
            progress: 0,
            status: 'pending',
            folderPath: folderId ? `folder_${folderId}` : 'admin',
            tags,
            parentId: folderId,
            forceType: null,
            caption: null,
            chunkSize: CHUNK_SIZE,
            totalChunks: Math.ceil(file.size / CHUNK_SIZE),
            currentChunk: 0,
            retryCount: 0
        }));

        setTasks(prev => [...prev, ...newTasks]);
    }, []);

    // Add files from a folder upload with carousel detection
    const addFolderFiles = useCallback(async (files: File[], parentFolderId: string | null = null, tags: string[] = []) => {
        const newTasks: UploadTask[] = [];

        // Group files by their folder using webkitRelativePath
        const folderGroups = new Map<string, File[]>();
        const looseFiles: File[] = [];

        for (const file of files) {
            const relPath = (file as any).webkitRelativePath as string;
            if (relPath && relPath.includes('/')) {
                // Extract the first-level folder name
                const parts = relPath.split('/');
                // parts[0] is the root folder selected by the user
                // parts[1] is either a subfolder or the filename
                if (parts.length >= 3) {
                    // File is inside a subfolder: rootFolder/subFolder/file.mp4
                    const subFolder = parts[1];
                    if (!folderGroups.has(subFolder)) {
                        folderGroups.set(subFolder, []);
                    }
                    folderGroups.get(subFolder)!.push(file);
                } else {
                    // File is directly in the root folder: rootFolder/file.mp4
                    looseFiles.push(file);
                }
            } else {
                // No relative path — treat as loose file
                looseFiles.push(file);
            }
        }

        // If all files are in the root with no subfolders, treat the root folder itself as a group
        if (folderGroups.size === 0 && looseFiles.length > 0) {
            const firstRelPath = (files[0] as any).webkitRelativePath as string;
            if (firstRelPath) {
                const rootName = firstRelPath.split('/')[0];
                folderGroups.set(rootName, looseFiles);
                looseFiles.length = 0; // clear
            }
        }

        // Process folder groups — carousel detection
        for (const [folderName, groupFiles] of folderGroups) {
            // Read .txt caption if present
            let folderCaption = '';
            const txtFile = groupFiles.find(f => f.name.toLowerCase().endsWith('.txt'));
            if (txtFile) {
                try {
                    folderCaption = await txtFile.text();
                } catch (e) {
                    console.error('Error reading .txt file:', e);
                }
            }

            // Filter out .txt files from media
            const mediaFiles = groupFiles.filter(f => !f.name.toLowerCase().endsWith('.txt'));
            if (mediaFiles.length === 0) continue;

            if (mediaFiles.length === 1) {
                // Single file in folder → standalone post with caption
                const file = mediaFiles[0];
                newTasks.push({
                    id: crypto.randomUUID(),
                    file,
                    name: file.name,
                    size: file.size,
                    progress: 0,
                    status: 'pending',
                    folderPath: parentFolderId ? `folder_${parentFolderId}` : 'admin',
                    tags,
                    parentId: parentFolderId,
                    forceType: null,
                    caption: folderCaption || null,
                    chunkSize: CHUNK_SIZE,
                    totalChunks: Math.ceil(file.size / CHUNK_SIZE),
                    currentChunk: 0,
                    retryCount: 0
                });
            } else {
                // 2+ files → create carousel_folder in DB, then queue children
                try {
                    const res = await fetch('/api/content-items', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            name: folderName,
                            type: 'carousel_folder',
                            parent_id: parentFolderId,
                            caption: folderCaption || null,
                            ...(tags.length > 0 ? { tags: JSON.stringify(tags) } : {})
                        })
                    });

                    if (!res.ok) throw new Error('Failed to create carousel folder');
                    const folderData = await res.json();

                    // Sort media files by name for consistent ordering
                    const sortedMedia = [...mediaFiles].sort((a, b) =>
                        a.name.localeCompare(b.name, undefined, { numeric: true })
                    );

                    for (const file of sortedMedia) {
                        newTasks.push({
                            id: crypto.randomUUID(),
                            file,
                            name: file.name,
                            size: file.size,
                            progress: 0,
                            status: 'pending',
                            folderPath: `carousel_${folderData.id}`,
                            tags,
                            parentId: folderData.id,
                            forceType: 'carousel_item',
                            caption: null,
                            chunkSize: CHUNK_SIZE,
                            totalChunks: Math.ceil(file.size / CHUNK_SIZE),
                            currentChunk: 0,
                            retryCount: 0
                        });
                    }
                } catch (error) {
                    console.error('Error creating carousel folder:', error);
                }
            }
        }

        // Loose files — individual uploads
        for (const file of looseFiles) {
            if (file.name.toLowerCase().endsWith('.txt')) continue; // skip .txt
            newTasks.push({
                id: crypto.randomUUID(),
                file,
                name: file.name,
                size: file.size,
                progress: 0,
                status: 'pending',
                folderPath: parentFolderId ? `folder_${parentFolderId}` : 'admin',
                tags,
                parentId: parentFolderId,
                forceType: null,
                caption: null,
                chunkSize: CHUNK_SIZE,
                totalChunks: Math.ceil(file.size / CHUNK_SIZE),
                currentChunk: 0,
                retryCount: 0
            });
        }

        if (newTasks.length > 0) {
            setTasks(prev => [...prev, ...newTasks]);
        }
    }, []);

    const cancelTask = useCallback((taskId: string) => {
        // Cancel any pending retry timer
        clearRetryTimer(taskId);

        // Abort network request if active
        if (abortControllers.current.has(taskId)) {
            abortControllers.current.get(taskId)?.abort();
            abortControllers.current.delete(taskId);
        }

        setTasks(prev => prev.map(t =>
            t.id === taskId ? { ...t, status: 'canceled' } : t
        ));

        setActiveUploads(prev => {
            const next = new Set(prev);
            next.delete(taskId);
            return next;
        });
    }, [clearRetryTimer]);

    const retryTask = useCallback((taskId: string) => {
        clearRetryTimer(taskId);
        setTasks(prev => {
            const taskToRetry = prev.find(t => t.id === taskId);
            if (!taskToRetry) return prev;

            const others = prev.filter(t => t.id !== taskId);
            return [...others, { ...taskToRetry, status: 'pending' as UploadStatus, progress: 0, currentChunk: 0, errorMessage: undefined }];
        });
    }, [clearRetryTimer]);

    const clearCompleted = useCallback(() => {
        setTasks(prev => prev.filter(t => t.status !== 'completed' && t.status !== 'canceled'));
    }, []);

    // Main Orchestrator Effect
    useEffect(() => {
        const pendingTasks = tasks.filter(t => t.status === 'pending');

        if (activeUploads.size < MAX_CONCURRENT && pendingTasks.length > 0) {
            const tasksToStart = pendingTasks.slice(0, MAX_CONCURRENT - activeUploads.size);

            tasksToStart.forEach(task => {
                startUpload(task);
            });
        }
    }, [tasks, activeUploads]);

    // Freeze Detection Monitor Loop
    useEffect(() => {
        const interval = setInterval(() => {
            const now = Date.now();
            const frozen: { taskId: string; task: UploadTask }[] = [];

            activeUploads.forEach(taskId => {
                const task = tasks.find(t => t.id === taskId);
                if (!task || task.status !== 'uploading') return;

                const lastMs = lastProgressMs.current.get(taskId) ?? 0;
                const lastBytes = lastProgressBytes.current.get(taskId) ?? 0;
                const progressBytes = Math.round((task.currentChunk / task.totalChunks) * task.size);

                // Byte progress increased since the last tick → upload is alive, just slow.
                const madeProgress = progressBytes > lastBytes;
                if (madeProgress) {
                    lastProgressBytes.current.set(taskId, progressBytes);
                    lastProgressMs.current.set(taskId, now);
                    return;
                }

                if (now - lastMs > FREEZE_TIMEOUT_MS) {
                    frozen.push({ taskId, task });
                }
            });

            if (frozen.length === 0) return;

            // Apply freeze transitions (pure state update — no side effects inside updater)
            setTasks(prev => {
                let next = prev;
                for (const { taskId, task } of frozen) {
                    const nextRetryCount = task.retryCount + 1;
                    const isFailed = nextRetryCount > MAX_AUTO_RETRIES;
                    next = next.map(t => t.id === taskId
                        ? {
                            ...t,
                            status: isFailed ? 'error' as UploadStatus : 'frozen' as UploadStatus,
                            errorMessage: isFailed
                                ? 'Upload failed after multiple retries.'
                                : 'Connection stalled. Retrying…'
                        }
                        : t);
                }
                return next;
            });

            // Side effects (abort + schedule retry) happen OUTSIDE the state updater
            for (const { taskId, task } of frozen) {
                console.warn(`Upload ID ${taskId} frozen! Aborting and scheduling retry.`);
                if (abortControllers.current.has(taskId)) {
                    abortControllers.current.get(taskId)?.abort();
                    abortControllers.current.delete(taskId);
                }
                lastProgressBytes.current.delete(taskId);

                setActiveUploads(prevActive => {
                    const n = new Set(prevActive);
                    n.delete(taskId);
                    return n;
                });

                // Auto-retry (if retries remain) — re-enqueue as pending after a delay
                if (task.retryCount + 1 <= MAX_AUTO_RETRIES) {
                    scheduleRetry(taskId);
                }
            }
        }, 5000);

        return () => clearInterval(interval);
    }, [tasks, activeUploads, scheduleRetry]);

    // Cleanup all pending retry timers on unmount
    useEffect(() => {
        const timers = retryTimers.current;
        return () => {
            timers.forEach(timer => clearTimeout(timer));
            timers.clear();
        };
    }, []);

    // Upload Execution logic
    const startUpload = async (task: UploadTask) => {
        setActiveUploads(prev => new Set(prev).add(task.id));
        setTasks(prev => prev.map(t => t.id === task.id ? { ...t, status: 'uploading' } : t));
        lastProgressMs.current.set(task.id, Date.now());
        lastProgressBytes.current.set(task.id, Math.round((task.currentChunk / task.totalChunks) * task.size));

        const controller = new AbortController();
        abortControllers.current.set(task.id, controller);

        try {
            const targetPath = `${task.folderPath ? task.folderPath + '/' : ''}${task.name}`;
            const userId = (session?.user as any)?.id as string | undefined;

            let currentChunk = task.currentChunk;

            while (currentChunk < task.totalChunks) {
                if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');

                const start = currentChunk * CHUNK_SIZE;
                const end = Math.min(start + CHUNK_SIZE, task.size);
                const chunkBlob = task.file.slice(start, end);

                try {
                    lastProgressMs.current.set(task.id, Date.now());

                    const response = await fetch('/api/upload-chunk', {
                        method: 'POST',
                        headers: {
                            'x-chunk-index': currentChunk.toString(),
                            'x-total-chunks': task.totalChunks.toString(),
                            'x-file-name': targetPath,
                            'Content-Type': 'application/octet-stream',
                        },
                        body: chunkBlob,
                        signal: controller.signal
                    });

                    if (!response.ok) {
                        throw new Error(`Server returned ${response.status}`);
                    }

                    lastProgressMs.current.set(task.id, Date.now());

                    currentChunk++;
                    const progress = Math.round((currentChunk / task.totalChunks) * 100);
                    lastProgressBytes.current.set(task.id, Math.round((currentChunk / task.totalChunks) * task.size));

                    if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');

                    setTasks(prev => prev.map(t =>
                        t.id === task.id ? { ...t, currentChunk, progress } : t
                    ));

                } catch (chunkError: any) {
                    if (chunkError.name === 'AbortError') {
                        throw chunkError;
                    }
                    console.error(`Chunk ${currentChunk} failed:`, chunkError);
                    throw new Error(`Chunk ${currentChunk} upload failed. ${chunkError.message || ''}`);
                }
            }

            let thumbnailPath: string | null = null;
            if (userId && task.file.type.startsWith('video/')) {
                const thumbnailFile = await createVideoThumbnailFile(task.file);
                if (thumbnailFile) {
                    thumbnailPath = `${userId}/${task.folderPath ? task.folderPath + '/' : ''}thumbnails/${thumbnailFile.name}`;
                    const thumbForm = new FormData();
                    thumbForm.append('file', thumbnailFile);
                    thumbForm.append('path', thumbnailPath);

                    const thumbRes = await fetch('/api/upload', {
                        method: 'POST',
                        body: thumbForm,
                        signal: controller.signal,
                    });

                    if (!thumbRes.ok) {
                        console.warn('Thumbnail upload failed; continuing without thumbnail.');
                        thumbnailPath = null;
                    }
                }
            }

            // Sync Database record upon final chunk completion
            const formData = new FormData();
            formData.append('filename', task.name);
            formData.append('size', task.size.toString());
            formData.append('path', targetPath);
            formData.append('folderPath', task.folderPath);

            // Type detection: use forceType if set, otherwise auto-detect
            const detectedType = task.forceType || (task.name.toLowerCase().match(/\.(mp4|mov|mkv|avi|webm)$/) ? 'video' : 'image');
            formData.append('type', detectedType);

            if (task.tags.length > 0) {
                formData.append('tags', JSON.stringify(task.tags));
            }
            if (task.parentId) {
                formData.append('parentId', task.parentId);
            }
            if (task.caption) {
                formData.append('caption', task.caption);
            }
            if (thumbnailPath) {
                formData.append('thumbnailPath', thumbnailPath);
            }

            const metaRes = await fetch('/api/upload-chunk/complete', {
                method: 'POST',
                body: formData,
                signal: controller.signal
            });

            if (!metaRes.ok) {
                throw new Error("Metadata save failed");
            }

            // Finish
            setTasks(prev => prev.map(t => t.id === task.id ? { ...t, status: 'completed', progress: 100 } : t));

        } catch (error: unknown) {
            const err = error as { name?: string; message?: string };
            if (err.name === 'AbortError') {
                return;
            }

            const nextRetryCount = task.retryCount + 1;
            const isFailed = nextRetryCount > MAX_AUTO_RETRIES;

            setTasks(prev => prev.map(t =>
                t.id === task.id
                    ? {
                        ...t,
                        status: isFailed ? 'error' as UploadStatus : 'frozen' as UploadStatus,
                        errorMessage: isFailed
                            ? `Upload failed: ${err.message || 'Unknown error'}`
                            : `Upload failed. Retrying… ${err.message || ''}`
                    }
                    : t
            ));

            // Auto-retry if retries remain
            if (!isFailed) {
                scheduleRetry(task.id);
            }
        } finally {
            abortControllers.current.delete(task.id);
            lastProgressMs.current.delete(task.id);
            lastProgressBytes.current.delete(task.id);
            setActiveUploads(prev => {
                const next = new Set(prev);
                next.delete(task.id);
                return next;
            });
        }
    };

    return (
        <UploadContext.Provider value={{ tasks, addFiles, addFolderFiles, cancelTask, retryTask, clearCompleted }}>
            {children}
        </UploadContext.Provider>
    );
}
