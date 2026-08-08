import React, { useState, useRef, useEffect, useCallback } from 'react';
import Cropper from 'react-easy-crop';
import * as fabric from 'fabric';
import { X, Check, Type, Pen, Crop, Undo, Redo, ZoomIn, ZoomOut, Move } from 'lucide-react';
import { getCroppedImg } from '@/lib/utils';
import FabricCanvas from './FabricCanvas';

interface ImageEditorModalProps {
    imageUrl: string;
    isOpen: boolean;
    onClose: () => void;
    onSave: (editedImageUrl: string) => void;
    initialAspectRatio?: number; // 1, 4/3, 16/9, etc.
}

type EditorTool = 'crop' | 'draw' | 'text' | 'move';

export default function ImageEditorModal({ imageUrl, isOpen, onClose, onSave, initialAspectRatio = 1 }: ImageEditorModalProps) {
    const [crop, setCrop] = useState({ x: 0, y: 0 });
    const [zoom, setZoom] = useState(1);
    const [aspect, setAspect] = useState(initialAspectRatio);
    const [croppedAreaPixels, setCroppedAreaPixels] = useState<any>(null);
    const [activeTool, setActiveTool] = useState<EditorTool>('crop');

    // Fabric state
    const fabricCanvasRef = useRef<fabric.Canvas | null>(null);
    const [isFabricReady, setIsFabricReady] = useState(false);

    // History for undo/redo (Fabric)
    const [history, setHistory] = useState<string[]>([]);
    const [historyIndex, setHistoryIndex] = useState(-1);
    // Mirror of historyIndex that is safe to read inside stable callbacks
    // (avoids stale-closure bugs where saveHistory captured the first render's index)
    const historyIndexRef = useRef(-1);

    // Temp image for cropping phase
    const [currentImage, setCurrentImage] = useState(imageUrl);

    // Reset when modal opens
    useEffect(() => {
        if (isOpen) {
            setCurrentImage(imageUrl);
            setAspect(initialAspectRatio);
            setActiveTool('crop');
            // Reset crop state so a previous session's crop can't be re-applied
            setCrop({ x: 0, y: 0 });
            setZoom(1);
            setCroppedAreaPixels(null);
            // Reset history
            setHistory([]);
            historyIndexRef.current = -1;
            setHistoryIndex(-1);
        }
    }, [isOpen, imageUrl, initialAspectRatio]);

    const onCropComplete = useCallback((croppedArea: any, croppedAreaPixels: any) => {
        setCroppedAreaPixels(croppedAreaPixels);
    }, []);

    // Stable callback: always reads/writes historyIndexRef.current instead of a
    // captured state value, so FabricCanvas (which registers the callback once)
    // never gets a stale closure.
    const saveHistory = useCallback((canvas: fabric.Canvas) => {
        const json = JSON.stringify(canvas.toJSON());
        setHistory(prev => [...prev.slice(0, historyIndexRef.current + 1), json]);
        historyIndexRef.current += 1;
        setHistoryIndex(historyIndexRef.current);
    }, []);

    const handleUndo = useCallback(async () => {
        const idx = historyIndexRef.current;
        if (idx > 0 && fabricCanvasRef.current) {
            const newIndex = idx - 1;
            historyIndexRef.current = newIndex;
            setHistoryIndex(newIndex);

            try {
                await fabricCanvasRef.current.loadFromJSON(JSON.parse(history[newIndex]));
                fabricCanvasRef.current.renderAll();
            } catch (err) {
                console.error("Undo failed", err);
            }
        }
    }, [history]);

    // Fabric initialization and tool switching handled in FabricCanvas component
    // We just need to capture the ref when it's ready
    const onFabricReady = useCallback((canvas: fabric.Canvas) => {
        fabricCanvasRef.current = canvas;
        setIsFabricReady(true);
        saveHistory(canvas);
    }, [saveHistory]);

    /**
     * Apply the pending crop.
     * Returns the cropped image data URL (or null if there is nothing to apply).
     * State updates are async, so callers must use the RETURN VALUE — never the
     * re-rendered canvas/currentImage — to read the cropped result.
     */
    const handleApplyCrop = useCallback(async (): Promise<string | null> => {
        if (!croppedAreaPixels) return null;
        try {
            const croppedImage = await getCroppedImg(currentImage, croppedAreaPixels);
            if (croppedImage) {
                setCurrentImage(croppedImage);
                setActiveTool('move'); // Switch to editor mode

                // Nuke the fabric canvas so it re-initializes with the new image.
                // In crop mode the FabricCanvas is unmounted and its cleanup already
                // disposed it — guard against double-dispose and stale refs.
                const prev = fabricCanvasRef.current;
                fabricCanvasRef.current = null;
                if (prev && !prev.disposed) {
                    prev.dispose().catch(() => { /* already disposed */ });
                }

                // Reset history: the next canvas init (new image) will push a
                // fresh initial state at index 0, so undo never crosses images.
                setHistory([]);
                historyIndexRef.current = -1;
                setHistoryIndex(-1);

                // The pending crop is now applied — clear it so it can never be
                // re-applied on top of the already-cropped image (double-crop).
                setCroppedAreaPixels(null);
                return croppedImage;
            }
        } catch (e) {
            console.error('Crop failed', e);
        }
        return null;
    }, [croppedAreaPixels, currentImage]);

    const handleAddText = useCallback(() => {
        if (fabricCanvasRef.current && !fabricCanvasRef.current.disposed) {
            const text = new fabric.IText('Tap to edit', {
                left: 100,
                top: 100,
                fill: '#ffffff',
                fontSize: 40,
                stroke: '#000000',
                strokeWidth: 1,
            });
            fabricCanvasRef.current.add(text);
            fabricCanvasRef.current.setActiveObject(text);
            setActiveTool('text');
        }
    }, []);

    /**
     * Switch editor tool, applying any pending crop BEFORE leaving the crop tool
     * so the Fabric canvas always mounts with the cropped image (not the original).
     */
    const switchTool = useCallback(async (tool: EditorTool) => {
        if (tool === activeTool) return;
        if (activeTool === 'crop' && tool !== 'crop' && croppedAreaPixels) {
            await handleApplyCrop();
        }
        setActiveTool(tool);
        if (tool === 'text') {
            handleAddText();
        }
    }, [activeTool, croppedAreaPixels, handleApplyCrop, handleAddText]);

    const handleSave = useCallback(async () => {
        let result: string | null = null;

        if (activeTool === 'crop') {
            // Apply any pending crop so the saved image includes it. handleApplyCrop
            // returns the cropped data URL directly (state is async, so we can't
            // rely on the re-rendered canvas/currentImage yet).
            result = await handleApplyCrop();
            if (!result) {
                // No crop area was set — export the current image as-is.
                result = currentImage;
            }
            if (result) {
                onSave(result);
                onClose();
            }
            return;
        }

        // Editor mode: export the live Fabric canvas (draw/text edits).
        if (fabricCanvasRef.current && !fabricCanvasRef.current.disposed) {
            try {
                result = fabricCanvasRef.current.toDataURL({
                    format: 'png',
                    quality: 0.9,
                    multiplier: 1,
                });
            } catch (e) {
                console.error('Canvas export failed', e);
                result = null;
            }
        }
        if (!result) result = currentImage;

        if (result) {
            onSave(result);
            onClose();
        }
    }, [activeTool, currentImage, handleApplyCrop, onSave, onClose]);

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 animate-in fade-in duration-200">
            {/* Main Editor Area */}
            <div className="relative w-full h-full flex flex-col">

                {/* Header */}
                <div className="h-16 flex items-center justify-between px-4 bg-black/50 backdrop-blur-md border-b border-white/10 z-10">
                    <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-full transition-colors">
                        <X className="text-white" />
                    </button>
                    <div className="flex gap-4">
                        <button
                            onClick={handleUndo}
                            disabled={historyIndex <= 0}
                            className={`p-2 rounded-full transition-colors ${historyIndex > 0 ? 'hover:bg-white/10 text-white' : 'text-white/30 cursor-not-allowed'}`}
                        >
                            <Undo size={20} />
                        </button>
                        {/* Redo could be added */}
                    </div>
                    <button onClick={handleSave} className="px-4 py-2 bg-white text-black font-semibold rounded-full hover:bg-gray-200 transition-colors">
                        Save
                    </button>
                </div>

                {/* Workspace */}
                <div className="flex-1 relative bg-[#0f0f0f] flex items-center justify-center overflow-hidden">
                    {activeTool === 'crop' ? (
                        <div className="relative w-full h-full max-w-4xl max-h-[80vh]">
                            <Cropper
                                image={currentImage}
                                crop={crop}
                                zoom={zoom}
                                aspect={aspect}
                                onCropChange={setCrop}
                                onCropComplete={onCropComplete}
                                onZoomChange={setZoom}
                                style={{
                                    containerStyle: { background: '#0f0f0f' },
                                    mediaStyle: {} // fit containment typically handled by default
                                }}
                            />
                            {/* Floating Toolbar for Crop */}
                            <div className="absolute bottom-6 left-1/2 transform -translate-x-1/2 flex gap-4 bg-black/70 backdrop-blur px-4 py-2 rounded-full">
                                <button className="text-xs text-white p-2 hover:text-ios-blue" onClick={() => setAspect(1)}>1:1</button>
                                <button className="text-xs text-white p-2 hover:text-ios-blue" onClick={() => setAspect(4 / 5)}>4:5</button>
                                <button className="text-xs text-white p-2 hover:text-ios-blue" onClick={() => setAspect(16 / 9)}>16:9</button>
                                <button className="text-xs font-bold text-ios-blue p-2 bg-white/10 rounded ml-2" onClick={handleApplyCrop}>Apply Crop</button>
                            </div>
                        </div>
                    ) : (
                        <div className="w-full h-full flex items-center justify-center p-4">
                            <FabricCanvas
                                imageUrl={currentImage}
                                activeTool={activeTool}
                                onReady={onFabricReady}
                                onObjectModified={(canvas) => saveHistory(canvas)}
                            />
                        </div>
                    )}
                </div>

                {/* Footer Toolbar */}
                <div className="h-20 bg-black/50 backdrop-blur-md border-t border-white/10 flex items-center justify-center gap-8 pb-4">
                    <button
                        onClick={() => switchTool('crop')}
                        className={`flex flex-col items-center gap-1 ${activeTool === 'crop' ? 'text-ios-blue' : 'text-white/60 hover:text-white'}`}
                    >
                        <div className={`p-2 rounded-xl ${activeTool === 'crop' ? 'bg-white/10' : ''}`}>
                            <Crop size={24} />
                        </div>
                        <span className="text-[10px] font-medium">Crop</span>
                    </button>

                    <button
                        onClick={() => switchTool('draw')}
                        className={`flex flex-col items-center gap-1 ${activeTool === 'draw' ? 'text-ios-blue' : 'text-white/60 hover:text-white'}`}
                    >
                        <div className={`p-2 rounded-xl ${activeTool === 'draw' ? 'bg-white/10' : ''}`}>
                            <Pen size={24} />
                        </div>
                        <span className="text-[10px] font-medium">Draw</span>
                    </button>

                    <button
                        onClick={() => switchTool('text')}
                        className={`flex flex-col items-center gap-1 ${activeTool === 'text' ? 'text-ios-blue' : 'text-white/60 hover:text-white'}`}
                    >
                        <div className={`p-2 rounded-xl ${activeTool === 'text' ? 'bg-white/10' : ''}`}>
                            <Type size={24} />
                        </div>
                        <span className="text-[10px] font-medium">Text</span>
                    </button>
                </div>
            </div>
        </div>
    );
}

