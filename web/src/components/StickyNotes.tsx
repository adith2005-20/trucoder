import { useCallback, useEffect, useRef, useState } from "react";
import { PiX } from "react-icons/pi";
import { api } from "../api";
import type { StickyNote } from "../types";

/**
 * Sticky notes pinned to the lesson page's margins — real sticky-note
 * behavior: slightly rotated, Comic Neue, draggable within the free space
 * beside the content column, synced per user via the server (they follow
 * the learner across devices). On narrow screens the notes collapse into a
 * static wall at the bottom of the lesson.
 *
 * Positions are px relative to the scrollable .lesson-page container; the
 * client clamps them to the margin zones (left/right of the content column)
 * so a note can never cover the reading material.
 */

const NOTE_W = 190;
const NOTE_H = 120;
const GAP = 12;
const COLORS = ["auto", "yellow", "pink", "green", "blue", "purple", "orange"];

/** Deterministic per-note tilt so synced notes look the same everywhere. */
function tilt(id: number): string {
  const h = ((id * 2654435761) % 100 + 100) % 100;
  return `${((h % 70) / 10 - 3.5).toFixed(1)}deg`;
}

interface NoteViewProps {
  note: StickyNote;
  dragging: boolean;
  onDragStart: (e: React.PointerEvent, note: StickyNote) => void;
  onText: (note: StickyNote, text: string) => void;
  onTextBlur: (note: StickyNote) => void;
  onColor: (note: StickyNote, color: string) => void;
  onDelete: (note: StickyNote) => void;
  /** Wall (mobile) rendering — no drag, no absolute position. */
  static?: boolean;
  /** Passed to the root element so the add-note guard can target the textarea. */
  "data-note-id"?: number;
}

function NoteView({
  note,
  dragging,
  onDragStart,
  onText,
  onTextBlur,
  onColor,
  onDelete,
  static: isStatic,
  "data-note-id": noteIdAttr,
}: NoteViewProps) {
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  const autosize = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight + 2, 240)}px`;
  };

  // grow to fit existing content on load (wall + restored notes)
  useEffect(() => {
    autosize();
  }, []);

  return (
    <div
      data-note-id={isStatic ? noteIdAttr : undefined}
      className={`sticky-note ${dragging ? "dragging" : ""}`}
      data-color={note.color}
      style={{ "--rot": tilt(note.id) } as React.CSSProperties}
      onPointerDown={
        isStatic ? undefined : (e) => onDragStart(e, note)
      }
    >
      {!isStatic && <div className="sticky-tape" />}
      <div className="sticky-tools">
        <button
          className="sticky-delete"
          aria-label="delete sticky note"
          title="delete"
          onClick={() => onDelete(note)}
        >
          <PiX size={11} />
        </button>
      </div>
      <textarea
        ref={taRef}
        className="sticky-text"
        value={note.text}
        placeholder="note…"
        spellCheck={false}
        onChange={(e) => {
          onText(note, e.target.value);
          requestAnimationFrame(autosize);
        }}
        onBlur={() => onTextBlur(note)}
      />
      <div className="sticky-colors">
        {COLORS.map((c) => (
          <button
            key={c}
            className={`sticky-color-dot ${note.color === c ? "sel" : ""}`}
            data-color={c}
            aria-label={`note color ${c}`}
            title={c === "auto" ? "theme color" : c}
            onClick={() => onColor(note, c)}
          />
        ))}
      </div>
    </div>
  );
}

export default function StickyNotes({
  courseId,
  lessonId,
  addTick,
}: {
  courseId: string;
  lessonId: string;
  /** Bump to add a note (button lives in the lesson header). */
  addTick: number;
}) {
  const [notes, setNotes] = useState<StickyNote[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [dragId, setDragId] = useState<number | null>(null);
  const pageRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{
    id: number;
    dx: number;
    dy: number;
    origX: number;
    origY: number;
    moved: boolean;
  } | null>(null);
  const saveTimer = useRef<Record<number, number>>({});

  // Load notes for this lesson (per user — synced across devices).
  useEffect(() => {
    let active = true;
    setLoaded(false);
    api
      .notes(courseId, lessonId)
      .then((r) => {
        if (active) {
          setNotes(r.notes);
          setLoaded(true);
        }
      })
      .catch(() => active && setLoaded(true));
    return () => {
      active = false;
    };
  }, [courseId, lessonId]);

  const page = () => pageRef.current?.parentElement ?? null;

  /** The free-space zones beside the content column, in page coordinates.
   *  Only meaningful when the content column is centered (margins on BOTH
   *  sides): in split mode the "right zone" would be the workbench panel,
   *  so no zones are reported there and notes float freely. */
  const marginZones = useCallback((): {
    left: number;
    right: number;
    /** Center of the content column — the zone choice flips at this x. */
    center: number;
    /** Where the left band begins: after the rail when it is open. */
    leftStart: number;
  } | null => {
    const el = page();
    if (!el) return null;
    const content = el.querySelector<HTMLElement>(".zen-body, .lesson-content");
    if (!content) return null;
    const p = el.getBoundingClientRect();
    const c = content.getBoundingClientRect();
    const contentCenter = c.left + c.width / 2 - p.left;
    const pageCenter = p.width / 2;
    if (Math.abs(contentCenter - pageCenter) > 80) return null; // split mode
    // The lesson rail floats in the left margin while it is open. A note
    // created at the page edge would land UNDERNEATH it, so the left band
    // starts after the rail.
    const rail = el.querySelector<HTMLElement>(".lesson-rail");
    const railRight = rail
      ? Math.round(rail.getBoundingClientRect().right - p.left)
      : 0;
    return {
      left: Math.round(c.left - p.left),
      right: Math.round(p.right - c.right),
      center: Math.round(contentCenter),
      leftStart: rail ? railRight + GAP : GAP,
    };
  }, []);

  /** Clamp (x,y) into the margin zone nearest the note's center; falls back
   *  to free movement when no margin is wide enough for a note. Dragging
   *  across the content column's midline flips the note to the other side. */
  const clampPos = useCallback(
    (x: number, y: number): { x: number; y: number } => {
      const el = page();
      if (!el) return { x, y };
      const pageW = el.clientWidth;
      const pageH = Math.max(el.scrollHeight, el.clientHeight);
      const zones = marginZones();
      let cx = Math.min(Math.max(x, 0), Math.max(pageW - NOTE_W, 0));
      if (zones) {
        const leftFits = zones.left - zones.leftStart - GAP >= NOTE_W;
        const rightFits = zones.right >= NOTE_W + GAP * 2;
        if (leftFits && !rightFits) {
          cx = Math.min(Math.max(x, zones.leftStart), zones.left - GAP - NOTE_W);
        } else if (rightFits && !leftFits) {
          cx = Math.min(Math.max(x, pageW - zones.right + GAP), pageW - NOTE_W - GAP);
        } else if (leftFits && rightFits) {
          // Nearest zone by the note's center — crossing the content column
          // midline flips it to the other margin.
          if (x + NOTE_W / 2 < zones.center) {
            cx = Math.min(Math.max(x, zones.leftStart), zones.left - GAP - NOTE_W);
          } else {
            cx = Math.min(
              Math.max(x, pageW - zones.right + GAP),
              pageW - NOTE_W - GAP
            );
          }
        }
      }
      return {
        x: cx,
        y: Math.min(Math.max(y, 0), Math.max(pageH - NOTE_H - 8, 0)),
      };
    },
    [marginZones]
  );

  // Re-clamp on resize (margin geometry changes with the viewport).
  useEffect(() => {
    const onResize = () =>
      setNotes((ns) =>
        ns.map((n) => {
          const c = clampPos(n.x, n.y);
          return c.x === n.x && c.y === n.y ? n : { ...n, ...c };
        })
      );
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [clampPos]);

  // ---- drag ----
  const onDragStart = (e: React.PointerEvent, note: StickyNote) => {
    if (window.innerWidth < 900) return; // wall mode on phones/tablets
    if ((e.target as HTMLElement).closest(".sticky-text, .sticky-tools, .sticky-colors"))
      return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { id: note.id, dx: e.clientX, dy: e.clientY, origX: note.x, origY: note.y, moved: false };
    setDragId(note.id);
  };

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const { x, y } = clampPos(d.origX + (e.clientX - d.dx), d.origY + (e.clientY - d.dy));
      if (x !== d.origX || y !== d.origY) d.moved = true;
      setNotes((ns) => ns.map((n) => (n.id === d.id ? { ...n, x, y } : n)));
    };
    const up = () => {
      const d = drag.current;
      drag.current = null;
      setDragId(null);
      if (d?.moved) {
        const n = notesRef.current.find((x) => x.id === d.id);
        if (n) api.updateNote(courseId, lessonId, d.id, { x: n.x, y: n.y }).catch(() => {});
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [clampPos, courseId, lessonId]);

  // keep a live copy of notes for the pointerup handler
  const notesRef = useRef(notes);
  notesRef.current = notes;

  // ---- mutations ----
  const patchNote = (id: number, patch: Partial<Pick<StickyNote, "x" | "y" | "color" | "text">>) => {
    setNotes((ns) => ns.map((n) => (n.id === id ? { ...n, ...patch } : n)));
    if (saveTimer.current[id]) clearTimeout(saveTimer.current[id]);
    saveTimer.current[id] = window.setTimeout(() => {
      api.updateNote(courseId, lessonId, id, patch).catch(() => {});
      delete saveTimer.current[id];
    }, 400);
  };

  const flushText = (id: number) => {
    if (saveTimer.current[id]) {
      clearTimeout(saveTimer.current[id]);
      delete saveTimer.current[id];
    }
    const n = notesRef.current.find((x) => x.id === id);
    if (n) api.updateNote(courseId, lessonId, id, { text: n.text }).catch(() => {});
  };

  /** First free slot below (x0,y0): descends until no existing note
   *  overlaps the 190x120 footprint (bounded). New notes never cover
   *  older ones. */
  const findFreeSpot = useCallback(
    (x0: number, y0: number): { x: number; y: number } => {
      let x = x0;
      let y = y0;
      for (let tries = 0; tries < 12; tries++) {
        const hit = notesRef.current.find(
          (n) => Math.abs(n.x - x) < NOTE_W && Math.abs(n.y - y) < NOTE_H
        );
        if (!hit) return { x, y };
        y = Math.max(y, hit.y + NOTE_H + 14);
      }
      return { x, y };
    },
    []
  );

  const addNote = useCallback(async () => {
    // Never stack a second EMPTY draft: the existing empty note IS the
    // draft — focus it so the user sees where to type (the "phantom
    // sticky notes" bug was N empty notes from button spam/retries).
    const draft = notesRef.current.find((n) => n.text === "");
    if (draft) {
      const ta = page()?.querySelector<HTMLTextAreaElement>(
        `[data-note-id="${draft.id}"] .sticky-text`
      );
      ta?.focus();
      return;
    }
    const el = page();
    if (!el) return;
    const zones = marginZones();
    // Start below the lesson header so a fresh note never covers the title.
    const head = el.querySelector<HTMLElement>(".lesson-head");
    const headH = head ? head.offsetHeight + 24 : 106;
    const scrollTop = el.scrollTop || 0;
    // Prefer the left margin; fall back to right, then the left edge. With the
    // rail open the left margin starts AFTER the panel (see marginZones).
    let x = zones ? zones.leftStart : GAP;
    let y = scrollTop + headH;
    if (!zones || zones.left - zones.leftStart - GAP < NOTE_W) {
      if (zones && zones.right >= NOTE_W + GAP * 2) {
        x = el.clientWidth - zones.right + GAP;
      }
      // no margin fits (split mode, small laptops): left edge — the least
      // intrusive spot; the user drags it where they want it
    }
    const spot = findFreeSpot(x, y);
    const c = clampPos(spot.x, spot.y);
    try {
      const r = await api.createNote(courseId, lessonId, c.x, c.y, "auto");
      setNotes((ns) => [...ns, r.note]);
    } catch {
      /* server unreachable — note silently dropped */
    }
  }, [clampPos, courseId, lessonId, findFreeSpot, marginZones]);

  // The header's "＋ sticky" button bumps addTick.
  // addNote is kept behind a ref so the effect depends ONLY on addTick: a
  // note must be created exactly when the user presses the button. Depending
  // on addNote too would re-fire the effect on every lesson navigation (its
  // identity changes with courseId/lessonId) and spawn phantom empty notes
  // on lessons the user never touched.
  const addNoteRef = useRef(addNote);
  addNoteRef.current = addNote;
  useEffect(() => {
    if (addTick > 0) void addNoteRef.current();
  }, [addTick]);

  if (!loaded) return null;

  return (
    <>
      {/* desktop layer: absolute within the scrolling lesson page */}
      <div className="sticky-layer" ref={pageRef}>
        {notes.map((n) => (
          <div
            key={n.id}
            data-note-id={n.id}
            className="sticky-pos"
            style={{ left: n.x, top: n.y, zIndex: dragId === n.id ? 40 : 10 }}
          >
            <NoteView
              note={n}
              dragging={dragId === n.id}
              onDragStart={onDragStart}
              onText={(note, text) => patchNote(note.id, { text })}
              onTextBlur={(note) => flushText(note.id)}
              onColor={(note, color) => patchNote(note.id, { color })}
              onDelete={(note) => {
                void api.deleteNote(courseId, lessonId, note.id).catch(() => {});
                setNotes((ns) => ns.filter((x) => x.id !== note.id));
              }}
            />
          </div>
        ))}
      </div>
      {/* mobile wall: all notes stacked at the bottom of the lesson */}
      {notes.length > 0 && (
        <div className="sticky-wall">
          {notes.map((n) => (
            <NoteView
              key={n.id}
              data-note-id={n.id}
              note={n}
              dragging={false}
              static
              onDragStart={() => {}}
              onText={(note, text) => patchNote(note.id, { text })}
              onTextBlur={(note) => flushText(note.id)}
              onColor={(note, color) => patchNote(note.id, { color })}
              onDelete={(note) => {
                void api.deleteNote(courseId, lessonId, note.id).catch(() => {});
                setNotes((ns) => ns.filter((x) => x.id !== note.id));
              }}
            />
          ))}
        </div>
      )}
    </>
  );
}
