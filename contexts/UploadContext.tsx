'use client';

import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';

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
    errorMessage?: string;
    chunkSize: number;
    totalChunks: number;
    currentChunk: number;
}

interface UploadContextType {
    tasks: UploadTask[];
    addFiles: (files: File[], folderPath?: string, tags?: string[]) => void;
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
const FREEZE_TIMEOUT_MS = 15000; // 15 seconds without progress = frozen

export function UploadProvider({ children }: { children: React.ReactNode }) {
    const [tasks, setTasks] = useState<UploadTask[]>([]);
    const [activeUploads, setActiveUploads] = useState<Set<string>>(new Set());

    // Track abort controllers for active tasks
    const abortControllers = useRef<Map<string, AbortController>>(new Map());

    // Track byte progress timestamps to detect freezes
    const lastProgressMs = useRef<Map<string, number>>(new Map());

    // Add new files to the queue
    const addFiles = useCallback((files: File[], folderPath: string = 'admin', tags: string[] = []) => {
        const newTasks: UploadTask[] = files.map(file => ({
            id: crypto.randomUUID(),
            file,
            name: file.name,
            size: file.size,
            progress: 0,
            status: 'pending',
            folderPath,
            tags,
            chunkSize: CHUNK_SIZE,
            totalChunks: Math.ceil(file.size / CHUNK_SIZE),
            currentChunk: 0
        }));

        setTasks(prev => [...prev, ...newTasks]);
    }, []);

    const cancelTask = useCallback((taskId: string) => {
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
    }, []);

    const retryTask = useCallback((taskId: string) => {
        setTasks(prev => {
            // Re-order the queue: move the retried task to the back of the pending line 
            // by removing it here and re-inserting it at the end with status = pending
            const taskToRetry = prev.find(t => t.id === taskId);
            if (!taskToRetry) return prev;

            const others = prev.filter(t => t.id !== taskId);
            return [...others, { ...taskToRetry, status: 'pending', progress: 0, currentChunk: 0, errorMessage: undefined }];
        });
    }, []);

    const clearCompleted = useCallback(() => {
        setTasks(prev => prev.filter(t => t.status !== 'completed' && t.status !== 'canceled'));
    }, []);

    // Main Orchestrator Effect
    useEffect(() => {
        // Find tasks that need to start uploading
        const pendingTasks = tasks.filter(t => t.status === 'pending');

        // If we have capacity, start new uploads
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
            let changed = false;

            setTasks(prev => {
                let nextTasks = [...prev];
                activeUploads.forEach(taskId => {
                    const lastMs = lastProgressMs.current.get(taskId);
                    const task = nextTasks.find(t => t.id === taskId);

                    if (task && task.status === 'uploading' && lastMs && (now - lastMs > FREEZE_TIMEOUT_MS)) {
                        console.warn(`Upload ID ${taskId} frozen! Aborting and moving to back of queue.`);

                        // Abort the network request
                        if (abortControllers.current.has(taskId)) {
                            abortControllers.current.get(taskId)?.abort();
                            abortControllers.current.delete(taskId);
                        }

                        changed = true;

                        // Set status to frozen and push to end of array to retry later
                        nextTasks = nextTasks.filter(t => t.id !== taskId);
                        nextTasks.push({
                            ...task,
                            status: 'frozen',
                            errorMessage: 'Connection froze. Will retry.'
                        });

                        setActiveUploads(prevActive => {
                            const n = new Set(prevActive);
                            n.delete(taskId);
                            return n;
                        });
                    }
                });
                return changed ? nextTasks : prev;
            });
        }, 5000); // Check every 5 seconds

        return () => clearInterval(interval);
    }, [activeUploads]);

    // Upload Execution logic
    const startUpload = async (task: UploadTask) => {
        setActiveUploads(prev => new Set(prev).add(task.id));
        setTasks(prev => prev.map(t => t.id === task.id ? { ...t, status: 'uploading' } : t));
        lastProgressMs.current.set(task.id, Date.now());

        const controller = new AbortController();
        abortControllers.current.set(task.id, controller);

        try {
            // Standard directory path logic (e.g., test-tenant/admin/file.mp4)
            const targetPath = `${task.folderPath ? task.folderPath + '/' : ''}${task.name}`;

            let currentChunk = task.currentChunk;

            while (currentChunk < task.totalChunks) {
                // If the task was canceled asynchronously, break the loop
                if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');

                const start = currentChunk * CHUNK_SIZE;
                const end = Math.min(start + CHUNK_SIZE, task.size);
                const chunkBlob = task.file.slice(start, end);

                try {
                    lastProgressMs.current.set(task.id, Date.now()); // Mark activity before fetch

                    const response = await fetch('/api/upload-chunk', {
                        method: 'POST',
                        headers: {
                            'x-chunk-index': currentChunk.toString(),
                            'x-total-chunks': task.totalChunks.toString(),
                            'x-file-name': targetPath, // Provide destination path so API stores it properly
                            'Content-Type': 'application/octet-stream',
                        },
                        body: chunkBlob,
                        signal: controller.signal
                    });

                    if (!response.ok) {
                        throw new Error(`Server returned ${response.status}`);
                    }

                    lastProgressMs.current.set(task.id, Date.now()); // Mark activity after successful chunk

                    currentChunk++;
                    const progress = Math.round((currentChunk / task.totalChunks) * 100);

                    // If aborted during fetch
                    if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');

                    setTasks(prev => prev.map(t =>
                        t.id === task.id ? { ...t, currentChunk, progress } : t
                    ));

                } catch (chunkError: any) {
                    if (chunkError.name === 'AbortError') {
                        throw chunkError; // propagate upward
                    }
                    console.error(`Chunk ${currentChunk} failed:`, chunkError);
                    throw new Error(`Chunk ${currentChunk} upload failed. ${chunkError.message || ''}`);
                }
            }

            // Sync Database record upon final chunk completion
            const formData = new FormData();
            formData.append('filename', task.name);
            formData.append('size', task.size.toString());
            formData.append('path', targetPath);
            formData.append('folderPath', task.folderPath);
            formData.append('type', task.name.toLowerCase().endsWith('.mp4') || task.name.toLowerCase().endsWith('.mov') ? 'video' : 'image');
            if (task.tags.length > 0) {
                formData.append('tags', JSON.stringify(task.tags));
            }

            // Send metadata to complete the upload
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

        } catch (error: any) {
            if (error.name === 'AbortError') {
                // Canceled or Frozen status is already handled in state
                return;
            }

            // Real network error or unforced crash => put to Frozen so it retries automatically at the back
            // or mark as error if we want manual intervention. Let's auto-retry robustly by pushing to Frozen.
            setTasks(prev => {
                const others = prev.filter(t => t.id !== task.id);
                const failedTask = prev.find(t => t.id === task.id);
                if (!failedTask) return prev;

                return [...others, {
                    ...failedTask,
                    status: 'frozen',
                    errorMessage: error.message
                }];
            });
        } finally {
            abortControllers.current.delete(task.id);
            lastProgressMs.current.delete(task.id);
            setActiveUploads(prev => {
                const next = new Set(prev);
                next.delete(task.id);
                return next;
            });
        }
    };

    return (
        <UploadContext.Provider value={{ tasks, addFiles, cancelTask, retryTask, clearCompleted }}>
            {children}
        </UploadContext.Provider>
    );
}
