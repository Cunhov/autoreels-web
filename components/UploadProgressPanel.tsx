import { X, CheckCircle, AlertCircle, Loader2, FileVideo, FileImage } from 'lucide-react';
import { useMemo } from 'react';

export interface UploadTask {
    id: string;
    file: File;
    progress: number; // 0-100
    status: 'pending' | 'uploading' | 'completed' | 'error';
    error?: string;
    targetName: string; // Display name
    size: number;
    storagePath?: string;
    dbParentId?: string | null;
    forceType?: string | null;
}

interface UploadProgressPanelProps {
    tasks: UploadTask[];
    isOpen: boolean;
    onClose: () => void; // Only allowed if all complete or to minimize?
    isMinimizable?: boolean;
    metrics?: { speed: string; eta: string };
}

export default function UploadProgressPanel({ tasks, isOpen, onClose, metrics }: UploadProgressPanelProps) {
    if (!isOpen && tasks.length === 0) return null;

    const totalSize = useMemo(() => tasks.reduce((acc, t) => acc + t.size, 0), [tasks]);
    const uploadedSize = useMemo(() => tasks.reduce((acc, t) => acc + (t.status === 'completed' ? t.size : t.size * (t.progress / 100)), 0), [tasks]);
    const overallProgress = totalSize > 0 ? (uploadedSize / totalSize) * 100 : 0;

    const completedCount = tasks.filter(t => t.status === 'completed').length;
    const isAllComplete = completedCount === tasks.length && tasks.length > 0;
    const hasErrors = tasks.some(t => t.status === 'error');

    return (
        <div className={`fixed bottom-6 right-6 w-96 bg-ios-card/80 backdrop-blur-xl border border-ios-separator rounded-2xl shadow-2xl transition-all duration-300 z-50 ${isOpen ? 'translate-y-0 opacity-100' : 'translate-y-20 opacity-0 pointer-events-none'}`}>
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b border-ios-separator">
                <div className="flex flex-col">
                    <h3 className="font-semibold text-ios-text text-sm">
                        {isAllComplete ? 'Uploads Completed' : `Uploading ${tasks.length - completedCount} items...`}
                    </h3>
                    <div className="flex items-center gap-2 text-xs text-ios-secondary">
                        <span>{completedCount} of {tasks.length} done</span>
                        {!isAllComplete && metrics && (
                            <>
                                <span>•</span>
                                <span>{metrics.speed}</span>
                                <span>•</span>
                                <span>{metrics.eta} left</span>
                            </>
                        )}
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={onClose}
                        className="p-1 hover:bg-black/5 rounded-full text-ios-secondary"
                    >
                        {isAllComplete ? <X size={18} /> : <span className="text-xs">Hide</span>}
                    </button>
                </div>
            </div>

            {/* Global Progress */}
            {!isAllComplete && (
                <div className="px-4 py-3 bg-ios-background/50">
                    <div className="flex justify-between text-xs mb-1.5 text-ios-secondary">
                        <span>Total Progress</span>
                        <span>{Math.round(overallProgress)}%</span>
                    </div>
                    <div className="h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                        <div
                            className="h-full bg-ios-blue transition-all duration-300 ease-out"
                            style={{ width: `${overallProgress}%` }}
                        />
                    </div>
                </div>
            )}

            {/* File List */}
            <div className="max-h-[300px] overflow-y-auto p-2 space-y-1 scroller">
                {tasks.map((task) => (
                    <div key={task.id} className="flex items-center gap-3 p-2 rounded-xl hover:bg-black/5 dark:hover:bg-white/5 transition-colors group">
                        <div className="flex-shrink-0">
                            {task.file.type.startsWith('video') ? (
                                <FileVideo size={20} className="text-blue-500" />
                            ) : (
                                <FileImage size={20} className="text-purple-500" />
                            )}
                        </div>

                        <div className="flex-1 min-w-0">
                            <div className="flex justify-between items-center mb-0.5">
                                <p className="text-xs font-medium text-ios-text truncate mr-2" title={task.targetName}>
                                    {task.targetName}
                                </p>
                                <span className="text-[10px] text-ios-secondary flex-shrink-0">
                                    {(task.size / (1024 * 1024)).toFixed(1)} MB
                                </span>
                            </div>

                            {/* Individual Progress Bar or Status */}
                            <div className="w-full">
                                {task.status === 'uploading' ? (
                                    <div className="h-1 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden w-full">
                                        <div
                                            className="h-full bg-ios-blue transition-all duration-300"
                                            style={{ width: `${task.progress}%` }}
                                        />
                                    </div>
                                ) : task.status === 'completed' ? (
                                    <p className="text-[10px] text-green-500 flex items-center gap-1">
                                        <CheckCircle size={10} /> Completed
                                    </p>
                                ) : task.status === 'error' ? (
                                    <p className="text-[10px] text-red-500 flex items-center gap-1 truncate" title={task.error}>
                                        <AlertCircle size={10} /> {task.error || 'Failed'}
                                    </p>
                                ) : (
                                    <p className="text-[10px] text-ios-secondary">Waiting...</p>
                                )}
                            </div>
                        </div>

                        {/* Status Icon (Right side) */}
                        <div className="flex-shrink-0 pl-1">
                            {task.status === 'uploading' && <Loader2 size={14} className="animate-spin text-ios-blue" />}
                            {task.status === 'completed' && <CheckCircle size={14} className="text-green-500" />}
                            {task.status === 'error' && <AlertCircle size={14} className="text-red-500" />}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
