import React, { useEffect, useRef } from 'react';
import * as fabric from 'fabric';

interface FabricCanvasProps {
    imageUrl: string;
    activeTool: 'crop' | 'draw' | 'text' | 'move';
    onReady: (canvas: fabric.Canvas) => void;
    onObjectModified?: (canvas: fabric.Canvas) => void;
}

export default function FabricCanvas({ imageUrl, activeTool, onReady, onObjectModified }: FabricCanvasProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const fabricCanvasRef = useRef<fabric.Canvas | null>(null);

    // Keep the latest callbacks in refs so the setup effect (which runs only
    // when imageUrl changes) never captures a stale closure from the first render.
    const onReadyRef = useRef(onReady);
    const onObjectModifiedRef = useRef(onObjectModified);
    useEffect(() => { onReadyRef.current = onReady; }, [onReady]);
    useEffect(() => { onObjectModifiedRef.current = onObjectModified; }, [onObjectModified]);

    // Initial setup
    useEffect(() => {
        if (!canvasRef.current) return;

        // Create canvas
        const canvas = new fabric.Canvas(canvasRef.current, {
            width: 500,
            height: 500,
        });
        fabricCanvasRef.current = canvas;

        // Load image
        const initImage = async () => {
            try {
                const img = await fabric.Image.fromURL(imageUrl, { crossOrigin: 'anonymous' });
                if (!img) return;

                const width = img.width || 500;
                const height = img.height || 500;
                canvas.setDimensions({ width, height });
                canvas.backgroundImage = img;
                canvas.renderAll();
                // Notify parent
                onReadyRef.current(canvas);
            } catch (error) {
                console.error("Failed to load fabric image", error);
            }
        };
        initImage();

        // Event listeners
        const handleModification = () => {
            if (onObjectModifiedRef.current) onObjectModifiedRef.current(canvas);
        };
        canvas.on('object:added', handleModification);
        canvas.on('object:modified', handleModification);

        // Cleanup
        return () => {
            canvas.off('object:added', handleModification);
            canvas.off('object:modified', handleModification);
            canvas.dispose();
            fabricCanvasRef.current = null;
        };
    }, [imageUrl]); // Re-init if image URL changes (e.g. after crop)

    // Handle tool changes without destroying canvas
    useEffect(() => {
        const canvas = fabricCanvasRef.current;
        if (!canvas) return;

        canvas.isDrawingMode = activeTool === 'draw';
        if (activeTool === 'draw') {
            const brush = canvas.freeDrawingBrush;
            if (brush) {
                brush.width = 5;
                brush.color = '#FF0000';
            }
        }
    }, [activeTool]);

    return <canvas ref={canvasRef} />;
}
