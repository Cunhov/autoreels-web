'use client'
import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase'
import { Sliders, Plus, Play, Pause, Trash2, Clock, Calendar } from 'lucide-react'
import IOSButton from '@/components/IOSButton'
import IOSCard, { IOSGroup, IOSRow } from '@/components/IOSComponents'

interface Planner {
    id: string;
    name: string;
    config: any;
    is_active: boolean;
}

export default function PlannersPage() {
    const [planners, setPlanners] = useState<Planner[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        fetchPlanners();
    }, []);

    async function fetchPlanners() {
        try {
            const { data } = await supabase.from('planners').select('*');
            setPlanners(data || []);
        } finally {
            setLoading(false);
        }
    }

    return (
        <div className="p-6 bg-ios-background min-h-full pb-20">
            <header className="flex items-center justify-between mb-8">
                <div>
                    <h1 className="text-[34px] font-bold text-ios-text">Planners</h1>
                    <p className="text-ios-secondary">Automate your posting schedule</p>
                </div>
                <IOSButton variant="primary" className="!py-2 !px-4 flex items-center gap-1">
                    <Plus size={20} />
                    New Planner
                </IOSButton>
            </header>

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
                        <IOSButton variant="primary" className="mx-auto" onClick={() => alert('Planner creation coming soon!')}>
                            Create Your First Planner
                        </IOSButton>
                    </IOSCard>

                    <h3 className="text-lg font-bold px-2">Templates</h3>
                    <IOSCard className="p-6 text-center text-ios-secondary">
                        <p className="text-sm italic">Automated planner templates (Daily Motivation, Weekly Digest) are coming soon.</p>
                    </IOSCard>
                </div>
            ) : (
                <div className="space-y-4">
                    {planners.map(planner => (
                        <IOSCard key={planner.id} className="p-4 flex items-center justify-between">
                            <div className="flex items-center gap-4">
                                <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${planner.is_active ? 'bg-green-100 text-green-600' : 'bg-gray-100 text-gray-400'}`}>
                                    {planner.is_active ? <Play size={20} /> : <Pause size={20} />}
                                </div>
                                <div>
                                    <h4 className="font-bold">{planner.name}</h4>
                                    <p className="text-[13px] text-ios-secondary">
                                        {planner.is_active ? 'Active' : 'Paused'}
                                    </p>
                                </div>
                            </div>
                            <div className="flex gap-2">
                                <button className="p-2 text-ios-blue hover:bg-ios-background rounded-lg transition-colors">
                                    <Sliders size={18} />
                                </button>
                                <button className="p-2 text-ios-red hover:bg-ios-background rounded-lg transition-colors">
                                    <Trash2 size={18} />
                                </button>
                            </div>
                        </IOSCard>
                    ))}
                </div>
            )}
        </div>
    );
}
