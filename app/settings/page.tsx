'use client';
import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import { Save } from 'lucide-react';

export default function Settings() {
    const [accessToken, setAccessToken] = useState('');
    const [accountId, setAccountId] = useState('');
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState({ type: '', text: '' });

    useEffect(() => {
        const fetchConfig = async () => {
            const { data, error } = await supabase.from('app_config').select('*');
            if (data) {
                const configMap = data.reduce((acc: any, item: any) => ({ ...acc, [item.key]: item.value }), {});
                setAccessToken(configMap['instagram_access_token'] || '');
                setAccountId(configMap['instagram_account_id'] || '');
            }
            setLoading(false);
        };
        fetchConfig();
    }, []);

    const handleSave = async (e: React.FormEvent) => {
        e.preventDefault();
        setSaving(true);
        setMessage({ type: '', text: '' });

        try {
            const updates = [
                { key: 'instagram_access_token', value: accessToken },
                { key: 'instagram_account_id', value: accountId },
            ];

            const { error } = await supabase.from('app_config').upsert(updates);

            if (error) throw error;
            setMessage({ type: 'success', text: 'Settings saved successfully!' });
        } catch (err: any) {
            setMessage({ type: 'error', text: err.message || 'Failed to save settings.' });
        } finally {
            setSaving(false);
        }
    };

    if (loading) return <div className="p-8 text-center text-slate-500">Loading settings...</div>;

    return (
        <div className="max-w-2xl mx-auto pb-20 md:pb-0">
            <h1 className="text-[34px] font-bold tracking-tight text-ios-text mb-6 px-4">Settings</h1>

            <form onSubmit={handleSave}>
                <div className="space-y-6">

                    {/* API Configuration Group */}
                    <div className="mb-6">
                        <div className="px-4 pb-2 text-xs font-medium text-ios-text-secondary uppercase tracking-wide">Instagram API</div>
                        <div className="ios-inset-grouped bg-ios-card divide-y divide-ios-separator">

                            {/* Access Token Input Row */}
                            <div className="flex items-center justify-between p-4 bg-ios-card">
                                <div className="flex-1">
                                    <label htmlFor="token" className="block text-[17px] text-ios-text mb-1">Access Token</label>
                                    <input
                                        type="text"
                                        id="token"
                                        className="block w-full bg-transparent text-[17px] text-ios-text-secondary placeholder:text-gray-400 focus:outline-none focus:text-ios-blue"
                                        placeholder="EAA..."
                                        value={accessToken}
                                        onChange={(e) => setAccessToken(e.target.value)}
                                        required
                                    />
                                </div>
                            </div>

                            {/* Account ID Input Row */}
                            <div className="flex items-center justify-between p-4 bg-ios-card">
                                <div className="flex-1">
                                    <label htmlFor="accountId" className="block text-[17px] text-ios-text mb-1">Account ID</label>
                                    <input
                                        type="text"
                                        id="accountId"
                                        className="block w-full bg-transparent text-[17px] text-ios-text-secondary placeholder:text-gray-400 focus:outline-none focus:text-ios-blue"
                                        placeholder="1784..."
                                        value={accountId}
                                        onChange={(e) => setAccountId(e.target.value)}
                                        required
                                    />
                                </div>
                            </div>

                        </div>
                        <div className="px-4 pt-2 text-xs text-ios-text-secondary">
                            Long-lived Page Access Token from Facebook Developer Portal.
                        </div>
                    </div>

                    {message.text && (
                        <div className={`mx-4 p-3 rounded-xl text-sm text-center ${message.type === 'success' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                            {message.text}
                        </div>
                    )}

                    <div className="px-4">
                        <button
                            type="submit"
                            disabled={saving}
                            className="ios-btn bg-ios-blue text-white w-full py-3.5 rounded-xl font-semibold text-[17px] disabled:opacity-50 shadow-sm"
                        >
                            {saving ? 'Saving...' : 'Save Configuration'}
                        </button>
                    </div>
                </div>
            </form>
        </div>
    );
}
