'use client';
import { useState, useEffect } from 'react';
import { X, Save, Edit2 } from 'lucide-react';
import IOSButton from './IOSButton';

interface ContentItem {
    id: string;
    name: string;
    title?: string;
    caption?: string;
    tags?: string[] | string;
    type: string;
}

/** Tags are stored as JSON string in DB; the API may return raw or normalized. */
function normalizeTags(raw: unknown): string[] {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw as string[];
    if (typeof raw === 'string') {
        try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }
    return [];
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
    const [tags, setTags] = useState<string[]>([]);
    const [tagInput, setTagInput] = useState('');

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
                setTags(normalizeTags(item.tags));
            }
        }
    }, [isOpen, itemsToEdit, isBulk]);

    const handleAddTag = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            const newTag = tagInput.trim();
            if (newTag && !tags.includes(newTag)) {
                setTags([...tags, newTag]);
            }
            setTagInput('');
        }
    };

    const removeTag = (tagToRemove: string) => {
        setTags(tags.filter(tag => tag !== tagToRemove));
    };

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
                if (tags.length > 0) updates.tags = tags;
            } else {
                updates.name = name;
                updates.title = title;
                updates.caption = caption;
                updates.tags = tags;
            }

            if (Object.keys(updates).length === 0) {
                onClose();
                return;
            }

            const ids = itemsToEdit.map(i => i.id);

            // Serialize tags as JSON string for Prisma
            const payload: any = { ...updates };
            if (payload.tags) payload.tags = JSON.stringify(payload.tags);

            for (const id of ids) {
                const res = await fetch(`/api/content-items/${id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                if (!res.ok) throw new Error('Failed to update item');
            }

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

                    <div>
                        <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1.5 uppercase tracking-wide">
                            Tags
                        </label>
                        <div className="w-full bg-gray-100 dark:bg-white/10 border-0 rounded-xl px-4 py-3 min-h-[50px] flex flex-wrap gap-2 items-center focus-within:ring-2 focus-within:ring-blue-500 transition-all">
                            {tags.map(tag => (
                                <span key={tag} className="bg-blue-500/10 text-blue-500 px-2 py-1 rounded-md text-sm flex items-center gap-1">
                                    {tag}
                                    <button onClick={() => removeTag(tag)} className="hover:text-blue-700">
                                        <X size={12} />
                                    </button>
                                </span>
                            ))}
                            <input
                                type="text"
                                value={tagInput}
                                onChange={(e) => setTagInput(e.target.value)}
                                onKeyDown={handleAddTag}
                                className="bg-transparent border-none outline-none flex-1 min-w-[100px] text-[15px] text-gray-900 dark:text-white placeholder-gray-400"
                                placeholder={tags.length === 0 ? "Add tags (press Enter)..." : ""}
                            />
                        </div>
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
