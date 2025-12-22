'use client'
import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase'
import { Plus, Search, Filter, Instagram, Twitter, Facebook, Youtube, MoreVertical, ExternalLink, Settings, Shield, Radio } from 'lucide-react'
import IOSCard, { IOSGroup, IOSRow } from '@/components/IOSComponents'
import IOSButton from '@/components/IOSButton'

interface Channel {
    id: string;
    name: string;
    platform: string;
    status: string;
    account_id: string;
}

export default function ChannelsPage() {
    const [channels, setChannels] = useState<Channel[]>([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState('');
    const [selectedPlatform, setSelectedPlatform] = useState('All');

    useEffect(() => {
        fetchChannels();
    }, []);

    async function fetchChannels() {
        try {
            const { data, error } = await supabase
                .from('channels')
                .select('*')
                .order('created_at', { ascending: false });

            if (error) throw error;
            setChannels(data || []);
        } catch (error) {
            console.error('Error fetching channels:', error);
        } finally {
            setLoading(false);
        }
    }

    const platforms = [
        { name: 'All', icon: Shield, count: channels.length },
        { name: 'Instagram', icon: Instagram, count: channels.filter(c => c.platform === 'instagram').length },
    ];

    const filteredPlatforms = platforms.filter(p => p.name === 'All' || p.count > 0);

    const filteredChannels = channels.filter(c => {
        const matchesSearch = c.name.toLowerCase().includes(search.toLowerCase());
        const matchesPlatform = selectedPlatform === 'All' || c.platform.toLowerCase() === selectedPlatform.toLowerCase();
        return matchesSearch && matchesPlatform;
    });

    return (
        <div className="flex flex-col h-full bg-ios-background">
            {/* Header */}
            <header className="sticky top-0 z-10 p-6 pb-2 bg-ios-background/80 backdrop-blur-md">
                <div className="flex items-center justify-between mb-4">
                    <h1 className="text-[34px] font-bold text-ios-text">Channels</h1>
                    <div className="flex gap-2">
                        <IOSButton variant="secondary" className="!p-2">
                            <Filter size={20} />
                        </IOSButton>
                        <IOSButton variant="primary" className="!py-2 !px-4 flex items-center gap-1">
                            <Plus size={20} />
                            Add channel
                        </IOSButton>
                    </div>
                </div>

                <div className="relative mb-4">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
                    <input
                        type="text"
                        placeholder="Search"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        className="w-full bg-ios-card/50 border border-ios-separator rounded-xl py-2 pl-10 pr-4 text-[17px] focus:outline-none focus:ring-1 focus:ring-ios-blue"
                    />
                </div>
            </header>

            <div className="flex flex-1 overflow-hidden px-6 pb-6 gap-6">
                {/* Platform Sidebar */}
                <aside className="w-64 hidden lg:block overflow-y-auto">
                    <div className="space-y-1">
                        {filteredPlatforms.map((p) => (
                            <button
                                key={p.name}
                                onClick={() => setSelectedPlatform(p.name)}
                                className={`w-full flex items-center justify-between p-3 rounded-xl transition-colors ${selectedPlatform === p.name ? 'bg-ios-blue text-white' : 'hover:bg-ios-card text-ios-text'
                                    }`}
                            >
                                <div className="flex items-center gap-3">
                                    <p.icon size={20} />
                                    <span className="font-medium text-[15px]">{p.name}</span>
                                </div>
                                <span className={`text-[13px] ${selectedPlatform === p.name ? 'text-white/80' : 'text-ios-secondary'}`}>
                                    {p.count}
                                </span>
                            </button>
                        ))}
                    </div>
                </aside>

                {/* Channels List */}
                <main className="flex-1 overflow-y-auto">
                    {loading ? (
                        <div className="flex justify-center p-12">
                            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-ios-blue"></div>
                        </div>
                    ) : filteredChannels.length === 0 ? (
                        <IOSCard className="p-12 text-center text-ios-secondary">
                            <div className="mb-4 flex justify-center">
                                <Radio size={48} strokeWidth={1} />
                            </div>
                            <h3 className="text-xl font-semibold mb-2">No channels yet</h3>
                            <p>Connect your social media accounts to start publishing.</p>
                        </IOSCard>
                    ) : (
                        <div className="bg-ios-card rounded-2xl border border-ios-separator overflow-hidden divide-y divide-ios-separator">
                            {filteredChannels.map((channel) => (
                                <div key={channel.id} className="flex items-center p-4 hover:bg-black/5 transition-colors group">
                                    <div className="w-10 h-10 rounded-full bg-ios-background flex items-center justify-center text-ios-blue mr-4 border border-ios-separator">
                                        <Instagram size={24} />
                                    </div>
                                    <div className="flex-1">
                                        <div className="flex items-center gap-2">
                                            <h4 className="font-semibold text-[17px]">{channel.name}</h4>
                                            <span className="px-2 py-0.5 rounded-full bg-green-100 text-green-700 text-[11px] font-bold uppercase">
                                                Active
                                            </span>
                                        </div>
                                        <p className="text-[13px] text-ios-secondary">{channel.account_id}</p>
                                    </div>
                                    <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                        <button className="p-2 text-ios-blue hover:bg-ios-background rounded-lg">
                                            <ExternalLink size={18} />
                                        </button>
                                        <button className="p-2 text-ios-blue hover:bg-ios-background rounded-lg">
                                            <Settings size={18} />
                                        </button>
                                        <button className="p-2 text-ios-text hover:bg-ios-background rounded-lg">
                                            <MoreVertical size={18} />
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </main>
            </div>
        </div>
    );
}
