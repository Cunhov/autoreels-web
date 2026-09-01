'use client';
import { useState, useEffect, useCallback, useRef } from 'react';
import { X, Instagram, Link as LinkIcon, ShieldCheck, Youtube, Music2, ClipboardPaste, Download, CheckCircle2, XCircle, RefreshCw } from 'lucide-react';
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
    has_proxy?: boolean;
    proxy_url_masked?: string | null;
    proxy_enabled?: boolean;
}

interface RemoteSession {
    id: string;
    label: string;
    channel_id: string | null;
    channel_name: string | null;
    status: string;
    created_at: string;
    last_rotate_at: string | null;
}

interface ChannelModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSuccess: () => void;
    channel?: Channel;
}

const COOKIE_FIELDS = [
    { key: 'LOGIN_INFO', label: 'LOGIN_INFO' },
    { key: '__Secure-3PAPISID', label: '__Secure-3PAPISID' },
    { key: '__Secure-3PSID', label: '__Secure-3PSID' },
    { key: '__Secure-3PSIDTS', label: '__Secure-3PSIDTS' },
] as const;

/** Status da sessão remota traduzido para PT-BR; estados desconhecidos → "desconhecido". */
const SESSION_STATUS_PT: Record<string, string> = {
    active: 'ativa',
    expired: 'expirada',
    validating: 'validando',
    pending: 'pendente',
    error: 'erro',
};

function sessionStatusBadge(statusRaw: string) {
    const key = statusRaw.trim().toLowerCase();
    const active = key === 'active';
    const label = SESSION_STATUS_PT[key] || 'desconhecido';
    return (
        <span className={`flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${active ? 'bg-ios-green/10 text-ios-green' : 'bg-ios-red/10 text-ios-red'}`}>
            {active ? <CheckCircle2 size={10} /> : <XCircle size={10} />}
            {label}
        </span>
    );
}

export default function ChannelModal({ isOpen, onClose, onSuccess, channel }: ChannelModalProps) {
    const [name, setName] = useState('');
    const [accountId, setAccountId] = useState('');
    const [accessToken, setAccessToken] = useState('');
    const [profilePictureUrl, setProfilePictureUrl] = useState('');
    const [mode, setMode] = useState<'oauth' | 'manual'>('oauth');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    // ── YouTube ──
    const [platform, setPlatform] = useState<'instagram' | 'youtube' | 'tiktok'>('instagram');
    const [ytTab, setYtTab] = useState<'cookies' | 'import'>('cookies');
    const [ytLabel, setYtLabel] = useState('');
    const [cookies, setCookies] = useState<Record<string, string>>({});
    const [showCookie, setShowCookie] = useState<Record<string, boolean>>({});
    const [ytSubmitted, setYtSubmitted] = useState(false);
    const [sessions, setSessions] = useState<RemoteSession[]>([]);
    const [sessionsLoading, setSessionsLoading] = useState(false);
    const [sessionsError, setSessionsError] = useState('');
    const [linkingId, setLinkingId] = useState<string | null>(null);
    const [proxyUrl, setProxyUrl] = useState('');
    const [proxyEnabled, setProxyEnabled] = useState(true);
    const [proxyTestStatus, setProxyTestStatus] = useState<'idle'|'loading'|'ok'|'error'>('idle');
    const [proxyTestMsg, setProxyTestMsg] = useState('');
    const [proxyMasked, setProxyMasked] = useState<string | null>(null);
    const { data: session } = useSession();

    useEffect(() => {
        if (isOpen && channel) {
            setName(channel.name);
            setAccountId(channel.account_id);
            setAccessToken('');
            setProfilePictureUrl(channel.profile_picture_url || '');
            setMode('manual');
            setPlatform(channel.platform === 'youtube' ? 'youtube' : channel.platform === 'tiktok' ? 'tiktok' : 'instagram');
            setProxyUrl('');
            setProxyEnabled(channel.proxy_enabled ?? true);
            setProxyMasked(channel.proxy_url_masked || null);
            setProxyTestStatus('idle'); setProxyTestMsg('');
        } else if (isOpen && !channel) {
            // Reset for create mode
            setName('');
            setAccountId('');
            setAccessToken('');
            setProfilePictureUrl('');
            setMode('oauth');
            setPlatform('instagram');
            setYtTab('cookies');
            setYtLabel('');
            setCookies({});
            setShowCookie({});
            setYtSubmitted(false);
            setProxyUrl('');
            setProxyEnabled(true);
            setProxyMasked(null);
            setProxyTestStatus('idle'); setProxyTestMsg('');
        }
        setError('');
        setSessionsError('');
    }, [isOpen, channel]);

    const fetchSessions = useCallback(async () => {
        setSessionsLoading(true);
        setSessionsError('');
        try {
            const res = await fetch('/api/youtube/sessions');
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Falha ao carregar sessões');
            setSessions(Array.isArray(data.sessions) ? data.sessions : []);
        } catch (err: unknown) {
            setSessionsError(err instanceof Error ? err.message : 'Falha ao carregar sessões');
        } finally {
            setSessionsLoading(false);
        }
    }, []);

    // Carrega a lista de sessões ao abrir a aba "Importar sessão"
    useEffect(() => {
        if (isOpen && !channel && platform === 'youtube' && ytTab === 'import') {
            fetchSessions();
        }
    }, [isOpen, channel, platform, ytTab, fetchSessions]);

    if (!isOpen) return null;

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError('');

        try {
            if (!session) throw new Error('You must be logged in.');

            // Validação local de proxy (formato)
            if (proxyUrl.trim()) {
                const proxyValid = /^https?:\/\/.+:\d+$/.test(proxyUrl.trim()) && (()=>{ try{ const u=new URL(proxyUrl.trim()); return (u.protocol==='http:'||u.protocol==='https:') && !!u.hostname && !!u.port;}catch{ return false;}})();
                if (!proxyValid) throw new Error('Proxy inválido. Use http://user:pass@host:porta ou http://host:porta');
            }
            const channelData: Record<string, unknown> = {
                name: name.trim().slice(0,80),
                platform: 'instagram',
                account_id: accountId,
                ...(accessToken ? { access_token: accessToken } : {}),
                token_source: 'manual',
                profile_picture_url: profilePictureUrl,
                status: 'active',
                ...(proxyUrl.trim() ? { proxy_url: proxyUrl.trim() } : (channel && !proxyUrl.trim() && proxyMasked ? {} : { proxy_url: null })),
                proxy_enabled: proxyEnabled,
            };
            // Se edição e campo proxy vazio e havia proxy salvo, não envia proxy_url para manter existente (exceto se usuário limpou explicitamente)
            if (channel && !proxyUrl.trim() && proxyMasked) {
                delete (channelData as any).proxy_url;
            }

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

    /** S1: inicia o OAuth TikTok (app/api/tiktok/oauth/start). O callback cria/atualiza
     *  o Channel com platform="tiktok" e persiste tokens em Channel.settings.tiktok_*. */
    const startTiktokOAuth = async () => {
        setLoading(true);
        setError('');
        try {
            const res = await fetch('/api/tiktok/oauth/start');
            const data = await res.json();
            if (!res.ok || !data.url) throw new Error(data.error || 'Could not start TikTok OAuth');
            window.location.href = data.url;
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : 'Could not connect TikTok');
            setLoading(false);
        }
    };

    /** Salva proxy de canal em edição (YouTube e TikTok usam o mesmo fluxo). */
    const saveProxyEdit = async () => {
        setLoading(true);
        setError('');
        try {
            if (!channel) return;
            if (proxyUrl.trim()) {
                try {
                    const u = new URL(proxyUrl.trim());
                    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname || !u.port) throw new Error();
                } catch {
                    throw new Error('Proxy inválido. Use http://user:pass@host:porta');
                }
            }
            const payload: Record<string, unknown> = {};
            if (proxyMasked === null && !proxyUrl.trim()) {
                // usuário clicou "Remover" (proxyMasked null) e não digitou novo
                payload.proxy_url = null;
            } else if (proxyUrl.trim()) {
                payload.proxy_url = proxyUrl.trim();
            }
            // proxyMasked && !proxyUrl → manter proxy existente: não envia nada
            payload.proxy_enabled = proxyEnabled;
            if (Object.keys(payload).length === 0) {
                setError('Nenhuma alteração de proxy.');
                setLoading(false);
                return;
            }
            const res = await fetch(`/api/channels/${channel.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Falha ao salvar proxy');
            onSuccess();
            onClose();
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : 'Falha ao salvar proxy');
        } finally {
            setLoading(false);
        }
    };

    /** Aba "Colar cookies": valida os 4 campos e chama POST /api/youtube/connect. */
    const handleYoutubeConnect = async (e: React.FormEvent) => {
        e.preventDefault();
        setYtSubmitted(true);
        setError('');
        if (!session) {
            setError('Você precisa estar conectado.');
            return;
        }
        const missing = COOKIE_FIELDS.find((f) => !(cookies[f.key] || '').trim());
        if (missing) {
            setError(`Preencha o cookie ${missing.label}.`);
            return;
        }
        setLoading(true);
        try {
            // inclui proxy se preenchido
            if (proxyUrl.trim()) {
                try { const u=new URL(proxyUrl.trim()); if((u.protocol!=='http:'&&u.protocol!=='https:')||!u.hostname||!u.port) throw new Error(); } catch { setError('Proxy inválido. Use http://user:pass@host:porta'); setLoading(false); return; }
            }
            const res = await fetch('/api/youtube/connect', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    cookies: Object.fromEntries(COOKIE_FIELDS.map((f) => [f.key, cookies[f.key].trim()])),
                    label: ytLabel.trim(),
                    ...(proxyUrl.trim() ? { proxy_url: proxyUrl.trim(), proxy_enabled: proxyEnabled } : {}),
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (res.status === 401) throw new Error('Você precisa estar conectado.');
            if (!res.ok) throw new Error(data.error || 'Falha ao conectar canal YouTube');
            onSuccess();
            onClose();
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : 'Falha ao conectar canal YouTube');
        } finally {
            setLoading(false);
        }
    };

    const handleTestProxy = async () => {
        const raw = proxyUrl.trim();
        // Se edição e campo vazio mas há proxy salvo, testa o salvo (GET checkProxy)
        if (!raw && channel?.id && proxyMasked) {
            setProxyTestStatus('loading'); setProxyTestMsg('');
            try {
                const res = await fetch(`/api/channels/${channel.id}/test?checkProxy=true`);
                const data = await res.json().catch(()=>({}));
                if (!res.ok || data.ok === false) throw new Error(data.error || 'Falha no teste do proxy');
                setProxyTestStatus('ok'); setProxyTestMsg(`Proxy OK: ${data.proxy || ''}`);
            } catch (err: unknown) {
                setProxyTestStatus('error'); setProxyTestMsg(err instanceof Error ? err.message : 'Falha ao testar proxy');
            }
            return;
        }
        if (!raw) { setProxyTestStatus('error'); setProxyTestMsg('Informe a URL do proxy.'); return; }
        // Valida formato
        try { const u=new URL(raw); if((u.protocol!=='http:'&&u.protocol!=='https:')||!u.hostname||!u.port) throw new Error(); } catch { setProxyTestStatus('error'); setProxyTestMsg('Formato inválido. Use http://user:pass@host:porta'); return; }
        setProxyTestStatus('loading'); setProxyTestMsg('');
        try {
            let res: Response;
            if (channel?.id) {
                // Testa via endpoint do canal (POST com proxy_url)
                res = await fetch(`/api/channels/${channel.id}/test`, { method: 'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ proxy_url: raw }) });
            } else {
                // Sem canal ainda: testa formato localmente via validação + tentativa fetch (sem servidor) — apenas valida
                // Como não há canal, fazemos validação e tentamos HEAD via proxy não persistido usando endpoint genérico? Falha: sem id não há rota.
                // Fallback: apenas valida e mostra OK de formato
                setProxyTestStatus('ok'); setProxyTestMsg('Formato válido. Salve o canal e teste novamente para verificar conectividade.');
                return;
            }
            const data = await res.json().catch(()=>({}));
            if (!res.ok || data.ok === false) throw new Error(data.error || 'Falha no teste do proxy');
            setProxyTestStatus('ok'); setProxyTestMsg(`Proxy OK: ${data.proxy || maskProxy(raw)}`);
        } catch (err: unknown) {
            setProxyTestStatus('error'); setProxyTestMsg(err instanceof Error ? err.message : 'Falha ao testar proxy');
        }
    };
    function maskProxy(url: string){ try{ const u=new URL(url); if(u.password) u.password='***'; return u.toString(); }catch{ return '***'; } }

    /** Aba "Importar sessão": vincula uma sessão existente da API externa. */
    const handleLinkSession = async (sessionId: string) => {
        setLinkingId(sessionId);
        setError('');
        try {
            if (!session) throw new Error('Você precisa estar conectado.');
            const res = await fetch('/api/youtube/sessions/link', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId }),
            });
            const data = await res.json().catch(() => ({}));
            if (res.status === 401) throw new Error('Você precisa estar conectado.');
            if (!res.ok) throw new Error(data.error || 'Falha ao vincular sessão');
            onSuccess();
            onClose();
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : 'Falha ao vincular sessão');
        } finally {
            setLinkingId(null);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" role="presentation" onClick={onClose} onKeyDown={(e)=>{ if(e.key==="Escape") onClose(); }}>
            <div role="dialog" aria-modal="true" aria-labelledby="channel-modal-title" tabIndex={-1} onClick={(e)=>e.stopPropagation()} className="bg-ios-card w-full max-w-md rounded-2xl overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 duration-200 max-h-[85dvh] flex flex-col">
                <div className="px-6 py-4 border-b border-ios-separator flex items-center justify-between bg-ios-background">
                    <h2 id="channel-modal-title" className="text-[17px] font-semibold text-ios-text">
                        {!channel
                            ? 'Adicionar canal'
                            : platform === 'youtube'
                                ? 'Canal do YouTube'
                                : platform === 'tiktok'
                                    ? 'Canal do TikTok'
                                    : 'Edit Channel'}
                    </h2>
                    <button onClick={onClose} className="p-1 rounded-full hover:bg-black/5 text-ios-secondary transition-colors">
                        <X size={20} />
                    </button>
                </div>

                {/* Escolha de plataforma (somente na criação) */}
                {!channel && (
                    <div className="px-6 pt-4 bg-ios-background/50">
                        <div className="grid grid-cols-3 gap-2 p-1 bg-ios-separator/50 rounded-xl">
                            <button
                                type="button"
                                onClick={() => setPlatform('instagram')}
                                className={`py-2 rounded-lg text-sm font-semibold flex items-center justify-center gap-1.5 ${platform === 'instagram' ? 'bg-ios-card text-ios-blue shadow-sm' : 'text-ios-secondary'}`}
                            >
                                <Instagram size={15} /> Instagram
                            </button>
                            <button
                                type="button"
                                onClick={() => setPlatform('youtube')}
                                className={`py-2 rounded-lg text-sm font-semibold flex items-center justify-center gap-1.5 ${platform === 'youtube' ? 'bg-ios-card text-ios-red shadow-sm' : 'text-ios-secondary'}`}
                            >
                                <Youtube size={16} /> YouTube
                            </button>
                            <button
                                type="button"
                                onClick={() => setPlatform('tiktok')}
                                className={`py-2 rounded-lg text-sm font-semibold flex items-center justify-center gap-1.5 ${platform === 'tiktok' ? 'bg-ios-card text-ios-text shadow-sm' : 'text-ios-secondary'}`}
                            >
                                <Music2 size={15} /> TikTok
                            </button>
                        </div>
                    </div>
                )}

                {/* ── Fluxo YouTube (criação) ─────────────────────────────────── */}
                {!channel && platform === 'youtube' && (
                    <form onSubmit={handleYoutubeConnect} className="p-6 space-y-4 bg-ios-background/50 overflow-y-auto custom-scrollbar">
                        {/* Abas */}
                        <div className="grid grid-cols-2 gap-2 p-1 bg-ios-separator/50 rounded-xl">
                            <button
                                type="button"
                                onClick={() => { setYtTab('cookies'); setError(''); setYtSubmitted(false); }}
                                className={`py-2 rounded-lg text-[13px] font-semibold flex items-center justify-center gap-1.5 ${ytTab === 'cookies' ? 'bg-ios-card text-ios-blue shadow-sm' : 'text-ios-secondary'}`}
                            >
                                <ClipboardPaste size={14} /> Colar cookies
                            </button>
                            <button
                                type="button"
                                onClick={() => { setYtTab('import'); setError(''); }}
                                className={`py-2 rounded-lg text-[13px] font-semibold flex items-center justify-center gap-1.5 ${ytTab === 'import' ? 'bg-ios-card text-ios-blue shadow-sm' : 'text-ios-secondary'}`}
                            >
                                <Download size={14} /> Importar sessão
                            </button>
                        </div>

                        {ytTab === 'cookies' && (
                            <>
                                <p className="text-[12px] text-ios-text-secondary -mt-1">
                                    Cole os 4 cookies da sua sessão do YouTube (chrome://devtools → Application → Cookies). Eles são enviados apenas para a API externa e nunca armazenados neste app.
                                </p>
                                <div>
                                    <label className="block text-[13px] font-medium text-ios-secondary mb-1.5 uppercase tracking-wide">
                                        Nome do canal (opcional)
                                    </label>
                                    <input
                                        type="text"
                                        value={ytLabel}
                                        onChange={(e) => setYtLabel(e.target.value)}
                                        placeholder="Meu Canal"
                                        className="w-full bg-ios-card border border-ios-separator rounded-xl px-4 py-3 text-[17px] focus:outline-none focus:border-ios-blue focus:ring-1 focus:ring-ios-blue transition-all"
                                    />
                                </div>
                                {COOKIE_FIELDS.map((field) => {
                                    const isEmpty = !(cookies[field.key] || '').trim();
                                    const show = (cookies as Record<string, string> & { _show?: Record<string,boolean> })._show?.[field.key];
                                    // Use local state via cookiesShow map
                                    return (
                                    <div key={field.key}>
                                        <label htmlFor={`cookie-${field.key}`} className="block text-[13px] font-medium text-ios-secondary mb-1.5 uppercase tracking-wide">
                                            {field.label}
                                        </label>
                                        <div className="relative">
                                        <input
                                            id={`cookie-${field.key}`}
                                            type={showCookie[field.key] ? "text" : "password"}
                                            value={cookies[field.key] || ''}
                                            onChange={(e) => setCookies((prev) => ({ ...prev, [field.key]: e.target.value }))}
                                            placeholder="Valor do cookie"
                                            aria-invalid={ytSubmitted && isEmpty ? true : undefined}
                                            aria-describedby={`cookie-${field.key}-help`}
                                            className="w-full bg-ios-card border border-ios-separator rounded-xl px-4 py-3 pr-20 text-[14px] font-mono focus:outline-none focus:border-ios-blue focus:ring-1 focus:ring-ios-blue transition-all aria-[invalid=true]:border-ios-red"
                                            autoComplete="off"
                                        />
                                        <button
                                            type="button"
                                            onClick={() => setShowCookie(s => ({ ...s, [field.key]: !s[field.key]}))}
                                            className="absolute right-2 top-1/2 -translate-y-1/2 px-2 py-1 text-xs font-medium text-ios-blue hover:bg-ios-blue/10 rounded-lg"
                                            aria-label={showCookie[field.key] ? `Ocultar ${field.label}` : `Mostrar ${field.label}`}
                                        >
                                            {showCookie[field.key] ? 'Ocultar' : 'Mostrar'}
                                        </button>
                                        </div>
                                    </div>
                                )})}
                                {/* Proxy YouTube (criação) */}
                                <div className="pt-2 border-t border-ios-separator mt-2">
                                    <label className="block text-[13px] font-medium text-ios-secondary mb-1.5 uppercase tracking-wide">Proxy (opcional)</label>
                                    <div className="flex gap-2">
                                        <input type="text" value={proxyUrl} onChange={(e)=>{ setProxyUrl(e.target.value); setProxyTestStatus('idle'); setProxyTestMsg(''); }} placeholder="http://user:pass@host:porta" className="flex-1 bg-ios-card border border-ios-separator rounded-xl px-4 py-3 text-[14px] font-mono focus:outline-none focus:border-ios-blue" />
                                        <button type="button" onClick={handleTestProxy} disabled={proxyTestStatus==='loading'} className="px-3 py-2 rounded-xl bg-ios-blue/10 text-ios-blue text-[13px] font-semibold hover:bg-ios-blue/20 disabled:opacity-50 shrink-0">{proxyTestStatus==='loading' ? 'Testando...' : 'Testar'}</button>
                                    </div>
                                    <p className="text-[11px] text-ios-secondary mt-1 px-1">Proxy HTTP/HTTPS usado nas chamadas YouTube API deste canal.</p>
                                    {proxyTestStatus!=='idle' && proxyTestMsg ? (<p className={`text-[12px] mt-1 px-1 ${proxyTestStatus==='ok'?'text-ios-green':'text-ios-red'}`}>{proxyTestMsg}</p>) : null}
                                </div>
                            </>
                        )}

                        {ytTab === 'import' && (
                            <div className="space-y-2 min-h-[120px]">
                                {sessionsLoading ? (
                                    <div className="flex justify-center py-8">
                                        <RefreshCw size={20} className="animate-spin text-ios-blue" />
                                    </div>
                                ) : sessionsError ? (
                                    <div className="p-4 rounded-xl bg-ios-red/10 text-ios-red text-sm text-center space-y-2">
                                        <p>{sessionsError}</p>
                                        <IOSButton variant="secondary" type="button" onClick={fetchSessions} className="!py-1.5 !px-3 !text-[13px] justify-center">
                                            Tentar novamente
                                        </IOSButton>
                                    </div>
                                ) : sessions.length === 0 ? (
                                    <div className="py-8 text-center text-ios-text-secondary text-sm space-y-2">
                                        <Youtube size={32} className="mx-auto opacity-30" />
                                        <p>Nenhuma sessão encontrada na API externa.</p>
                                        <p className="text-[12px]">Use a aba “Colar cookies” para criar a primeira.</p>
                                    </div>
                                ) : (
                                    sessions.map((s) => (
                                        <div key={s.id} className="p-3 rounded-xl bg-ios-card border border-ios-separator flex items-center gap-3">
                                            <div className="w-9 h-9 rounded-full bg-ios-red/10 text-ios-red flex items-center justify-center shrink-0">
                                                <Youtube size={18} />
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-2 flex-wrap">
                                                    <p className="text-[14px] font-semibold text-ios-text truncate">
                                                        {s.channel_name || s.label || s.id.slice(0, 8)}
                                                    </p>
                                                    {sessionStatusBadge(s.status)}
                                                </div>
                                                <p className="text-[11px] text-ios-text-secondary truncate">
                                                    {s.label ? `${s.label} · ` : ''}
                                                    {s.last_rotate_at
                                                        ? `última rotação ${new Date(s.last_rotate_at).toLocaleString()}`
                                                        : 'sem rotação registrada'}
                                                </p>
                                            </div>
                                            <IOSButton
                                                variant="secondary"
                                                type="button"
                                                disabled={linkingId !== null || s.status.toLowerCase() !== 'active'}
                                                onClick={() => handleLinkSession(s.id)}
                                                className="!py-1.5 !px-3 !text-[13px] shrink-0 justify-center"
                                            >
                                                {linkingId === s.id ? <RefreshCw size={13} className="animate-spin" /> : 'Vincular'}
                                            </IOSButton>
                                        </div>
                                    ))
                                )}
                            </div>
                        )}

                        {error && (
                            <div className="p-3 bg-red-50 dark:bg-red-900/20 text-ios-red text-sm rounded-xl text-center">
                                {error}
                            </div>
                        )}

                        {ytTab === 'cookies' && (
                            <div className="pt-2">
                                <IOSButton
                                    variant="primary"
                                    type="submit"
                                    disabled={loading}
                                    className="w-full justify-center !py-3.5 !text-[17px]"
                                >
                                    {loading ? 'Conectando...' : 'Conectar YouTube'}
                                </IOSButton>
                            </div>
                        )}
                    </form>
                )}

                {/* ── Fluxo TikTok (criação): OAuth ─────────────────────────── */}
                {!channel && platform === 'tiktok' && (
                    <form
                        onSubmit={(e) => { e.preventDefault(); startTiktokOAuth(); }}
                        className="p-6 space-y-4 bg-ios-background/50 overflow-y-auto custom-scrollbar"
                    >
                        <div className="p-4 rounded-xl bg-ios-card border border-ios-separator">
                            <div className="w-10 h-10 rounded-full bg-black text-white flex items-center justify-center mb-3">
                                <Music2 size={20} />
                            </div>
                            <h3 className="font-semibold text-ios-text">Conectar via TikTok OAuth</h3>
                            <p className="text-[13px] text-ios-secondary mt-1.5">
                                Autorize a conta uma única vez. O AutoReels guarda o token de acesso e refresh em{' '}
                                <span className="font-mono">Channel.settings.tiktok_*</span> e renova automaticamente.
                            </p>
                        </div>
                        <IOSButton
                            variant="primary"
                            type="submit"
                            disabled={loading}
                            className="w-full justify-center !py-3.5 !text-[17px]"
                        >
                            {loading ? 'Conectando…' : 'Conectar TikTok'}
                        </IOSButton>
                        <p className="text-[11px] text-ios-secondary text-center -mt-1">
                            Após autorizar, você será redirecionado de volta e o canal aparecerá na lista.
                        </p>
                        {error && (
                            <div className="p-3 bg-red-50 dark:bg-red-900/20 text-ios-red text-sm rounded-xl text-center">
                                {error}
                            </div>
                        )}
                    </form>
                )}

                {/* ── Canal YouTube em edição: sem formulário de edição — estado explícito ── */}
                {channel && platform === 'youtube' && (
                    <div className="p-6 space-y-4 bg-ios-background/50">
                        <p className="text-sm text-ios-text-secondary">
                            Canais YouTube só permitem editar o proxy. Desconecte e reconecte para alterar cookies/sessão.
                        </p>
                        <div>
                            <label className="block text-[13px] font-medium text-ios-secondary mb-1.5 uppercase tracking-wide">Proxy (opcional)</label>
                            {proxyMasked && !proxyUrl ? (
                                <div className="mb-1.5 px-3 py-2 rounded-xl bg-ios-separator/30 text-[12px] font-mono text-ios-secondary flex items-center justify-between">
                                    <span className="truncate">Salvo: {proxyMasked}</span>
                                    <button type="button" onClick={()=>{ setProxyMasked(null); setProxyUrl(''); }} className="ml-2 text-[11px] text-ios-red font-semibold shrink-0">Remover</button>
                                </div>
                            ) : null}
                            <div className="flex gap-2">
                                <input type="text" value={proxyUrl} onChange={(e)=>{ setProxyUrl(e.target.value); setProxyTestStatus('idle'); setProxyTestMsg(''); }} placeholder="http://user:pass@host:porta" className="flex-1 bg-ios-card border border-ios-separator rounded-xl px-4 py-3 text-[14px] font-mono focus:outline-none focus:border-ios-blue" />
                                <button type="button" onClick={handleTestProxy} disabled={proxyTestStatus==='loading'} className="px-3 py-2 rounded-xl bg-ios-blue/10 text-ios-blue text-[13px] font-semibold hover:bg-ios-blue/20 disabled:opacity-50 shrink-0">{proxyTestStatus==='loading' ? 'Testando...' : 'Testar Proxy'}</button>
                            </div>
                            {proxyTestStatus!=='idle' && proxyTestMsg ? (<p className={`text-[12px] mt-1 ${proxyTestStatus==='ok'?'text-ios-green':'text-ios-red'}`}>{proxyTestMsg}</p>) : null}
                            <label className="flex items-center gap-2 mt-2 text-[13px] text-ios-secondary">
                                <input type="checkbox" checked={proxyEnabled} onChange={(e)=>setProxyEnabled(e.target.checked)} className="rounded" />
                                Proxy habilitado
                            </label>
                        </div>
                        <div className="flex gap-2">
                            <IOSButton variant="secondary" type="button" onClick={onClose} className="flex-1 justify-center !py-3 !text-[15px]">Fechar</IOSButton>
                            <IOSButton variant="primary" type="button" disabled={loading} onClick={saveProxyEdit} className="flex-1 justify-center !py-3 !text-[15px]">
                                {loading ? 'Salvando...' : 'Salvar Proxy'}
                            </IOSButton>
                        </div>
                        {error ? (<div className="p-3 bg-red-50 dark:bg-red-900/20 text-ios-red text-sm rounded-xl text-center">{error}</div>) : null}
                    </div>
                )}

                {/* ── Canal TikTok em edição: reconectar via OAuth + proxy ── */}
                {channel && platform === 'tiktok' && (
                    <div className="p-6 space-y-4 bg-ios-background/50">
                        <p className="text-sm text-ios-text-secondary">
                            Canais TikTok são gerenciados via OAuth. Para trocar a conta, desconecte e reconecte.
                        </p>
                        <IOSButton variant="primary" type="button" disabled={loading} onClick={startTiktokOAuth} className="w-full justify-center !py-3 !text-[15px]">
                            {loading ? 'Conectando…' : 'Reconectar TikTok'}
                        </IOSButton>
                        <div className="border-t border-ios-separator pt-4">
                            <div>
                                <label className="block text-[13px] font-medium text-ios-secondary mb-1.5 uppercase tracking-wide">Proxy (opcional)</label>
                                {proxyMasked && !proxyUrl ? (
                                    <div className="mb-1.5 px-3 py-2 rounded-xl bg-ios-separator/30 text-[12px] font-mono text-ios-secondary flex items-center justify-between">
                                        <span className="truncate">Salvo: {proxyMasked}</span>
                                        <button type="button" onClick={()=>{ setProxyMasked(null); setProxyUrl(''); }} className="ml-2 text-[11px] text-ios-red font-semibold shrink-0">Remover</button>
                                    </div>
                                ) : null}
                                <div className="flex gap-2">
                                    <input type="text" value={proxyUrl} onChange={(e)=>{ setProxyUrl(e.target.value); setProxyTestStatus('idle'); setProxyTestMsg(''); }} placeholder="http://user:pass@host:porta" className="flex-1 bg-ios-card border border-ios-separator rounded-xl px-4 py-3 text-[14px] font-mono focus:outline-none focus:border-ios-blue" />
                                    <button type="button" onClick={handleTestProxy} disabled={proxyTestStatus==='loading'} className="px-3 py-2 rounded-xl bg-ios-blue/10 text-ios-blue text-[13px] font-semibold hover:bg-ios-blue/20 disabled:opacity-50 shrink-0">{proxyTestStatus==='loading' ? 'Testando...' : 'Testar Proxy'}</button>
                                </div>
                                {proxyTestStatus!=='idle' && proxyTestMsg ? (<p className={`text-[12px] mt-1 ${proxyTestStatus==='ok'?'text-ios-green':'text-ios-red'}`}>{proxyTestMsg}</p>) : null}
                                <label className="flex items-center gap-2 mt-2 text-[13px] text-ios-secondary">
                                    <input type="checkbox" checked={proxyEnabled} onChange={(e)=>setProxyEnabled(e.target.checked)} className="rounded" />
                                    Proxy habilitado
                                </label>
                            </div>
                        </div>
                        <div className="flex gap-2">
                            <IOSButton variant="secondary" type="button" onClick={onClose} className="flex-1 justify-center !py-3 !text-[15px]">Fechar</IOSButton>
                            <IOSButton variant="primary" type="button" disabled={loading} onClick={saveProxyEdit} className="flex-1 justify-center !py-3 !text-[15px]">
                                {loading ? 'Salvando...' : 'Salvar Proxy'}
                            </IOSButton>
                        </div>
                        {error ? (<div className="p-3 bg-red-50 dark:bg-red-900/20 text-ios-red text-sm rounded-xl text-center">{error}</div>) : null}
                    </div>
                )}

                {/* ── Fluxo Instagram (criação OAuth + manual / edição) ──────── */}
                {platform === 'instagram' && (
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
                            {/* ── Proxy por canal (Instagram) ── */}
                            <div>
                                <label className="block text-[13px] font-medium text-ios-secondary mb-1.5 uppercase tracking-wide">
                                    Proxy (opcional)
                                </label>
                                {proxyMasked && !proxyUrl ? (
                                    <div className="mb-1.5 px-3 py-2 rounded-xl bg-ios-separator/30 text-[12px] font-mono text-ios-secondary flex items-center justify-between">
                                        <span className="truncate">Salvo: {proxyMasked}</span>
                                        <button type="button" onClick={()=>{ setProxyMasked(null); setProxyUrl(''); }} className="ml-2 text-[11px] text-ios-red font-semibold shrink-0">Remover</button>
                                    </div>
                                ) : null}
                                <div className="flex gap-2">
                                    <input
                                        type="text"
                                        value={proxyUrl}
                                        onChange={(e)=>{ setProxyUrl(e.target.value); setProxyTestStatus('idle'); setProxyTestMsg(''); }}
                                        placeholder="http://user:pass@host:porta"
                                        className="flex-1 bg-ios-card border border-ios-separator rounded-xl px-4 py-3 text-[14px] font-mono focus:outline-none focus:border-ios-blue focus:ring-1 focus:ring-ios-blue transition-all"
                                    />
                                    <button
                                        type="button"
                                        onClick={handleTestProxy}
                                        disabled={proxyTestStatus==='loading'}
                                        className="px-3 py-2 rounded-xl bg-ios-blue/10 text-ios-blue text-[13px] font-semibold hover:bg-ios-blue/20 disabled:opacity-50 shrink-0"
                                    >
                                        {proxyTestStatus==='loading' ? 'Testando...' : 'Testar Proxy'}
                                    </button>
                                </div>
                                <p className="text-[11px] text-ios-secondary mt-1 px-1">
                                    HTTP/HTTPS por canal, usado em Instagram Graph e YouTube API. Formato: <span className="font-mono">http://user:pass@host:porta</span>
                                </p>
                                {proxyTestStatus!=='idle' && proxyTestMsg ? (
                                    <p className={`text-[12px] mt-1 px-1 ${proxyTestStatus==='ok'?'text-ios-green':'text-ios-red'}`}>{proxyTestMsg}</p>
                                ) : null}
                                <label className="flex items-center gap-2 mt-2 text-[13px] text-ios-secondary">
                                    <input type="checkbox" checked={proxyEnabled} onChange={(e)=>setProxyEnabled(e.target.checked)} className="rounded" />
                                    Proxy habilitado
                                </label>
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
                )}
            </div>
        </div>
    );
}
