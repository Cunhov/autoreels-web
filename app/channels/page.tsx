'use client'
import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase'
import { Plus, Search, Instagram, ExternalLink, Settings, Shield, Radio, MoreVertical } from 'lucide-react'
import IOSButton from '@/components/IOSButton'
import IOSCard from '@/components/IOSComponents'
import ChannelModal from '@/components/ChannelModal'

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
    const [isModalOpen, setIsModalOpen] = useState(false);

    useEffect(() => {
        fetchChannels();
    }, []);

    async function fetchChannels() {
        setLoading(true);
        try {
            const { data, error } = await supabase
                .from('channels')
                .select('*')
                .eq('platform', 'instagram') // Force filter by Instagram
                .order('created_at', { ascending: false });

            if (error) throw error;
            setChannels(data || []);
        } catch (error) {
            console.error('Error fetching channels:', error);
        } finally {
            setLoading(false);
        }
    }

    const filteredChannels = channels.filter(c =>
        c.name.toLowerCase().includes(search.toLowerCase())
    );

    return (
        <div className="flex flex-col h-full bg-ios-background">
            {/* Header */}
            <header className="sticky top-0 z-10 p-6 pb-2 bg-ios-background/80 backdrop-blur-md">
                <div className="flex items-center justify-between mb-4">
                    <h1 className="text-[34px] font-bold text-ios-text">Instagram Channels</h1>
                    <div className="flex gap-2">
                        <IOSButton
                            variant="primary"
                            className="!py-2 !px-4 flex items-center gap-1"
                            onClick={() => setIsModalOpen(true)}
                        >
                            <Plus size={20} />
                            Add Channel
                        </IOSButton>
                    </div>
                </div>

                <div className="relative mb-4">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
                    <input
                        type="text"
                        placeholder="Search channels..."
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        className="w-full bg-ios-card/50 border border-ios-separator rounded-xl py-2 pl-10 pr-4 text-[17px] focus:outline-none focus:ring-1 focus:ring-ios-blue transition-all"
                    />
                </div>
            </header>

            <div className="flex flex-1 overflow-hidden px-6 pb-6 gap-6">
                {/* Main List */}
                <main className="flex-1 overflow-y-auto">
                    {loading ? (
                        <div className="flex justify-center p-12">
                            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-ios-blue"></div>
                        </div>
                    ) : filteredChannels.length === 0 ? (
                        <IOSCard className="p-12 text-center text-ios-secondary flex flex-col items-center justify-center min-h-[300px]">
                            <div className="mb-6 p-6 bg-ios-background rounded-full">
                                <Instagram size={48} strokeWidth={1} />
                            </div>
                            <h3 className="text-xl font-semibold mb-2 text-ios-text">No Instagram channels</h3>
                            <p className="max-w-xs mx-auto mb-6">Connect your Instagram accounts to start scheduling and publishing content.</p>
                            <IOSButton variant="secondary" onClick={() => setIsModalOpen(true)}>
                                Connect Account
                            </IOSButton>
                        </IOSCard>
                    ) : (
                        <div className="bg-ios-card rounded-2xl border border-ios-separator overflow-hidden divide-y divide-ios-separator shadow-sm">
                            {filteredChannels.map((channel) => (
                                <div key={channel.id} className="flex items-center p-4 hover:bg-black/5 transition-colors group">
                                    <div className="w-12 h-12 rounded-full bg-gradient-to-tr from-yellow-400 via-red-500 to-purple-500 p-[2px] mr-4 shadow-sm">
                                        <div className="w-full h-full rounded-full bg-white flex items-center justify-center">
                                            <Instagram size={24} className="text-pink-600" />
                                        </div>
                                    </div>
                                    <div className="flex-1">
                                        <div className="flex items-center gap-2 mb-0.5">
                                            <h4 className="font-semibold text-[17px] text-ios-text">{channel.name}</h4>
                                            {channel.status === 'active' && (
                                                <span className="w-2 h-2 rounded-full bg-green-500"></span>
                                            )}
                                        </div>
                                        <p className="text-[13px] text-ios-secondary font-mono">ID: {channel.account_id}</p>
                                    </div>
                                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                        <button className="p-2 text-ios-blue hover:bg-ios-blue/10 rounded-lg transition-colors" title="View settings">
                                            <Settings size={18} />
                                        </button>
                                        <button className="p-2 text-ios-text hover:bg-ios-text/10 rounded-lg transition-colors" title="More options">
                                            <MoreVertical size={18} />
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </main>
            </div>

            <ChannelModal
                isOpen={isModalOpen}
                onClose={() => setIsModalOpen(false)}
                onSuccess={fetchChannels}
            />
        </div>
    );
}
