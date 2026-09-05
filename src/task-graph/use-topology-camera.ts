import { useLayoutEffect, useRef, useState, type RefObject } from "react";

interface Dimensions { width: number; height: number }
interface Camera extends Dimensions { scale: number; offsetX: number; offsetY: number; stageWidth: number; stageHeight: number }
type Zoom = "readable" | "fit" | number;
const PADDING = 24;

export function fitTopologyCamera(scene: Dimensions, viewport: Dimensions, zoom: Zoom = "readable") {
  const measured = viewport.width > 0 && viewport.height > 0;
  const fit = measured ? Math.min(
    Math.max(1, viewport.width - PADDING * 2) / scene.width,
    Math.max(1, viewport.height - PADDING * 2) / scene.height,
    1.25,
  ) : 1;
  const scale = typeof zoom === "number" ? zoom : zoom === "fit" ? fit : Math.max(1, fit);
  const scaledWidth = scene.width * scale;
  const scaledHeight = scene.height * scale;
  const stageWidth = Math.max(viewport.width, scaledWidth + PADDING * 2);
  const stageHeight = Math.max(viewport.height, scaledHeight + PADDING * 2);
  return {
    scale, stageWidth, stageHeight,
    offsetX: (stageWidth - scaledWidth) / 2,
    offsetY: (stageHeight - scaledHeight) / 2,
  };
}

export function useTopologyCamera(ref: RefObject<HTMLDivElement | null>, scene: Dimensions) {
  const [viewport, setViewport] = useState<Dimensions>({ width: 0, height: 0 });
  const [zoom, setZoom] = useState<Zoom>("readable");
  const previous = useRef<Camera | null>(null);
  const camera = fitTopologyCamera(scene, viewport, zoom);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => {
      const next = { width: element.clientWidth, height: element.clientHeight };
      setViewport((current) => current.width === next.width && current.height === next.height ? current : next);
    };
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(element);
    window.addEventListener("resize", update);
    return () => { observer?.disconnect(); window.removeEventListener("resize", update); };
  }, [ref]);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !viewport.width || !viewport.height) return;
    const old = previous.current;
    if (zoom === "fit") {
      element.scrollLeft = 0;
      element.scrollTop = 0;
    } else if (old) {
      // Keep the same point under the viewport center when zooming or resizing.
      const x = (element.scrollLeft + old.width / 2 - old.offsetX) / old.scale;
      const y = (element.scrollTop + old.height / 2 - old.offsetY) / old.scale;
      element.scrollLeft = x * camera.scale + camera.offsetX - viewport.width / 2;
      element.scrollTop = y * camera.scale + camera.offsetY - viewport.height / 2;
    } else {
      element.scrollTop = (camera.stageHeight - viewport.height) / 2;
    }
    previous.current = { ...camera, ...viewport };
  }, [ref, camera.scale, camera.offsetX, camera.offsetY, camera.stageWidth, camera.stageHeight, viewport.width, viewport.height, zoom]);

  return { camera, zoom, setZoom, zoomBy: (amount: number) => setZoom(Math.min(2, Math.max(0.1, Math.round((camera.scale + amount) * 100) / 100))) };
}
