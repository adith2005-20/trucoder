import { useId, useState } from "react";
import { PiArrowSquareOut } from "react-icons/pi";
import Lightbox from "./Lightbox";
import type { FlowchartBlock } from "../types";

// ---- geometry ----
const NODE_MIN_W = 150;
const NODE_MIN_H = 46;
const PAD_X = 18; // horizontal padding inside a node box
const PAD_Y = 12; // vertical padding inside a node box
const LINE_H = 17; // line height for wrapped labels
const GAP_MIN = 72; // minimum gap between columns
const GAP_LABEL_PAD = 18; // extra column gap so edge labels never touch nodes
const ROW_GAP = 22; // vertical gap between stacked nodes in a column
const GUTTER = 48; // breathing room inside the viewBox (first/last labels)
const NODE_FONT = 12;
const EDGE_FONT = 11;
const CORNER_R = 8; // rounded-corner radius on orthogonal edges

/** Approximate advance width of the editor mono font (≈0.6em). */
function measure(text: string, fontSize = NODE_FONT): number {
  return text.length * fontSize * 0.6;
}

/** Wrap a label into lines that fit within a node box (never spill out). */
function wrap(text: string, maxW: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const candidate = cur ? `${cur} ${w}` : w;
    if (measure(candidate) <= maxW) {
      cur = candidate;
    } else {
      if (cur) lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [text];
}

/** Renders a layered DAG flowchart as inline SVG (no external dependencies).
 *  Layout: longest-path layering left→right, node labels wrap inside their
 *  boxes, each column is as wide as its widest node, columns are spaced so
 *  edge labels never collide, and edges are orthogonal with rounded corners.
 *  The expand button opens a Lightbox whose zoom re-renders the SVG at the
 *  target pixel size, so text stays crisp at any magnification. */
export default function Flowchart({ block }: { block: FlowchartBlock }) {
  const markerId = `tcarrow-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const { nodes, edges } = block;
  const n = nodes.length;
  if (n === 0) return null;

  // longest-path layering (fixpoint, capped at n passes so cyclic graphs
  // terminate — cycles just push layers forward)
  const layer = new Array(n).fill(0);
  let changed = true;
  for (let pass = 0; pass < n && changed; pass++) {
    changed = false;
    for (const e of edges) {
      if (layer[e.to] < layer[e.from] + 1) {
        layer[e.to] = layer[e.from] + 1;
        changed = true;
      }
    }
  }

  const byLayer = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const l = layer[i];
    if (!byLayer.has(l)) byLayer.set(l, []);
    byLayer.get(l)!.push(i);
  }
  const maxLayer = Math.max(...byLayer.keys());
  const wrapW = NODE_MIN_W - 2 * PAD_X;

  // per-node box sizes (labels wrap to fit; a long unbreakable word widens
  // the box instead of spilling out of it)
  const meta = nodes.map((label) => {
    const lines = wrap(label, wrapW);
    const w = Math.max(
      NODE_MIN_W,
      Math.max(...lines.map((ln) => measure(ln))) + 2 * PAD_X
    );
    const h = Math.max(NODE_MIN_H, lines.length * LINE_H + 2 * PAD_Y);
    return { label, lines, w, h };
  });

  // column width per layer = widest node in that layer (keeps ports aligned)
  const colW = new Array(maxLayer + 1).fill(0);
  for (let l = 0; l <= maxLayer; l++) {
    for (const i of byLayer.get(l) ?? []) colW[l] = Math.max(colW[l], meta[i].w);
  }

  // gap between adjacent columns — widen to fit the longest edge label
  const gapW = new Array(maxLayer).fill(GAP_MIN);
  for (const e of edges) {
    const lf = layer[e.from];
    const lt = layer[e.to];
    if (lt === lf + 1 && e.label) {
      gapW[lf] = Math.max(gapW[lf], measure(e.label, EDGE_FONT) + 2 * GAP_LABEL_PAD);
    }
  }

  // column x positions + total width
  const colX = new Array(maxLayer + 1);
  let x = 0;
  for (let l = 0; l <= maxLayer; l++) {
    colX[l] = x;
    if (l < maxLayer) x += colW[l] + gapW[l];
  }
  const svgW = x + colW[maxLayer] + 2 * GUTTER;

  // column heights; single-node columns are centered against the tallest one
  const colH = new Array(maxLayer + 1).fill(0);
  for (let l = 0; l <= maxLayer; l++) {
    const members = byLayer.get(l) ?? [];
    let h = 0;
    members.forEach((i, idx) => {
      h += meta[i].h + (idx > 0 ? ROW_GAP : 0);
    });
    colH[l] = h;
  }
  const maxColH = Math.max(...colH);
  const svgH = maxColH + 2 * GUTTER;

  const pos: { x: number; y: number; w: number; h: number }[] = new Array(n);
  for (let l = 0; l <= maxLayer; l++) {
    const members = byLayer.get(l) ?? [];
    let y = (maxColH - colH[l]) / 2;
    for (const i of members) {
      pos[i] = { x: colX[l], y, w: colW[l], h: meta[i].h };
      y += meta[i].h + ROW_GAP;
    }
  }

  /** Orthogonal path with rounded corners; returns bend midpoint for the label. */
  function edgeGeom(e: { from: number; to: number }) {
    const a = pos[e.from];
    const b = pos[e.to];
    const x1 = a.x + a.w;
    const y1 = a.y + a.h / 2;
    const x2 = b.x;
    const y2 = b.y + b.h / 2;
    if (Math.abs(y1 - y2) < 0.5) {
      return { d: `M ${x1} ${y1} H ${x2}`, mx: (x1 + x2) / 2, my: y1 - 9, straight: true };
    }
    const mx = (x1 + x2) / 2;
    const sgn = y2 > y1 ? 1 : -1;
    const d =
      `M ${x1} ${y1} H ${mx - CORNER_R} ` +
      `Q ${mx} ${y1} ${mx} ${y1 + sgn * CORNER_R} ` +
      `V ${y2 - sgn * CORNER_R} ` +
      `Q ${mx} ${y2} ${mx + CORNER_R} ${y2} H ${x2}`;
    return { d, mx, my: (y1 + y2) / 2, straight: false };
  }

  /** The diagram at a given pixel size — the same viewBox, re-rasterized at
   *  the target size so zooming never blurs text. */
  function renderSvg(wPx: number, hPx: number) {
    return (
      <svg
        viewBox={`${-GUTTER} ${-GUTTER} ${svgW} ${svgH}`}
        width={wPx}
        height={hPx}
        role="img"
        aria-label={block.title ?? "flowchart"}
        className="flowchart-svg"
      >
        <defs>
          <marker
            id={markerId}
            viewBox="0 0 10 10"
            refX="8.5"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" className="flow-arrow" />
          </marker>
        </defs>
        {edges.map((e, i) => {
          const g = edgeGeom(e);
          const lw = e.label ? measure(e.label, EDGE_FONT) : 0;
          return (
            <g key={i}>
              <path d={g.d} fill="none" className="flow-edge" markerEnd={`url(#${markerId})`} />
              {e.label && (
                <g>
                  <rect
                    x={g.mx - lw / 2 - 5}
                    y={g.my - 9}
                    width={lw + 10}
                    height={18}
                    rx={3}
                    className="flow-edge-halo"
                  />
                  <text
                    x={g.mx}
                    y={g.my}
                    textAnchor="middle"
                    dominantBaseline="central"
                    className="flow-edge-label"
                  >
                    {e.label}
                  </text>
                </g>
              )}
            </g>
          );
        })}
        {nodes.map((_, i) => {
          const p = pos[i];
          const cx = p.x + p.w / 2;
          const cy = p.y + p.h / 2;
          const lines = meta[i].lines;
          return (
            <g key={i}>
              <rect
                x={p.x}
                y={p.y}
                width={p.w}
                height={p.h}
                rx={8}
                className="flow-node"
              />
              <text
                textAnchor="middle"
                dominantBaseline="central"
                className="flow-node-label"
              >
                {lines.map((ln, li) => (
                  <tspan
                    key={li}
                    x={cx}
                    y={cy + (li - (lines.length - 1) / 2) * LINE_H}
                  >
                    {ln}
                  </tspan>
                ))}
              </text>
            </g>
          );
        })}
      </svg>
    );
  }

  const [open, setOpen] = useState(false);

  return (
    <figure className="flowchart">
      <div className="flowchart-head">
        {block.title && <figcaption className="flowchart-title">{block.title}</figcaption>}
        <button
          className="flow-expand"
          onClick={() => setOpen(true)}
          aria-label="view fullscreen"
          title="view fullscreen"
        >
          <PiArrowSquareOut size={15} />
        </button>
      </div>
      <div className="flowchart-scroll">{renderSvg(svgW, svgH)}</div>
      <Lightbox
        open={open}
        onClose={() => setOpen(false)}
        label={block.title}
        contentW={svgW}
        contentH={svgH}
      >
        {(s) => renderSvg(svgW * s, svgH * s)}
      </Lightbox>
    </figure>
  );
}
