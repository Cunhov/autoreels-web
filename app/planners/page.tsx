'use client'
import { useState, useEffect } from 'react'
import { Sliders, Plus, Play, Pause, Trash2, Calendar, Instagram, Terminal, X, RefreshCw } from 'lucide-react'
import IOSButton from '@/components/IOSButton'
import IOSCard from '@/components/IOSComponents'
import PlannerWizard from '@/components/PlannerWizard'

interface Planner {
    id: string;
    name: string;
    config: any;
    status: string;
    channel_ids: string[];
    last_run?: string;
    created_at: string;
}

export default function PlannersPage() {
    const [planners, setPlanners] = useState<Planner[]>([]);
    const [loading, setLoading] = useState(true);
    const [isWizardOpen, setIsWizardOpen] = useState(false);
    const [editingPlanner, setEditingPlanner] = useState<Planner | null>(null);
    const [viewingLogs, setViewingLogs] = useState<Planner | null>(null);
    const [logs, setLogs] = useState<any[]>([]);
    const [loadingLogs, setLoadingLogs] = useState(false);

    useEffect(() => {
        fetchPlanners();
    }, []);

    async function fetchPlanners() {
        setLoading(true);
        try {
            const res = await fetch('/api/planners');
            const data = await res.json();
            setPlanners(Array.isArray(data) ? data : []);
        } finally {
            setLoading(false);
        }
    }

    async function toggleStatus(planner: Planner) {
        const newStatus = planner.status === 'active' ? 'inactive' : 'active';
        try {
            const res = await fetch(`/api/planners/${planner.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: newStatus }),
            });
            if (!res.ok) throw new Error('Failed to update status');
            fetchPlanners();
        } catch (error) {
            console.error(error);
            alert('Failed to update status');
        }
    }

    async function handleDelete(id: string) {
        if (!confirm('Are you sure you want to delete this planner?')) return;
        try {
            const res = await fetch(`/api/planners/${id}`, {
                method: 'DELETE',
            });
            if (!res.ok) throw new Error('Failed to delete planner');
            fetchPlanners();
        } catch (error) {
            console.error(error);
            alert('Failed to delete planner');
        }
    }

    const handleEdit = (planner: Planner) => {
        setEditingPlanner(planner);
        setIsWizardOpen(true);
    };

    const handleCloseWizard = () => {
        setIsWizardOpen(false);
        setEditingPlanner(null);
    };

    async function fetchLogs(plannerId: string) {
        setLoadingLogs(true);
        try {
            const res = await fetch(`/api/planners/logs/${plannerId}`);
            const data = await res.json();
            setLogs(Array.isArray(data) ? data : []);
        } finally {
            setLoadingLogs(false);
        }
    }

    useEffect(() => {
        if (viewingLogs) {
            fetchLogs(viewingLogs.id);
        }
    }, [viewingLogs]);

    return (
        <div className="flex flex-col h-full bg-ios-background">
            <header className="sticky top-0 z-10 p-6 pb-4 bg-ios-background/80 backdrop-blur-md flex items-center justify-between">
                <div>
                    <h1 className="text-[34px] font-bold text-ios-text">Planners</h1>
                    <p className="text-ios-secondary">Automate your posting schedule</p>
                </div>
                <IOSButton
                    variant="primary"
                    className="!py-2 !px-4 flex items-center gap-1"
                    onClick={() => {
                        setEditingPlanner(null);
                        setIsWizardOpen(true);
                    }}
                >
                    <Plus size={20} />
                    New Planner
                </IOSButton>
            </header>

            <main className="flex-1 overflow-y-auto px-6 pb-20">
                {loading ? (
                    <div className="flex justify-center p-12">
                        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-ios-blue"></div>
                    </div>
                ) : planners.length === 0 ? (
                    <div className="space-y-6">
                        <IOSCard className="p-12 text-center text-ios-secondary">
                            <Sliders size={48} className="mx-auto mb-4 opacity-50" strokeWidth={1} />
                            <h3 className="text-xl font-semibold mb-2 text-ios-text">No active planners</h3>
                            <p className="max-w-xs mx-auto mb-6">Create a planner to automatically generate and schedule reels based on your niche.</p>
                            <IOSButton variant="primary" className="mx-auto" onClick={() => setIsWizardOpen(true)}>
                                Create Your First Planner
                            </IOSButton>
                        </IOSCard>
                    </div>
                ) : (
                    <div className="space-y-4">
                        {planners.map(planner => (
                            <IOSCard key={planner.id} className="p-5 flex items-center justify-between group hover:border-ios-blue/30 transition-colors">
                                <div className="flex items-center gap-5">
                                    <div
                                        onClick={() => toggleStatus(planner)}
                                        className={`w-12 h-12 rounded-xl flex items-center justify-center transition-colors cursor-pointer hover:opacity-80 ${planner.status === 'active' ? 'bg-green-100 text-green-600' : 'bg-gray-100 text-gray-400'
                                            }`}>
                                        {planner.status === 'active' ? <Play size={24} fill="currentColor" /> : <Pause size={24} fill="currentColor" />}
                                    </div>
                                    <div>
                                        <h4 className="font-bold text-lg text-ios-text mb-1">{planner.name}</h4>
                                        <div className="flex items-center gap-3 text-xs text-ios-secondary">
                                            <span className={`px-2 py-0.5 rounded-full font-bold uppercase tracking-wider ${planner.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                                                }`}>
                                                {planner.status}
                                            </span>
                                            <span className="flex items-center gap-1">
                                                <Instagram size={12} />
                                                {(planner.channel_ids || []).length} Channels
                                            </span>
                                            <span className="flex items-center gap-1">
                                                <Calendar size={12} />
                                                Next: {(() => {
                                                    const config = planner.config;
                                                    if (!config || !config.frequency) return 'Soon';

                                                    const lastRunStr = planner.last_run;
                                                    const lastRun = lastRunStr ? new Date(lastRunStr) : new Date(planner.created_at);
                                                    const freq = config.frequency;
                                                    const nextDate = new Date(lastRun);

                                                    if (freq.unit === 'minutes') nextDate.setMinutes(nextDate.getMinutes() + freq.value);
                                                    else if (freq.unit === 'hours') nextDate.setHours(nextDate.getHours() + freq.value);
                                                    else if (freq.unit === 'days') nextDate.setDate(nextDate.getDate() + freq.value);
                                                    else if (freq.unit === 'weeks') nextDate.setDate(nextDate.getDate() + freq.value * 7);

                                                    return nextDate.toLocaleString('pt-BR', {
                                                        timeZone: 'America/Sao_Paulo',
                                                        day: '2-digit',
                                                        month: '2-digit',
                                                        hour: '2-digit',
                                                        minute: '2-digit'
                                                    });
                                                })()}
                                            </span>
                                        </div>
                                    </div>
                                </div>
                                <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                    <button
                                        onClick={() => setViewingLogs(planner)}
                                        className="p-2 text-ios-secondary hover:bg-ios-secondary/10 rounded-lg transition-colors"
                                        title="View Logs"
                                    >
                                        <Terminal size={20} />
                                    </button>
                                    <button
                                        onClick={() => handleEdit(planner)}
                                        className="p-2 text-ios-blue hover:bg-ios-blue/10 rounded-lg transition-colors">
                                        <Sliders size={20} />
                                    </button>
                                    <button
                                        onClick={() => handleDelete(planner.id)}
                                        className="p-2 text-ios-red hover:bg-ios-red/10 rounded-lg transition-colors">
                                        <Trash2 size={20} />
                                    </button>
                                </div>
                            </IOSCard>
                        ))}
                    </div>
                )}
            </main>

            <PlannerWizard
                isOpen={isWizardOpen}
                onClose={handleCloseWizard}
                onSuccess={fetchPlanners}
                initialData={editingPlanner}
            />

            {/* Logs Modal */}
            {viewingLogs && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm animate-in fade-in duration-200">
                    <div className="bg-ios-background w-full max-w-2xl max-h-[80vh] rounded-3xl shadow-2xl flex flex-col overflow-hidden animate-in zoom-in-95 duration-200">
                        <div className="p-6 border-b border-ios-separator flex items-center justify-between">
                            <div>
                                <h2 className="text-xl font-bold text-ios-text">Logs: {viewingLogs.name}</h2>
                                <p className="text-xs text-ios-secondary">Recently execution history</p>
                            </div>
                            <div className="flex items-center gap-2">
                                <button
                                    onClick={() => fetchLogs(viewingLogs.id)}
                                    className="p-2 text-ios-blue hover:bg-ios-blue/10 rounded-full transition-colors"
                                    disabled={loadingLogs}
                                >
                                    <RefreshCw size={20} className={loadingLogs ? 'animate-spin' : ''} />
                                </button>
                                <button
                                    onClick={() => setViewingLogs(null)}
                                    className="p-2 text-ios-secondary hover:bg-ios-secondary/10 rounded-full transition-colors"
                                >
                                    <X size={24} />
                                </button>
                            </div>
                        </div>
                        <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-[#f8f8f8]">
                            {logs.length === 0 ? (
                                <div className="text-center py-12 text-ios-secondary">
                                    <Terminal size={32} className="mx-auto mb-2 opacity-20" />
                                    <p>No logs found for this planner.</p>
                                </div>
                            ) : (
                                logs.map(log => (
                                    <div key={log.id} className="bg-white p-3 rounded-xl border border-ios-separator shadow-sm text-sm">
                                        <div className="flex items-center justify-between mb-1">
                                            <span className={`font-bold uppercase text-[10px] px-1.5 py-0.5 rounded ${log.level === 'error' ? 'bg-ios-red/10 text-ios-red' : 'bg-ios-blue/10 text-ios-blue'
                                                }`}>
                                                {log.level}
                                            </span>
                                            <span className="text-[10px] text-gray-500">
                                                {new Date(log.created_at).toLocaleString()}
                                            </span>
                                        </div>
                                        <p className="text-gray-900 font-medium">{log.message}</p>
                                        {log.details && (
                                            <pre className="mt-2 text-[10px] bg-gray-50 p-2 rounded border border-gray-100 overflow-x-auto text-gray-500 max-h-32">
                                                {JSON.stringify(log.details, null, 2)}
                                            </pre>
                                        )}
                                    </div>
                                ))
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
