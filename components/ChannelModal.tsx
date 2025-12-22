'use client';
import { useState } from 'react';
import { X, Instagram } from 'lucide-react';
import IOSButton from '@/components/IOSButton';
import { supabase } from '@/lib/supabase';

interface ChannelModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSuccess: () => void;
}

export default function ChannelModal({ isOpen, onClose, onSuccess }: ChannelModalProps) {
    const [name, setName] = useState('');
    const [accountId, setAccountId] = useState('');
    const [accessToken, setAccessToken] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    if (!isOpen) return null;

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError('');

        try {
            const { data: { session } } = await supabase.auth.getSession();
            if (!session) throw new Error('You must be logged in.');

            const { error: insertError } = await supabase
                .from('channels')
                .insert({
                    user_id: session.user.id,
                    name: name,
                    platform: 'instagram',
                    account_id: accountId,
                    access_token: accessToken, // Storing query string here
                    status: 'active'
                });

            if (insertError) throw insertError;

            // Reset and close
            setName('');
            setAccountId('');
            setAccessToken('');
            onSuccess();
            onClose();
        } catch (err: any) {
            console.error(err);
            setError(err.message || 'Failed to create channel');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
            <div className="bg-ios-card w-full max-w-md rounded-2xl overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 duration-200">
                <div className="px-6 py-4 border-b border-ios-separator flex items-center justify-between bg-ios-background">
                    <h2 className="text-[17px] font-semibold text-ios-text">Add Instagram Channel</h2>
                    <button onClick={onClose} className="p-1 rounded-full hover:bg-black/5 text-ios-secondary transition-colors">
                        <X size={20} />
                    </button>
                </div>

                <form onSubmit={handleSubmit} className="p-6 space-y-4 bg-ios-background/50">
                    <div className="space-y-4">
                        <div>
                            <label className="block text-[13px] font-medium text-ios-secondary mb-1.5 uppercase tracking-wide">
                                Channel Name
                            </label>
                            <input
                                type="text"
                                required
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                placeholder="My Business Page"
                                className="w-full bg-ios-card border border-ios-separator rounded-xl px-4 py-3 text-[17px] focus:outline-none focus:border-ios-blue focus:ring-1 focus:ring-ios-blue transition-all"
                            />
                        </div>

                        <div>
                            <label className="block text-[13px] font-medium text-ios-secondary mb-1.5 uppercase tracking-wide">
                                Instagram Account ID
                            </label>
                            <input
                                type="text"
                                required
                                value={accountId}
                                onChange={(e) => setAccountId(e.target.value)}
                                placeholder="178414..."
                                className="w-full bg-ios-card border border-ios-separator rounded-xl px-4 py-3 text-[17px] focus:outline-none focus:border-ios-blue focus:ring-1 focus:ring-ios-blue transition-all"
                            />
                        </div>

                        <div>
                            <label className="block text-[13px] font-medium text-ios-secondary mb-1.5 uppercase tracking-wide">
                                Redis List Get Request (Access Token)
                            </label>
                            <div className="relative">
                                <input
                                    type="text"
                                    required
                                    value={accessToken}
                                    onChange={(e) => setAccessToken(e.target.value)}
                                    placeholder="redis://... or http://..."
                                    className="w-full bg-ios-card border border-ios-separator rounded-xl px-4 py-3 text-[17px] focus:outline-none focus:border-ios-blue focus:ring-1 focus:ring-ios-blue transition-all font-mono text-sm"
                                />
                                <div className="absolute right-3 top-3.5 text-ios-text-secondary opacity-50">
                                    <Instagram size={16} />
                                </div>
                            </div>
                            <p className="text-[11px] text-ios-secondary mt-1.5 px-1">
                                Enter the Redis list request string that returns the valid access token.
                            </p>
                        </div>
                    </div>

                    {error && (
                        <div className="p-3 bg-red-50 text-red-600 text-sm rounded-xl text-center">
                            {error}
                        </div>
                    )}

                    <div className="pt-2">
                        <IOSButton
                            variant="primary"
                            type="submit"
                            disabled={loading}
                            className="w-full justify-center !py-3.5 !text-[17px]"
                        >
                            {loading ? 'Adding...' : 'Add Channel'}
                        </IOSButton>
                    </div>
                </form>
            </div>
        </div>
    );
}
