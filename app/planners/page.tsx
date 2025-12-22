'use client'
import { useState, useEffect, useMemo } from 'react'
import { supabase } from '@/lib/supabase'
import { Sliders, Plus, Play, Pause, Trash2, Calendar, LayoutGrid, Instagram } from 'lucide-react'
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

    useEffect(() => {
        fetchPlanners();
    }, []);

    async function fetchPlanners() {
        setLoading(true);
        try {
            const { data } = await supabase
                .from('planners')
                .select('*')
                .order('created_at', { ascending: false });
            setPlanners(data || []);
        } finally {
            setLoading(false);
        }
    }

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
                    onClick={() => setIsWizardOpen(true)}
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
                                    <div className={`w-12 h-12 rounded-xl flex items-center justify-center transition-colors ${planner.status === 'active' ? 'bg-green-100 text-green-600' : 'bg-gray-100 text-gray-400'
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

                                                    // Use Sao Paulo timezone for display
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
                                    <button className="p-2 text-ios-blue hover:bg-ios-blue/10 rounded-lg transition-colors">
                                        <Sliders size={20} />
                                    </button>
                                    <button className="p-2 text-ios-red hover:bg-ios-red/10 rounded-lg transition-colors">
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
                onClose={() => setIsWizardOpen(false)}
                onSuccess={fetchPlanners}
            />
        </div>
    );
}
