'use client';
import { useState, useEffect } from 'react';
import { X, Instagram, Link as LinkIcon } from 'lucide-react';
import IOSButton from '@/components/IOSButton';
import { supabase } from '@/lib/supabase';

interface Channel {
    id: string;
    name: string;
    platform: string;
    status: string;
    account_id: string;
    access_token?: string;
    profile_picture_url?: string;
}

interface ChannelModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSuccess: () => void;
    channel?: Channel;
}

export default function ChannelModal({ isOpen, onClose, onSuccess, channel }: ChannelModalProps) {
    const [name, setName] = useState('');
    const [accountId, setAccountId] = useState('');
    const [accessToken, setAccessToken] = useState('');
    const [profilePictureUrl, setProfilePictureUrl] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => {
        if (isOpen && channel) {
            setName(channel.name);
            setAccountId(channel.account_id);
            setAccessToken(channel.access_token || '');
            setProfilePictureUrl(channel.profile_picture_url || '');
        } else if (isOpen && !channel) {
            // Reset for create mode
            setName('');
            setAccountId('');
            setAccessToken('');
            setProfilePictureUrl('');
        }
        setError('');
    }, [isOpen, channel]);

    if (!isOpen) return null;

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError('');

        try {
            const { data: { session } } = await supabase.auth.getSession();
            if (!session) throw new Error('You must be logged in.');

            const channelData = {
                user_id: session.user.id,
                name: name,
                platform: 'instagram',
                account_id: accountId,
                access_token: accessToken,
                profile_picture_url: profilePictureUrl,
                status: 'active'
            };

            let error;

            if (channel) {
                // Update existing
                const { error: updateError } = await supabase
                    .from('channels')
                    .update(channelData)
                    .eq('id', channel.id);
                error = updateError;
            } else {
                // Create new
                const { error: insertError } = await supabase
                    .from('channels')
                    .insert(channelData);
                error = insertError;
            }

            if (error) throw error;

            onSuccess();
            onClose();
        } catch (err: any) {
            console.error(err);
            setError(err.message || `Failed to ${channel ? 'update' : 'create'} channel`);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
            <div className="bg-ios-card w-full max-w-md rounded-2xl overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 duration-200">
                <div className="px-6 py-4 border-b border-ios-separator flex items-center justify-between bg-ios-background">
                    <h2 className="text-[17px] font-semibold text-ios-text">
                        {channel ? 'Edit Channel' : 'Add Instagram Channel'}
                    </h2>
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
                                Profile Picture URL
                            </label>
                            <div className="relative">
                                <input
                                    type="url"
                                    value={profilePictureUrl}
                                    onChange={(e) => setProfilePictureUrl(e.target.value)}
                                    placeholder="https://..."
                                    className="w-full bg-ios-card border border-ios-separator rounded-xl px-4 py-3 text-[17px] focus:outline-none focus:border-ios-blue focus:ring-1 focus:ring-ios-blue transition-all pl-10"
                                />
                                <div className="absolute left-3 top-3.5 text-ios-text-secondary opacity-50">
                                    <LinkIcon size={16} />
                                    - </div>
                            </div>
                        </div>

                        <div>
                            <label className="block text-[13px] font-medium text-ios-secondary mb-1.5 uppercase tracking-wide">
                                Redis List Key
                            </label>
                            <div className="relative">
                                <input
                                    type="text"
                                    required
                                    value={accessToken}
                                    onChange={(e) => setAccessToken(e.target.value)}
                                    placeholder="instagram_access_tokens"
                                    className="w-full bg-ios-card border border-ios-separator rounded-xl px-4 py-3 text-[17px] focus:outline-none focus:border-ios-blue focus:ring-1 focus:ring-ios-blue transition-all font-mono text-sm pl-10"
                                />
                                <div className="absolute left-3 top-3.5 text-ios-text-secondary opacity-50">
                                    <Instagram size={16} />
                                </div>
                            </div>
                            <p className="text-[11px] text-ios-secondary mt-1.5 px-1">
                                Enter the Redis list key for access tokens.
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
                            {loading ? 'Saving...' : (channel ? 'Update Channel' : 'Add Channel')}
                        </IOSButton>
                    </div>
                </form>
            </div>
        </div>
    );
}
