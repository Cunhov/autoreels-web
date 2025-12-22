import { CheckCircle, XCircle, AlertCircle } from 'lucide-react';
import { useEffect, useState } from 'react';

export type ToastType = 'success' | 'error' | 'info';

interface IOSToastProps {
    message: string;
    type?: ToastType;
    isVisible: boolean;
    onClose: () => void;
    duration?: number;
}

export default function IOSToast({ message, type = 'success', isVisible, onClose, duration = 3000 }: IOSToastProps) {
    const [show, setShow] = useState(isVisible);

    useEffect(() => {
        setShow(isVisible);
        if (isVisible) {
            const timer = setTimeout(() => {
                setShow(false);
                setTimeout(onClose, 300); // Wait for animation
            }, duration);
            return () => clearTimeout(timer);
        }
    }, [isVisible, duration, onClose]);

    if (!isVisible && !show) return null;

    const bgColor = type === 'success' ? 'bg-green-500' : type === 'error' ? 'bg-red-500' : 'bg-ios-text';
    const Icon = type === 'success' ? CheckCircle : type === 'error' ? XCircle : AlertCircle;

    return (
        <div
            className={`fixed top-6 left-1/2 -translate-x-1/2 z-[100] flex items-center gap-3 px-4 py-3 rounded-full shadow-lg transition-all duration-300 ${show ? 'translate-y-0 opacity-100' : '-translate-y-8 opacity-0'} backdrop-blur-md bg-white/90 dark:bg-zinc-800/90 border border-black/5 dark:border-white/10`}
        >
            <div className={`${bgColor} rounded-full p-1`}>
                <Icon size={16} className="text-white" strokeWidth={3} />
            </div>
            <p className="text-sm font-medium text-ios-text pr-2">{message}</p>
        </div>
    );
}
