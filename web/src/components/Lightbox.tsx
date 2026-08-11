import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { PiFrameCorners, PiMinus, PiPlus, PiX } from "react-icons/pi";

const MIN_SCALE = 0.1;
const MAX_SCALE = 8;
/** "fit" never upscales beyond natural size — diagrams stay at authored
 *  proportions and raster images never get blurry. Zoom in manually for more. */
const FIT_MAX = 1;
const PAD = 36;

interface View {
  x: number;
  y: number;
  s: number;
}

/** Fullscreen pan/zoom viewer used by flowcharts and images.
 *
 *  Zoom is *not* applied as a CSS transform on the stage — that rasterizes
 *  the content once at its layout size and scales the bitmap (pixelated text
 *  when zoomed). Instead the stage only translates, and `children` receives
 *  the scale so vector content re-renders at `natural × scale` pixels. SVG
 *  text stays crisp at any zoom; raster images stay crisp up to 100%.
 */
export default function Lightbox({
  open,
  onClose,
  label,
  contentW,
  contentH,
  children,
}: {
  open: boolean;
  onClose: () => void;
  label?: string;
  /** natural pixel size of the content; omit until known (images load async) */
  contentW?: number;
  contentH?: number;
  /** renders the content at the given scale (content must size itself) */
  children: (scale: number) => ReactNode;
}) {
  const [view, setView] = useState<View>({ x: 0, y: 0, s: 1 });
  const boxRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number } | null>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);

  const fit = useCallback(() => {
    const el = boxRef.current;
    if (!el || !contentW || !contentH) return;
    const vw = el.clientWidth;
    const vh = el.clientHeight;
    const s = Math.min((vw - PAD) / contentW, (vh - PAD) / contentH, FIT_MAX);
    setView({ s, x: (vw - contentW * s) / 2, y: (vh - contentH * s) / 2 });
  }, [contentW, contentH]);

  // fit on open, and re-fit when the content size becomes known (image loads)
  useLayoutEffect(() => {
    if (!open) return;
    fit();
    closeRef.current?.focus();
  }, [open, fit]);

  // lock body scroll while the overlay is open
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  const zoomAt = useCallback((cx: number, cy: number, factor: number) => {
    setView((v) => {
      const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.s * factor));
      const wx = (cx - v.x) / v.s;
      const wy = (cy - v.y) / v.s;
      return { s, x: cx - wx * s, y: cy - wy * s };
    });
  }, []);

  // wheel zoom — native listener so preventDefault works (React wheel is passive)
  useEffect(() => {
    if (!open) return;
    const el = boxRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.12 : 1 / 1.12);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [open, zoomAt]);

  // keyboard: Escape closes, +/-/0 zoom
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "+" || e.key === "=") zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1.25);
      else if (e.key === "-") zoomAt(window.innerWidth / 2, window.innerHeight / 2, 0.8);
      else if (e.key === "0") fit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, zoomAt, fit, onClose]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // ignore drags that start on controls/close — they keep their own clicks
    if ((e.target as HTMLElement).closest(".lightbox-controls, .lightbox-close")) return;
    boxRef.current?.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y) };
      drag.current = null;
    } else {
      drag.current = { x: e.clientX, y: e.clientY };
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = pointers.current.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const el = boxRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (pointers.current.size === 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const midX = (a.x + b.x) / 2 - r.left;
      const midY = (a.y + b.y) / 2 - r.top;
      zoomAt(midX, midY, dist / pinch.current.dist);
      pinch.current.dist = dist;
    } else if (drag.current && pointers.current.size === 1) {
      setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (pointers.current.size === 0) drag.current = null;
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = boxRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    zoomAt(e.clientX - r.left, e.clientY - r.top, 2);
  };

  if (!open) return null;

  return (
    <div
      className="lightbox"
      ref={boxRef}
      role="dialog"
      aria-modal="true"
      aria-label={label ?? "fullscreen viewer"}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
    >
      {label && <div className="lightbox-label">{label}</div>}
      <div
        className="lightbox-stage"
        style={{ transform: `translate(${view.x}px, ${view.y}px)` }}
      >
        {children(view.s)}
      </div>
      <div className="lightbox-controls">
        <button
          className="lightbox-zoom-btn"
          onClick={() => zoomAt(window.innerWidth / 2, window.innerHeight / 2, 0.8)}
          aria-label="zoom out"
          title="zoom out"
        >
          <PiMinus size={15} />
        </button>
        <span className="lightbox-scale">{Math.round(view.s * 100)}%</span>
        <button
          className="lightbox-zoom-btn"
          onClick={() => zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1.25)}
          aria-label="zoom in"
          title="zoom in"
        >
          <PiPlus size={15} />
        </button>
        <span className="lightbox-ctrl-divider" />
        <button
          className="lightbox-zoom-btn"
          onClick={fit}
          aria-label="fit to screen"
          title="fit to screen"
        >
          <PiFrameCorners size={15} />
        </button>
      </div>
      <button
        className="lightbox-close"
        ref={closeRef}
        onClick={onClose}
        aria-label="close fullscreen"
      >
        <PiX size={18} />
      </button>
    </div>
  );
}
