'use client';
import { useState, useEffect } from 'react';
import { X, Instagram, Link as LinkIcon, ShieldCheck } from 'lucide-react';
import IOSButton from '@/components/IOSButton';
import { useSession } from 'next-auth/react';

interface Channel {
    id: string;
    name: string;
    platform: string;
    status: string;
    account_id: string;
    access_token?: string;
    token_source?: string;
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
    const [mode, setMode] = useState<'oauth' | 'manual'>('oauth');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const { data: session } = useSession();

    useEffect(() => {
        if (isOpen && channel) {
            setName(channel.name);
            setAccountId(channel.account_id);
            setAccessToken('');
            setProfilePictureUrl(channel.profile_picture_url || '');
            setMode('manual');
        } else if (isOpen && !channel) {
            // Reset for create mode
            setName('');
            setAccountId('');
            setAccessToken('');
            setProfilePictureUrl('');
            setMode('oauth');
        }
        setError('');
    }, [isOpen, channel]);

    if (!isOpen) return null;

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError('');

        try {
            if (!session) throw new Error('You must be logged in.');

            const channelData = {
                name: name,
                platform: 'instagram',
                account_id: accountId,
                ...(accessToken ? { access_token: accessToken } : {}),
                token_source: 'manual',
                profile_picture_url: profilePictureUrl,
                status: 'active'
            };

            let res;

            if (channel) {
                // Update existing
                res = await fetch(`/api/channels/${channel.id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(channelData)
                });
            } else {
                // Create new
                res = await fetch('/api/channels', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(channelData)
                });
            }

            if (!res.ok) {
                const errData = await res.json();
                throw new Error(errData.error || 'Failed to save channel');
            }

            onSuccess();
            onClose();
        } catch (err: unknown) {
            console.error(err);
            setError(err instanceof Error ? err.message : `Failed to ${channel ? 'update' : 'create'} channel`);
        } finally {
            setLoading(false);
        }
    };

    const startOAuth = async () => {
        setLoading(true);
        setError('');
        try {
            const res = await fetch('/api/channels/oauth/start');
            const data = await res.json();
            if (!res.ok || !data.url) throw new Error(data.error || 'Could not start Instagram OAuth');
            window.location.href = data.url;
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : 'Could not connect Instagram');
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
                    {!channel && (
                        <div className="grid grid-cols-2 gap-2 p-1 bg-ios-separator/50 rounded-xl">
                            <button
                                type="button"
                                onClick={() => setMode('oauth')}
                                className={`py-2 rounded-lg text-sm font-semibold ${mode === 'oauth' ? 'bg-ios-card text-ios-blue shadow-sm' : 'text-ios-secondary'}`}
                            >
                                OAuth
                            </button>
                            <button
                                type="button"
                                onClick={() => setMode('manual')}
                                className={`py-2 rounded-lg text-sm font-semibold ${mode === 'manual' ? 'bg-ios-card text-ios-blue shadow-sm' : 'text-ios-secondary'}`}
                            >
                                Manual
                            </button>
                        </div>
                    )}

                    {!channel && mode === 'oauth' && (
                        <div className="space-y-4">
                            <div className="p-4 rounded-xl bg-ios-card border border-ios-separator">
                                <div className="w-10 h-10 rounded-full bg-ios-blue/10 text-ios-blue flex items-center justify-center mb-3">
                                    <ShieldCheck size={20} />
                                </div>
                                <h3 className="font-semibold text-ios-text">Connect with Instagram</h3>
                                <p className="text-sm text-ios-secondary mt-1">
                                    Authorize the profile once. AutoReels stores the long-lived token and refreshes it weekly.
                                </p>
                            </div>
                            <IOSButton
                                variant="primary"
                                type="button"
                                disabled={loading}
                                onClick={startOAuth}
                                className="w-full justify-center !py-3.5 !text-[17px]"
                            >
                                {loading ? 'Connecting...' : 'Continue with Instagram'}
                            </IOSButton>
                        </div>
                    )}

                    {(channel || mode === 'manual') && (
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
                                Access Token
                            </label>
                            <div className="relative">
                                <input
                                    type="text"
                                    required={!channel}
                                    value={accessToken}
                                    onChange={(e) => setAccessToken(e.target.value)}
                                    placeholder={channel ? 'Leave blank to keep current token' : 'Paste Meta token or legacy token_ key'}
                                    className="w-full bg-ios-card border border-ios-separator rounded-xl px-4 py-3 text-[17px] focus:outline-none focus:border-ios-blue focus:ring-1 focus:ring-ios-blue transition-all font-mono text-sm pl-10"
                                />
                                <div className="absolute left-3 top-3.5 text-ios-text-secondary opacity-50">
                                    <Instagram size={16} />
                                </div>
                            </div>
                            <p className="text-[11px] text-ios-secondary mt-1.5 px-1">
                                Paste the Meta Business access token. Existing Redis keys that start with token_ still work for legacy channels.
                            </p>
                        </div>
                    </div>
                    )}

                    {error && (
                        <div className="p-3 bg-red-50 text-red-600 text-sm rounded-xl text-center">
                            {error}
                        </div>
                    )}

                    <div className="pt-2">
                        {(channel || mode === 'manual') && (
                        <IOSButton
                            variant="primary"
                            type="submit"
                            disabled={loading}
                            className="w-full justify-center !py-3.5 !text-[17px]"
                        >
                            {loading ? 'Saving...' : (channel ? 'Update Channel' : 'Add Channel')}
                        </IOSButton>
                        )}
                    </div>
                </form>
            </div>
        </div>
    );
}
