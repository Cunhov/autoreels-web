'use client';
import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import { X, Save, Edit2 } from 'lucide-react';
import IOSButton from './IOSButton';

interface ContentItem {
    id: string;
    name: string;
    title?: string;
    caption?: string;
    type: string;
}

interface EditContentModalProps {
    isOpen: boolean;
    onClose: () => void;
    itemsToEdit: ContentItem[];
    onEditComplete: () => void;
}

export default function EditContentModal({
    isOpen,
    onClose,
    itemsToEdit,
    onEditComplete
}: EditContentModalProps) {
    const [loading, setLoading] = useState(false);

    // Form states
    const [name, setName] = useState('');
    const [title, setTitle] = useState('');
    const [caption, setCaption] = useState('');

    const isBulk = itemsToEdit.length > 1;

    useEffect(() => {
        if (isOpen && itemsToEdit.length > 0) {
            if (isBulk) {
                // Clear inputs for bulk edit or leave empty to "keep existing"
                setName('');
                setTitle('');
                setCaption('');
            } else {
                // Single item - prefill
                const item = itemsToEdit[0];
                setName(item.name || '');
                setTitle(item.title || '');
                setCaption(item.caption || '');
            }
        }
    }, [isOpen, itemsToEdit, isBulk]);

    const handleSave = async () => {
        setLoading(true);
        try {
            const updates: any = {};

            // For Bulk Edit: Only update fields that have content? 
            // Or does the user want to clear them? 
            // Usually in bulk edit, you only update what you change.
            // Let's assume non-empty string means update. 
            // If user wants to clear, maybe they type a space? 
            // For now, let's say if (value) update it. 
            // Except for 'Name' - usually we don't bulk edit name to be identical, unless requested.
            // But let's allow it if they really want.

            if (isBulk) {
                if (title) updates.title = title;
                if (caption) updates.caption = caption;
                // Typically avoid bulk renaming to same name unless intended.
            } else {
                updates.name = name;
                updates.title = title;
                updates.caption = caption;
            }

            if (Object.keys(updates).length === 0) {
                onClose();
                return;
            }

            const ids = itemsToEdit.map(i => i.id);
            const { error } = await supabase
                .from('content_items')
                .update(updates)
                .in('id', ids);

            if (error) throw error;

            onEditComplete();
            onClose();
        } catch (error) {
            console.error('Error updating items:', error);
            alert('Failed to update items');
        } finally {
            setLoading(false);
        }
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-in fade-in duration-200">
            <div className="bg-white dark:bg-[#1C1C1E] w-full max-w-md rounded-2xl overflow-hidden shadow-2xl flex flex-col scale-100 animate-in zoom-in-95 duration-200">
                {/* Header */}
                <div className="px-5 py-4 border-b border-gray-100 dark:border-white/10 flex items-center justify-between bg-white/50 dark:bg-white/5 backdrop-blur-md">
                    <div>
                        <h2 className="text-[17px] font-semibold text-gray-900 dark:text-white">
                            {isBulk ? `Edit ${itemsToEdit.length} Items` : 'Edit Item'}
                        </h2>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-1 rounded-full hover:bg-black/5 dark:hover:bg-white/10 text-gray-500 transition-colors"
                    >
                        <X size={20} />
                    </button>
                </div>

                {/* Content */}
                <div className="p-6 space-y-4">
                    {!isBulk && (
                        <div>
                            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1.5 uppercase tracking-wide">
                                Name
                            </label>
                            <input
                                type="text"
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                className="w-full bg-gray-100 dark:bg-white/10 border-0 rounded-xl px-4 py-3 text-[17px] text-gray-900 dark:text-white placeholder-gray-400 focus:ring-2 focus:ring-blue-500 focus:outline-none transition-all"
                                placeholder="Item name"
                            />
                        </div>
                    )}

                    <div>
                        <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1.5 uppercase tracking-wide">
                            Title <span className="text-gray-400 lowercase font-normal">(optional)</span>
                        </label>
                        <input
                            type="text"
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            className="w-full bg-gray-100 dark:bg-white/10 border-0 rounded-xl px-4 py-3 text-[17px] text-gray-900 dark:text-white placeholder-gray-400 focus:ring-2 focus:ring-blue-500 focus:outline-none transition-all"
                            placeholder={isBulk ? "Leave empty to keep existing" : "Post Title"}
                        />
                    </div>

                    <div>
                        <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1.5 uppercase tracking-wide">
                            Caption <span className="text-gray-400 lowercase font-normal">(optional)</span>
                        </label>
                        <textarea
                            value={caption}
                            onChange={(e) => setCaption(e.target.value)}
                            rows={4}
                            className="w-full bg-gray-100 dark:bg-white/10 border-0 rounded-xl px-4 py-3 text-[17px] text-gray-900 dark:text-white placeholder-gray-400 focus:ring-2 focus:ring-blue-500 focus:outline-none resize-none transition-all"
                            placeholder={isBulk ? "Leave empty to keep existing" : "Write a caption..."}
                        />
                    </div>
                </div>

                {/* Footer */}
                <div className="p-4 border-t border-gray-100 dark:border-white/10 bg-gray-50 dark:bg-white/5 flex gap-3">
                    <IOSButton
                        variant="secondary"
                        onClick={onClose}
                        className="flex-1 justify-center"
                        disabled={loading}
                    >
                        Cancel
                    </IOSButton>
                    <IOSButton
                        variant="primary"
                        onClick={handleSave}
                        className="flex-1 justify-center"
                        disabled={loading}
                    >
                        {loading ? 'Saving...' : 'Save Changes'}
                    </IOSButton>
                </div>
            </div>
        </div>
    );
}
