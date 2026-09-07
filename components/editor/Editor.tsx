'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Brush,
  Download,
  Eye,
  ImagePlus,
  Minus,
  MousePointer2,
  Plus,
  Redo2,
  Scissors,
  ShieldCheck,
  Undo2,
  Upload,
  WandSparkles,
  X,
} from 'lucide-react';
import { CancelledError, ModelClient } from '@/lib/engine/client';
import type { Point, ProgressInfo } from '@/lib/engine/types';
import { MaskHistory } from '@/lib/mask/history';
import {
  applyScaledMask,
  boundsOf,
  clampRect,
  extract,
  fillPolygon,
  strokeSegment,
  unionRect,
  type Mask,
  type Rect,
} from '@/lib/mask/ops';
import {
  type Background,
  type ExportFormat,
  MAX_PIXELS_DESKTOP,
  MAX_PIXELS_MOBILE,
  MODEL_SIDE,
  baseName,
  downloadBlob,
  exportImage,
  loadImageFile,
  modelImage,
  paintBackground,
} from '@/lib/editor/image';

type Tool = 'auto' | 'smart' | 'brush' | 'lasso' | 'background';
type Mode = 'erase' | 'restore';

interface Doc {
  key: string;
  name: string;
  width: number;
  height: number;
  rgba: ImageData;
  originalAlpha: Uint8ClampedArray | null;
  mask: Mask;
  composite: OffscreenCanvas;
  compositeCtx: OffscreenCanvasRenderingContext2D;
  compositeData: ImageData;
  original: OffscreenCanvas;
  reduced: boolean;
  sourceWidth: number;
  sourceHeight: number;
}

interface Busy {
  label: string;
  fraction?: number;
  detail?: string;
}

interface View {
  zoom: number;
  x: number;
  y: number;
  fit: boolean;
}

interface Stroke {
  pointerId: number;
  tool: Tool;
  points: Point[];
  last: Point;
  dirty: Rect;
  before: Uint8ClampedArray | null;
}

interface Gesture {
  mode: 'pan' | 'pinch';
  pointerId?: number;
  startX: number;
  startY: number;
  startView: View;
  startDist?: number;
  startMid?: Point;
}

const TOOLS: { id: Tool; label: string; icon: typeof Brush }[] = [
  { id: 'auto', label: 'Auto remove', icon: WandSparkles },
  { id: 'smart', label: 'Smart Brush', icon: MousePointer2 },
  { id: 'brush', label: 'Manual brush', icon: Brush },
  { id: 'lasso', label: 'Lasso selection', icon: Scissors },
  { id: 'background', label: 'Background', icon: ImagePlus },
];

const SWATCHES = ['#ffffff', '#000000', '#c5f05a', '#f4f1ea', '#f9c5d1', '#9bd3f5', '#ffd166', '#2b2d42'];

const isTouchDevice = () => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;

function extractFrom(data: Uint8ClampedArray, width: number, r: Rect) {
  return extract({ data, width, height: 0 }, r);
}

function fmtBytes(n: number) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(0)} MB` : `${(n / 1e3).toFixed(0)} KB`;
}

function progressToBusy(p: ProgressInfo, running: string): Busy {
  if (p.stage === 'download') {
    return {
      label: 'Downloading a one-time helper. Next time it opens instantly.',
      fraction: p.fraction,
      detail: p.total ? `${fmtBytes(p.loaded ?? 0)} of ${fmtBytes(p.total)}` : undefined,
    };
  }
  if (p.stage === 'load') return { label: 'Warming up…' };
  return { label: running };
}

export default function Editor() {
  const fileInput = useRef<HTMLInputElement>(null);
  const bgInput = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);

  const docRef = useRef<Doc | null>(null);
  const viewRef = useRef<View>({ zoom: 1, x: 0, y: 0, fit: true });
  const strokeRef = useRef<Stroke | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const pointersRef = useRef(new Map<number, Point>());
  const hoverRef = useRef<Point | null>(null);
  const spaceRef = useRef(false);
  const rafRef = useRef(0);
  const patternRef = useRef<CanvasPattern | null>(null);
  const clientRef = useRef<ModelClient | null>(null);
  const historyRef = useRef(new MaskHistory());
  const bgRef = useRef<Background>({ type: 'transparent' });
  const compareRef = useRef(false);
  const toolRef = useRef<Tool>('auto');
  const modeRef = useRef<Mode>('erase');
  const brushRef = useRef(40);
  const busyRef = useRef<Busy | null>(null);

  const [hasDoc, setHasDoc] = useState(false);
  const [docName, setDocName] = useState('');
  const [docInfo, setDocInfo] = useState('');
  const [tool, setToolState] = useState<Tool>('auto');
  const [mode, setModeState] = useState<Mode>('erase');
  const [brushSize, setBrushSizeState] = useState(40);
  const [busy, setBusyState] = useState<Busy | null>(null);
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState<{ text: string; kind: 'error' | 'info' } | null>(null);
  const [zoomPct, setZoomPct] = useState(100);
  const [history, setHistory] = useState({ undo: false, redo: false });
  const [compare, setCompareState] = useState(false);
  const [bg, setBgState] = useState<Background>({ type: 'transparent' });
  const [format, setFormat] = useState<ExportFormat>('png');
  const [dragging, setDragging] = useState(false);
  const [exporting, setExporting] = useState(false);

  const setBusy = useCallback((b: Busy | null) => {
    busyRef.current = b;
    setBusyState(b);
  }, []);
  const setTool = useCallback((t: Tool) => {
    toolRef.current = t;
    setToolState(t);
  }, []);
  const setMode = useCallback((m: Mode) => {
    modeRef.current = m;
    setModeState(m);
  }, []);
  const setBrushSize = useCallback((n: number) => {
    const v = Math.max(4, Math.min(300, Math.round(n)));
    brushRef.current = v;
    setBrushSizeState(v);
  }, []);
  const setBg = useCallback((b: Background) => {
    const prev = bgRef.current;
    if (prev.type === 'image' && (b.type !== 'image' || b.bitmap !== prev.bitmap)) prev.bitmap.close();
    bgRef.current = b;
    setBgState(b);
  }, []);
  const syncHistory = useCallback(() => {
    const h = historyRef.current;
    setHistory({ undo: h.canUndo, redo: h.canRedo });
  }, []);

  // ------------------------------------------------------------------ render

  const render = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      const cv = canvasRef.current;
      const ws = workspaceRef.current;
      if (!cv || !ws) return;
      const dpr = window.devicePixelRatio || 1;
      const cw = ws.clientWidth;
      const ch = ws.clientHeight;
      if (cv.width !== Math.round(cw * dpr) || cv.height !== Math.round(ch * dpr)) {
        cv.width = Math.round(cw * dpr);
        cv.height = Math.round(ch * dpr);
      }
      const ctx = cv.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cw, ch);
      const doc = docRef.current;
      if (!doc) return;
      const v = viewRef.current;
      const bgv = bgRef.current;
      const sw = doc.width * v.zoom;
      const sh = doc.height * v.zoom;

      // drop shadow + checkerboard in screen space
      ctx.save();
      ctx.shadowColor = 'rgba(18,40,60,.18)';
      ctx.shadowBlur = 24;
      ctx.shadowOffsetY = 6;
      ctx.fillStyle = '#fff';
      ctx.fillRect(v.x, v.y, sw, sh);
      ctx.restore();
      if (bgv.type === 'transparent' || compareRef.current) {
        if (!patternRef.current) {
          const p = document.createElement('canvas');
          p.width = p.height = 16;
          const pc = p.getContext('2d')!;
          pc.fillStyle = '#fff';
          pc.fillRect(0, 0, 16, 16);
          pc.fillStyle = '#e4e7eb';
          pc.fillRect(0, 0, 8, 8);
          pc.fillRect(8, 8, 8, 8);
          patternRef.current = ctx.createPattern(p, 'repeat');
        }
        ctx.fillStyle = patternRef.current!;
        ctx.fillRect(v.x, v.y, sw, sh);
      }

      ctx.save();
      ctx.beginPath();
      ctx.rect(v.x, v.y, sw, sh);
      ctx.clip();
      ctx.translate(v.x, v.y);
      ctx.scale(v.zoom, v.zoom);
      if (!compareRef.current) paintBackground(ctx, bgv, doc.width, doc.height);
      ctx.imageSmoothingEnabled = v.zoom < 3;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(compareRef.current ? doc.original : doc.composite, 0, 0);

      const s = strokeRef.current;
      if (s && s.points.length && (s.tool === 'smart' || s.tool === 'lasso')) {
        ctx.beginPath();
        ctx.moveTo(s.points[0].x, s.points[0].y);
        for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x, s.points[i].y);
        if (s.tool === 'lasso') {
          ctx.closePath();
          ctx.fillStyle = modeRef.current === 'erase' ? 'rgba(255,80,80,.18)' : 'rgba(120,200,60,.22)';
          ctx.fill();
          ctx.setLineDash([6 / v.zoom, 4 / v.zoom]);
          ctx.lineWidth = 1.5 / v.zoom;
          ctx.strokeStyle = '#17202c';
          ctx.stroke();
        } else {
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.lineWidth = brushRef.current / v.zoom;
          ctx.strokeStyle = modeRef.current === 'erase' ? 'rgba(255,80,80,.45)' : 'rgba(120,200,60,.5)';
          ctx.stroke();
        }
      }
      ctx.restore();

      // brush cursor
      const h = hoverRef.current;
      const t = toolRef.current;
      if (h && (t === 'brush' || t === 'smart') && !gestureRef.current) {
        ctx.beginPath();
        ctx.arc(h.x, h.y, brushRef.current / 2, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(23,32,44,.9)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.strokeStyle = 'rgba(255,255,255,.8)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(h.x, h.y, brushRef.current / 2 + 1, 0, Math.PI * 2);
        ctx.stroke();
      }
    });
  }, []);

  const applyView = useCallback(
    (v: View) => {
      v.zoom = Math.max(0.02, Math.min(40, v.zoom));
      viewRef.current = v;
      setZoomPct(Math.round(v.zoom * 100));
      render();
    },
    [render],
  );

  const fitView = useCallback(() => {
    const ws = workspaceRef.current;
    const doc = docRef.current;
    if (!ws || !doc) return;
    const pad = 28;
    const zoom = Math.min((ws.clientWidth - pad * 2) / doc.width, (ws.clientHeight - pad * 2 - 30) / doc.height);
    applyView({
      zoom,
      x: (ws.clientWidth - doc.width * zoom) / 2,
      y: (ws.clientHeight - 30 - doc.height * zoom) / 2,
      fit: true,
    });
  }, [applyView]);

  const zoomBy = useCallback(
    (factor: number, cx?: number, cy?: number) => {
      const ws = workspaceRef.current;
      if (!ws) return;
      const v = viewRef.current;
      const px = cx ?? ws.clientWidth / 2;
      const py = cy ?? ws.clientHeight / 2;
      const zoom = Math.max(0.02, Math.min(40, v.zoom * factor));
      const f = zoom / v.zoom;
      applyView({ zoom, x: px - (px - v.x) * f, y: py - (py - v.y) * f, fit: false });
    },
    [applyView],
  );

  // ------------------------------------------------------------ compositing

  const composite = useCallback((doc: Doc, rect: Rect) => {
    const r = clampRect(rect, doc.width, doc.height);
    if (!r.w || !r.h) return;
    const d = doc.compositeData.data;
    const m = doc.mask.data;
    const w = doc.width;
    for (let y = r.y; y < r.y + r.h; y++) {
      const start = y * w + r.x;
      const end = start + r.w;
      for (let i = start; i < end; i++) d[i * 4 + 3] = m[i];
    }
    doc.compositeCtx.putImageData(doc.compositeData, 0, 0, r.x, r.y, r.w, r.h);
  }, []);

  const recordFullEdit = useCallback(
    (doc: Doc, before: Uint8ClampedArray, rect: Rect, label: string) => {
      const r = clampRect(rect, doc.width, doc.height);
      if (!r.w || !r.h) return;
      historyRef.current.push({
        rect: r,
        before: extractFrom(before, doc.width, r),
        after: extract(doc.mask, r),
        label,
      });
      syncHistory();
    },
    [syncHistory],
  );

  // ------------------------------------------------------------------ models

  const client = useCallback(() => {
    clientRef.current ??= new ModelClient();
    return clientRef.current;
  }, []);

  const runAuto = useCallback(
    async (doc: Doc) => {
      if (busyRef.current) return;
      setNotice(null);
      setBusy({ label: 'Removing background…' });
      try {
        const res = await client().removeBackground(modelImage(doc.rgba), (p) =>
          setBusy(progressToBusy(p, 'Removing background…')),
        );
        if (docRef.current !== doc) return;
        const before = doc.mask.data.slice();
        const rect = applyScaledMask(doc.mask, doc.originalAlpha, res, 'replace');
        composite(doc, rect);
        recordFullEdit(doc, before, rect, 'Auto remove');
        render();
      } catch (err) {
        if (!(err instanceof CancelledError)) {
          setNotice({ text: (err as Error).message, kind: 'error' });
        }
      } finally {
        setBusy(null);
      }
    },
    [client, composite, recordFullEdit, render, setBusy],
  );

  const runSmart = useCallback(
    async (doc: Doc, points: Point[]) => {
      if (!points.length) return;
      setNotice(null);
      const c = client();
      const modeAtStart = modeRef.current;
      try {
        if (c.embeddedKey !== doc.key) {
          setBusy({ label: 'Preparing the Smart Brush…' });
          await c.prepareSmart(
            doc.key,
            () => modelImage(doc.rgba),
            (p) => setBusy(progressToBusy(p, 'Preparing the Smart Brush…')),
          );
          if (docRef.current !== doc) return;
          setBusy(null);
        }
        setWorking(true);
        const scale = Math.min(1, MODEL_SIDE / Math.max(doc.width, doc.height));
        // Sample up to 8 points evenly along the stroke.
        const sampled: Point[] = [];
        let total = 0;
        for (let i = 1; i < points.length; i++) total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
        const n = Math.min(8, Math.max(1, Math.round(total / 40) + 1));
        if (n === 1 || total === 0) sampled.push(points[Math.floor(points.length / 2)]);
        else {
          let acc = 0;
          let next = 0;
          const step = total / (n - 1);
          sampled.push(points[0]);
          next = step;
          for (let i = 1; i < points.length && sampled.length < n; i++) {
            const seg = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
            while (acc + seg >= next && sampled.length < n) {
              const t = seg ? (next - acc) / seg : 0;
              sampled.push({
                x: points[i - 1].x + (points[i].x - points[i - 1].x) * t,
                y: points[i - 1].y + (points[i].y - points[i - 1].y) * t,
              });
              next += step;
            }
            acc += seg;
          }
          if (sampled.length < n) sampled.push(points[points.length - 1]);
        }
        const res = await c.segment({
          positive: sampled.map((p) => ({ x: p.x * scale, y: p.y * scale })),
          negative: [],
        });
        if (docRef.current !== doc) return;
        const b = boundsOf(res);
        if (!b) {
          setNotice({ text: 'Nothing was found under that stroke. Try a longer stroke over the object.', kind: 'info' });
          return;
        }
        const inv = 1 / scale;
        const region = { x: (b.x - 2) * inv, y: (b.y - 2) * inv, w: (b.w + 4) * inv, h: (b.h + 4) * inv };
        const before = doc.mask.data.slice();
        const rect = applyScaledMask(doc.mask, doc.originalAlpha, res, modeAtStart, region);
        composite(doc, rect);
        recordFullEdit(doc, before, rect, 'Smart Brush');
        render();
      } catch (err) {
        if (!(err instanceof CancelledError)) setNotice({ text: (err as Error).message, kind: 'error' });
      } finally {
        setWorking(false);
        if (busyRef.current) setBusy(null);
      }
    },
    [client, composite, recordFullEdit, render, setBusy],
  );

  const cancelBusy = useCallback(() => {
    clientRef.current?.cancel();
    setBusy(null);
    setWorking(false);
  }, [setBusy]);

  // ---------------------------------------------------------------- document

  const openFile = useCallback(
    async (file: File) => {
      if (busyRef.current) cancelBusy();
      setNotice(null);
      setBusy({ label: 'Opening image…' });
      try {
        const img = await loadImageFile(file, isTouchDevice() ? MAX_PIXELS_MOBILE : MAX_PIXELS_DESKTOP);
        const { width, height } = img;
        const mask: Mask = {
          data: img.originalAlpha ? img.originalAlpha.slice() : new Uint8ClampedArray(width * height).fill(255),
          width,
          height,
        };
        const composite = new OffscreenCanvas(width, height);
        const compositeCtx = composite.getContext('2d')!;
        const compositeData = new ImageData(new Uint8ClampedArray(img.rgba.data), width, height);
        compositeCtx.putImageData(compositeData, 0, 0);
        const original = new OffscreenCanvas(width, height);
        original.getContext('2d')!.putImageData(img.rgba, 0, 0);
        const doc: Doc = {
          key: `${Date.now()}-${Math.random()}`,
          name: file.name,
          width,
          height,
          rgba: img.rgba,
          originalAlpha: img.originalAlpha,
          mask,
          composite,
          compositeCtx,
          compositeData,
          original,
          reduced: img.reduced,
          sourceWidth: img.sourceWidth,
          sourceHeight: img.sourceHeight,
        };
        clientRef.current?.cancel();
        historyRef.current.clear();
        syncHistory();
        docRef.current = doc;
        setHasDoc(true);
        setDocName(file.name);
        setDocInfo(
          img.reduced
            ? `${width} × ${height} (reduced from ${img.sourceWidth} × ${img.sourceHeight})`
            : `${width} × ${height}`,
        );
        if (img.reduced) {
          setNotice({
            text: `This image was reduced to ${width} × ${height} so it fits in your browser's memory.`,
            kind: 'info',
          });
        }
        setTool('auto');
        fitView();
        setBusy(null);
        await runAuto(doc);
      } catch (err) {
        setBusy(null);
        setNotice({ text: (err as Error).message, kind: 'error' });
      }
    },
    [cancelBusy, fitView, runAuto, setBusy, setTool, syncHistory],
  );

  const undo = useCallback(() => {
    const doc = docRef.current;
    if (!doc || strokeRef.current) return;
    const r = historyRef.current.undo(doc.mask);
    if (r) composite(doc, r);
    syncHistory();
    render();
  }, [composite, render, syncHistory]);

  const redo = useCallback(() => {
    const doc = docRef.current;
    if (!doc || strokeRef.current) return;
    const r = historyRef.current.redo(doc.mask);
    if (r) composite(doc, r);
    syncHistory();
    render();
  }, [composite, render, syncHistory]);

  const setCompare = useCallback(
    (on: boolean) => {
      compareRef.current = on;
      setCompareState(on);
      render();
    },
    [render],
  );

  const download = useCallback(async () => {
    const doc = docRef.current;
    if (!doc || exporting) return;
    setExporting(true);
    try {
      const blob = await exportImage(doc.rgba, doc.mask, bgRef.current, format);
      const ext = format === 'jpeg' ? 'jpg' : format;
      downloadBlob(blob, `${baseName(doc.name)}-cutout.${ext}`);
    } catch (err) {
      setNotice({ text: `Couldn't save the image: ${(err as Error).message}`, kind: 'error' });
    } finally {
      setExporting(false);
    }
  }, [exporting, format]);

  // ------------------------------------------------------------- pointer input

  const toImage = useCallback((sx: number, sy: number): Point => {
    const v = viewRef.current;
    return { x: (sx - v.x) / v.zoom, y: (sy - v.y) / v.zoom };
  }, []);

  const localPoint = useCallback((e: { clientX: number; clientY: number }): Point => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }, []);

  const cancelStroke = useCallback(() => {
    const s = strokeRef.current;
    const doc = docRef.current;
    if (!s || !doc) return;
    if (s.before && s.dirty.w) {
      const r = clampRect(s.dirty, doc.width, doc.height);
      doc.mask.data.set(s.before.subarray(0), 0);
      composite(doc, r);
    }
    strokeRef.current = null;
    render();
  }, [composite, render]);

  const finishStroke = useCallback(() => {
    const s = strokeRef.current;
    const doc = docRef.current;
    strokeRef.current = null;
    if (!s || !doc) return;
    if (s.tool === 'brush' && s.before) {
      recordFullEdit(doc, s.before, s.dirty, 'Brush');
    } else if (s.tool === 'lasso') {
      if (s.points.length >= 3) {
        const before = doc.mask.data.slice();
        const rect = fillPolygon(doc.mask, s.points, modeRef.current === 'erase' ? 0 : 255);
        composite(doc, rect);
        recordFullEdit(doc, before, rect, 'Lasso');
      }
    } else if (s.tool === 'smart') {
      void runSmart(doc, s.points);
    }
    render();
  }, [composite, recordFullEdit, render, runSmart]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const doc = docRef.current;
      if (!doc) return;
      const cv = canvasRef.current!;
      cv.setPointerCapture(e.pointerId);
      const p = localPoint(e);
      pointersRef.current.set(e.pointerId, p);

      if (pointersRef.current.size === 2) {
        cancelStroke();
        const [a, b] = [...pointersRef.current.values()];
        gestureRef.current = {
          mode: 'pinch',
          startX: 0,
          startY: 0,
          startView: { ...viewRef.current },
          startDist: Math.hypot(a.x - b.x, a.y - b.y),
          startMid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        };
        return;
      }
      if (pointersRef.current.size > 2 || gestureRef.current) return;

      const t = toolRef.current;
      const editing = t === 'brush' || t === 'smart' || t === 'lasso';
      const wantPan =
        e.button === 1 || e.button === 2 || spaceRef.current || !editing || compareRef.current || !!busyRef.current;
      if (wantPan) {
        gestureRef.current = {
          mode: 'pan',
          pointerId: e.pointerId,
          startX: p.x,
          startY: p.y,
          startView: { ...viewRef.current },
        };
        return;
      }
      const ip = toImage(p.x, p.y);
      if (t === 'brush') {
        const before = doc.mask.data.slice();
        const r = brushRef.current / 2 / viewRef.current.zoom;
        const dirty = strokeSegment(doc.mask, ip.x, ip.y, ip.x, ip.y, r, modeRef.current === 'erase' ? 0 : 255);
        composite(doc, dirty);
        strokeRef.current = { pointerId: e.pointerId, tool: t, points: [ip], last: ip, dirty, before };
      } else {
        strokeRef.current = { pointerId: e.pointerId, tool: t, points: [ip], last: ip, dirty: { x: 0, y: 0, w: 0, h: 0 }, before: null };
      }
      render();
    },
    [cancelStroke, composite, localPoint, render, toImage],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const p = localPoint(e);
      hoverRef.current = e.pointerType === 'mouse' ? p : null;
      const doc = docRef.current;
      if (!doc) return;
      if (pointersRef.current.has(e.pointerId)) pointersRef.current.set(e.pointerId, p);
      const g = gestureRef.current;
      if (g) {
        if (g.mode === 'pinch' && pointersRef.current.size >= 2) {
          const [a, b] = [...pointersRef.current.values()];
          const dist = Math.hypot(a.x - b.x, a.y - b.y);
          const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          const f = Math.max(0.02, Math.min(40, g.startView.zoom * (dist / (g.startDist || 1)))) / g.startView.zoom;
          applyView({
            zoom: g.startView.zoom * f,
            x: mid.x - (g.startMid!.x - g.startView.x) * f,
            y: mid.y - (g.startMid!.y - g.startView.y) * f,
            fit: false,
          });
        } else if (g.mode === 'pan' && g.pointerId === e.pointerId) {
          applyView({
            ...g.startView,
            x: g.startView.x + (p.x - g.startX),
            y: g.startView.y + (p.y - g.startY),
            fit: false,
          });
        }
        return;
      }
      const s = strokeRef.current;
      if (s && s.pointerId === e.pointerId) {
        const ip = toImage(p.x, p.y);
        if (s.tool === 'brush') {
          const r = brushRef.current / 2 / viewRef.current.zoom;
          const dirty = strokeSegment(doc.mask, s.last.x, s.last.y, ip.x, ip.y, r, modeRef.current === 'erase' ? 0 : 255);
          composite(doc, dirty);
          s.dirty = unionRect(s.dirty, dirty);
        } else {
          const d = Math.hypot(ip.x - s.last.x, ip.y - s.last.y) * viewRef.current.zoom;
          if (d < 2) return;
          s.points.push(ip);
        }
        s.last = ip;
      }
      render();
    },
    [applyView, composite, localPoint, render, toImage],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      pointersRef.current.delete(e.pointerId);
      canvasRef.current?.releasePointerCapture(e.pointerId);
      const g = gestureRef.current;
      if (g) {
        if (g.mode === 'pinch') {
          if (pointersRef.current.size < 2) gestureRef.current = null;
        } else if (g.pointerId === e.pointerId) gestureRef.current = null;
      }
      const s = strokeRef.current;
      if (s && s.pointerId === e.pointerId) {
        if (e.type === 'pointercancel') cancelStroke();
        else finishStroke();
      }
      if (e.pointerType !== 'mouse') hoverRef.current = null;
      render();
    },
    [cancelStroke, finishStroke, render],
  );

  // ----------------------------------------------------------------- effects

  useEffect(() => {
    const ws = workspaceRef.current;
    const cv = canvasRef.current;
    if (!ws || !cv) return;
    const ro = new ResizeObserver(() => {
      if (viewRef.current.fit) fitView();
      else render();
    });
    ro.observe(ws);
    const onWheel = (e: WheelEvent) => {
      if (!docRef.current) return;
      e.preventDefault();
      const p = { x: e.clientX - cv.getBoundingClientRect().left, y: e.clientY - cv.getBoundingClientRect().top };
      if (e.ctrlKey || e.metaKey) {
        zoomBy(Math.exp(-e.deltaY * 0.01), p.x, p.y);
      } else {
        const v = viewRef.current;
        applyView({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY, fit: false });
      }
    };
    cv.addEventListener('wheel', onWheel, { passive: false });
    const onLeave = () => {
      hoverRef.current = null;
      render();
    };
    cv.addEventListener('pointerleave', onLeave);
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    return () => {
      ro.disconnect();
      cv.removeEventListener('wheel', onWheel);
      cv.removeEventListener('pointerleave', onLeave);
    };
  }, [applyView, fitView, render, zoomBy]);

  useEffect(() => {
    const isTyping = (t: EventTarget | null) =>
      t instanceof HTMLElement && ['INPUT', 'SELECT', 'TEXTAREA'].includes(t.tagName);
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTyping(e.target) || !docRef.current) return;
      const meta = e.metaKey || e.ctrlKey;
      if (e.key === ' ') {
        spaceRef.current = true;
        e.preventDefault();
      } else if (meta && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (meta && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      } else if (meta && e.key === 's') {
        e.preventDefault();
        void download();
      } else if (meta) {
        return;
      } else if (e.key === '[') setBrushSize(brushRef.current - 6);
      else if (e.key === ']') setBrushSize(brushRef.current + 6);
      else if (e.key === 'b') setTool('brush');
      else if (e.key === 's') setTool('smart');
      else if (e.key === 'l') setTool('lasso');
      else if (e.key === 'g') setTool('background');
      else if (e.key === 'x') setMode(modeRef.current === 'erase' ? 'restore' : 'erase');
      else if (e.key === 'c' && !compareRef.current) setCompare(true);
      else if (e.key === '0') fitView();
      else if (e.key === '=' || e.key === '+') zoomBy(1.25);
      else if (e.key === '-') zoomBy(0.8);
      else if (e.key === 'Escape') cancelStroke();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === ' ') spaceRef.current = false;
      if (e.key === 'c') setCompare(false);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [cancelStroke, download, fitView, redo, setBrushSize, setCompare, setMode, setTool, undo, zoomBy]);

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const f = [...(e.clipboardData?.files ?? [])].find((x) => x.type.startsWith('image/'));
      if (f) void openFile(f);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [openFile]);

  useEffect(() => {
    render();
  }, [bg, render]);

  useEffect(() => () => clientRef.current?.dispose(), []);

  // --------------------------------------------------------------------- UI

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = [...e.dataTransfer.files].find((x) => x.type.startsWith('image/'));
    if (f) void openFile(f);
    else setNotice({ text: 'Drop an image file (JPG, PNG or WebP).', kind: 'error' });
  };

  const pickBgImage = async (file: File) => {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      setBg({ type: 'image', bitmap, name: file.name });
    } catch {
      setNotice({ text: "That background couldn't be opened as an image.", kind: 'error' });
    }
  };

  const modeButtons = (
    <div className="mode-buttons" aria-label="Brush mode">
      <button className={mode === 'erase' ? 'selected' : ''} onClick={() => setMode('erase')} aria-pressed={mode === 'erase'}>
        Erase
      </button>
      <button className={mode === 'restore' ? 'selected' : ''} onClick={() => setMode('restore')} aria-pressed={mode === 'restore'}>
        Restore
      </button>
    </div>
  );

  const sizeSlider = (
    <label>
      Brush size <span>{brushSize}</span>
      <input
        type="range"
        min={4}
        max={300}
        value={brushSize}
        onChange={(e) => setBrushSize(Number(e.target.value))}
        aria-label="Brush size"
      />
    </label>
  );

  const cursor = tool === 'brush' || tool === 'smart' ? 'none' : tool === 'lasso' ? 'crosshair' : 'grab';

  return (
    <>
      <section className="editor">
        <div className="editor-top">
          <span className="document-name" title={docInfo}>
            {docName || 'Your next great cutout'}
            {docInfo && <span className="status-text"> · {docInfo}</span>}
          </span>
          <div className="editor-actions">
            <button onClick={undo} disabled={!history.undo} aria-label="Undo" title="Undo (⌘Z)">
              <Undo2 size={18} />
            </button>
            <button onClick={redo} disabled={!history.redo} aria-label="Redo" title="Redo (⌘⇧Z)">
              <Redo2 size={18} />
            </button>
            <button
              disabled={!hasDoc}
              className={compare ? 'selected' : ''}
              aria-pressed={compare}
              title="Hold to see the original (C)"
              onPointerDown={() => setCompare(true)}
              onPointerUp={() => setCompare(false)}
              onPointerLeave={() => compare && setCompare(false)}
              onKeyDown={(e) => e.key === 'Enter' && setCompare(!compare)}
            >
              <Eye size={18} /> <span className="label-wide">Before</span>
            </button>
            <span className="divider" />
            <button onClick={() => fileInput.current?.click()} title="Open another image">
              <Plus size={17} /> <span className="label-wide">New image</span>
            </button>
            <div className="export-options">
              <select value={format} onChange={(e) => setFormat(e.target.value as ExportFormat)} aria-label="File format" disabled={!hasDoc}>
                <option value="png">PNG</option>
                <option value="webp">WebP</option>
                <option value="jpeg">JPG</option>
              </select>
              <button className="primary" disabled={!hasDoc || exporting} onClick={download}>
                <Download size={17} /> {exporting ? 'Saving…' : 'Download'}
              </button>
            </div>
          </div>
        </div>
        {notice && (
          <div className={`notice ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
            <span>{notice.text}</span>
            <button onClick={() => setNotice(null)} aria-label="Dismiss">
              <X size={16} />
            </button>
          </div>
        )}
        <div className="editor-body">
          <aside className="tools">
            <div className="section-label">CUTOUT</div>
            {TOOLS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                className={tool === id ? 'tool active' : 'tool'}
                disabled={!hasDoc}
                aria-pressed={tool === id}
                onClick={() => {
                  setTool(id);
                  if (id === 'auto' && docRef.current && !busyRef.current) void runAuto(docRef.current);
                }}
              >
                <Icon size={19} />
                <span>{label}</span>
              </button>
            ))}
            {hasDoc && (
              <div className="settings">
                {tool === 'auto' && (
                  <>
                    <p>The background is removed automatically when you open an image. Use it again to start over.</p>
                    <button className="wide" disabled={!!busy} onClick={() => docRef.current && runAuto(docRef.current)}>
                      <WandSparkles size={16} /> Run again
                    </button>
                  </>
                )}
                {tool === 'smart' && (
                  <>
                    {modeButtons}
                    {sizeSlider}
                    <p>Brush over an object or area. Cutout finds its edges and {mode === 'erase' ? 'erases' : 'restores'} it.</p>
                  </>
                )}
                {tool === 'brush' && (
                  <>
                    {modeButtons}
                    {sizeSlider}
                    <p>Paint to {mode === 'erase' ? 'erase' : 'bring back'} exactly where you brush. Zoom in for fine edges.</p>
                  </>
                )}
                {tool === 'lasso' && (
                  <>
                    {modeButtons}
                    <p>Draw around an area to {mode === 'erase' ? 'erase' : 'restore'} everything inside it.</p>
                  </>
                )}
                {tool === 'background' && (
                  <>
                    <div className="swatches">
                      <button
                        className={`swatch checker ${bg.type === 'transparent' ? 'chosen' : ''}`}
                        onClick={() => setBg({ type: 'transparent' })}
                        aria-label="Transparent"
                        title="Transparent"
                      />
                      {SWATCHES.map((c) => (
                        <button
                          key={c}
                          className={`swatch ${bg.type === 'color' && bg.color === c ? 'chosen' : ''}`}
                          style={{ background: c }}
                          onClick={() => setBg({ type: 'color', color: c })}
                          aria-label={`Colour ${c}`}
                          title={c}
                        />
                      ))}
                    </div>
                    <input
                      className="color-picker"
                      type="color"
                      value={bg.type === 'color' ? bg.color : '#ffffff'}
                      onChange={(e) => setBg({ type: 'color', color: e.target.value })}
                      aria-label="Custom colour"
                    />
                    <button className="wide" onClick={() => bgInput.current?.click()}>
                      <ImagePlus size={16} /> {bg.type === 'image' ? 'Change photo' : 'Use a photo'}
                    </button>
                    {bg.type === 'image' && (
                      <p>
                        Using <strong>{bg.name}</strong> as the background.
                      </p>
                    )}
                  </>
                )}
              </div>
            )}
            <div className="tool-note">
              <ShieldCheck size={19} />
              <p>
                Your photos stay
                <br />
                on your device.
              </p>
            </div>
            {hasDoc && (
              <div className="keyboard-hint">
                Space + drag to pan · scroll to zoom · [ ] brush size · X switch erase/restore · C hold for before
              </div>
            )}
          </aside>
          <div
            className={`workspace ${dragging ? 'dragging' : ''}`}
            ref={workspaceRef}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
          >
            <canvas
              ref={canvasRef}
              className="view"
              style={{ cursor: hasDoc ? cursor : 'default', touchAction: 'none' }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              aria-label="Image canvas"
            />
            {!hasDoc && !busy && (
              <button type="button" className="dropzone" onClick={() => fileInput.current?.click()}>
                <span className="upload-symbol">
                  <Upload size={30} />
                </span>
                <h2>Drop an image here</h2>
                <p>or choose one from your device</p>
                <span className="primary fake-button">
                  <Plus size={18} /> Choose image
                </span>
                <span className="file-hint">JPG, PNG, WebP · up to 25 MB</span>
              </button>
            )}
            {busy && (
              <div className="busy" aria-live="polite">
                <div className="spinner" />
                <div className="busy-text">{busy.label}</div>
                {busy.fraction !== undefined && (
                  <div className="progress-bar" aria-hidden>
                    <div style={{ width: `${Math.round(busy.fraction * 100)}%` }} />
                  </div>
                )}
                {busy.detail && <div className="status-text">{busy.detail}</div>}
                <button onClick={cancelBusy}>Cancel</button>
              </div>
            )}
            {hasDoc && (
              <div className="canvas-bottom">
                <span>{working ? 'FINDING EDGES…' : compare ? 'ORIGINAL' : bg.type === 'transparent' ? 'TRANSPARENT CANVAS' : 'WITH BACKGROUND'}</span>
                <div>
                  <button onClick={() => zoomBy(0.8)} aria-label="Zoom out">
                    <Minus size={16} />
                  </button>
                  <button onClick={fitView} className="zoom-label" title="Fit to screen (0)">
                    {zoomPct}%
                  </button>
                  <button onClick={() => zoomBy(1.25)} aria-label="Zoom in">
                    <Plus size={16} />
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </section>
      <input
        hidden
        type="file"
        accept="image/*"
        ref={fileInput}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void openFile(f);
          e.target.value = '';
        }}
      />
      <input
        hidden
        type="file"
        accept="image/*"
        ref={bgInput}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void pickBgImage(f);
          e.target.value = '';
        }}
      />
    </>
  );
}
