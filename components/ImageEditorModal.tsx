import React, { useState, useRef, useEffect, useCallback } from 'react';
import Cropper from 'react-easy-crop';
import * as fabric from 'fabric'; // Changed to namespace import
import { X, Check, Type, Pen, Crop, Undo, Redo, ZoomIn, ZoomOut, Move } from 'lucide-react';
import { getCroppedImg } from '@/lib/utils'; // Keep as is, should be correct relative path

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
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const fabricCanvasRef = useRef<fabric.Canvas | null>(null);
    const [isFabricReady, setIsFabricReady] = useState(false);

    // History for undo/redo (Fabric)
    const [history, setHistory] = useState<string[]>([]);
    const [historyIndex, setHistoryIndex] = useState(-1);

    // Temp image for cropping phase
    const [currentImage, setCurrentImage] = useState(imageUrl);

    // Reset when modal opens
    useEffect(() => {
        if (isOpen) {
            setCurrentImage(imageUrl);
            setAspect(initialAspectRatio);
            setActiveTool('crop');
            // Reset history
            setHistory([]);
            setHistoryIndex(-1);
        }
    }, [isOpen, imageUrl, initialAspectRatio]);

    const onCropComplete = useCallback((croppedArea: any, croppedAreaPixels: any) => {
        setCroppedAreaPixels(croppedAreaPixels);
    }, []);

    // Initialize Fabric when switching to draw/text tools
    useEffect(() => {
        const initFabric = async () => {
            if (activeTool !== 'crop' && !fabricCanvasRef.current && canvasRef.current) {
                const canvas = new fabric.Canvas(canvasRef.current, {
                    width: 500,
                    height: 500,
                });
                fabricCanvasRef.current = canvas;

                try {
                    // Load the current image (which might be the result of a crop) onto the canvas
                    // Fabric v6 returns a Promise for fromURL
                    const img = await fabric.Image.fromURL(currentImage);
                    if (!img) return;

                    // Scale image to fit canvas or adjust canvas to fit image
                    // For simplicity, let's adjust canvas to match image dimensions

                    const width = img.width || 500;
                    const height = img.height || 500;

                    canvas.setDimensions({ width, height });

                    canvas.backgroundImage = img;
                    canvas.renderAll();

                    setIsFabricReady(true);
                    saveHistory(canvas);

                } catch (err) {
                    console.error("Error loading image into Fabric:", err);
                }

                canvas.on('object:added', () => saveHistory(canvas));
                canvas.on('object:modified', () => saveHistory(canvas));
            }
        };

        initFabric();

        return () => {
            // Cleanup handled in main unmount if needed
        };
    }, [activeTool, currentImage]);

    // Handle tool switching effects on Fabric
    useEffect(() => {
        if (!fabricCanvasRef.current) return;
        const canvas = fabricCanvasRef.current;

        canvas.isDrawingMode = activeTool === 'draw';
        if (activeTool === 'draw') {
            // Ensure freeDrawingBrush exists
            const brush = canvas.freeDrawingBrush;
            if (brush) {
                brush.width = 5;
                brush.color = '#FF0000'; // Default red
            }
        }
    }, [activeTool]);

    const saveHistory = (canvas: fabric.Canvas) => {
        const json = JSON.stringify(canvas.toJSON());
        setHistory(prev => {
            const newHistory = prev.slice(0, historyIndex + 1);
            newHistory.push(json);
            return newHistory;
        });
        setHistoryIndex(prev => prev + 1);
    };

    // Fix handleUndo signature or usage if needed
    const handleUndo = async () => {
        if (historyIndex > 0 && fabricCanvasRef.current) {
            const newIndex = historyIndex - 1;
            setHistoryIndex(newIndex);

            try {
                await fabricCanvasRef.current.loadFromJSON(JSON.parse(history[newIndex]));
                fabricCanvasRef.current.renderAll();
            } catch (err) {
                console.error("Undo failed", err);
            }
        }
    };

    const handleApplyCrop = async () => {
        try {
            const croppedImage = await getCroppedImg(currentImage, croppedAreaPixels);
            if (croppedImage) {
                setCurrentImage(croppedImage);
                setActiveTool('move'); // Switch to editor mode

                // Nuke the fabric canvas so it re-initializes with new image
                if (fabricCanvasRef.current) {
                    fabricCanvasRef.current.dispose();
                    fabricCanvasRef.current = null;
                }
            }
        } catch (e) {
            console.error('Crop failed', e);
        }
    };

    const handleAddText = async () => {
        if (fabricCanvasRef.current) {
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
    };

    const handleSave = () => {
        if (activeTool === 'crop') {
            // If actively cropping, apply crop first then save? Or just save current view?
            // Usually users expect "Done" to mean "Apply Crop & Save"
            handleApplyCrop().then(() => {
                // The handleApplyCrop updates currentImage, but it's async state. 
                // We might need a ref or effect. For now, let's assume specific "Apply" button is used for crop.

                // If we are just cropping and haven't initialized fabric, currentImage is mostly fine but we need the crop result.
                // If we want to save the final result:
                // If activeTool is crop, we assume the user is happy with the crop OR they should have clicked 'Apply'.
                // Let's force apply crop if in crop mode?
                // Or better: Use the canvas output.

                // NOTE: If we are in crop mode, we haven't 'applied' it to a canvas yet.
                // We should probably prompt to apply or better yet, just return the cropped image.
            });
        }

        // If we have a fabric canvas, export it
        if (fabricCanvasRef.current) {
            const dataUrl = fabricCanvasRef.current.toDataURL({
                format: 'png',
                quality: 0.9,
                multiplier: 1,
            });
            onSave(dataUrl);
            onClose();
        } else if (activeTool === 'crop' && croppedAreaPixels) {
            // Only crop was done
            getCroppedImg(currentImage, croppedAreaPixels).then(img => {
                if (img) {
                    onSave(img);
                    onClose();
                }
            });
        }
    };

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
                            <canvas ref={canvasRef} />
                        </div>
                    )}
                </div>

                {/* Footer Toolbar */}
                <div className="h-20 bg-black/50 backdrop-blur-md border-t border-white/10 flex items-center justify-center gap-8 pb-4">
                    <button
                        onClick={() => setActiveTool('crop')}
                        className={`flex flex-col items-center gap-1 ${activeTool === 'crop' ? 'text-ios-blue' : 'text-white/60 hover:text-white'}`}
                    >
                        <div className={`p-2 rounded-xl ${activeTool === 'crop' ? 'bg-white/10' : ''}`}>
                            <Crop size={24} />
                        </div>
                        <span className="text-[10px] font-medium">Crop</span>
                    </button>

                    <button
                        onClick={() => { setActiveTool('draw'); }}
                        className={`flex flex-col items-center gap-1 ${activeTool === 'draw' ? 'text-ios-blue' : 'text-white/60 hover:text-white'}`}
                    >
                        <div className={`p-2 rounded-xl ${activeTool === 'draw' ? 'bg-white/10' : ''}`}>
                            <Pen size={24} />
                        </div>
                        <span className="text-[10px] font-medium">Draw</span>
                    </button>

                    <button
                        onClick={() => { setActiveTool('text'); handleAddText(); }}
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

