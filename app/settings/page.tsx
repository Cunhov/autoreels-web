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
        <div className="max-w-2xl mx-auto">
            <h1 className="text-2xl font-bold text-slate-800 mb-6">Settings</h1>

            <div className="bg-white p-6 rounded-lg border border-slate-200 shadow-sm">
                <form onSubmit={handleSave} className="space-y-6">
                    <div className="space-y-4">

                        <div className="space-y-2">
                            <label htmlFor="token" className="block text-sm font-medium text-slate-700">Instagram Access Token</label>
                            <input
                                type="text"
                                id="token"
                                className="block w-full rounded-md border-0 py-1.5 text-slate-900 shadow-sm ring-1 ring-inset ring-slate-300 placeholder:text-slate-400 focus:ring-2 focus:ring-inset focus:ring-indigo-600 sm:text-sm sm:leading-6 px-3"
                                placeholder="EAA..."
                                value={accessToken}
                                onChange={(e) => setAccessToken(e.target.value)}
                                required
                            />
                            <p className="text-xs text-slate-500">Long-lived Page Access Token from Facebook Developer Portal.</p>
                        </div>

                        <div className="space-y-2">
                            <label htmlFor="accountId" className="block text-sm font-medium text-slate-700">Instagram Business Account ID</label>
                            <input
                                type="text"
                                id="accountId"
                                className="block w-full rounded-md border-0 py-1.5 text-slate-900 shadow-sm ring-1 ring-inset ring-slate-300 placeholder:text-slate-400 focus:ring-2 focus:ring-inset focus:ring-indigo-600 sm:text-sm sm:leading-6 px-3"
                                placeholder="1784..."
                                value={accountId}
                                onChange={(e) => setAccountId(e.target.value)}
                                required
                            />
                        </div>

                    </div>

                    {message.text && (
                        <div className={`p-3 rounded-md text-sm ${message.type === 'success' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
                            {message.text}
                        </div>
                    )}

                    <div className="flex justify-end pt-4 border-t border-slate-100">
                        <button
                            type="submit"
                            disabled={saving}
                            className="px-6 py-2 bg-indigo-600 text-white font-medium rounded-md shadow-sm hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:opacity-50 flex items-center gap-2"
                        >
                            {saving ? 'Saving...' : (
                                <>
                                    <Save size={18} />
                                    Save Configuration
                                </>
                            )}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
