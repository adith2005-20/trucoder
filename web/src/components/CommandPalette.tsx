import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { PiCheck, PiMagnifyingGlass, PiX } from "react-icons/pi";
import {
  getCommandSections,
  parseQuery,
  rankCommands,
  splitMatch,
  type Command,
  type RankedCommand,
} from "../commands";

/** Command palette (⌘K) — monkeytype-commandline-style searchable action menu.
 *  Renders whatever sections are registered in the command registry.
 *
 * Perf model (2026-09 rewrite): sections resolve once per open (cached by the
 * registrations), the query is parsed once per keystroke, every section is
 * ranked with a pre-tokenized index, and only a bounded number of rows is
 * rendered. The deferred query keeps typing instant while the list catches up,
 * and keyboard navigation walks the RENDERED rows only.
 *
 * Layout: a centred panel on desktop, a top sheet on phones (full width,
 * rounded bottom, 44px tap targets, an X instead of the esc chip). */

const THEME_LIMIT = 24;

export default function CommandPalette({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [sections, setSections] = useState<{ title: string; commands: Command[]; hideWhenEmpty?: boolean; limit?: number; groupLimit?: number }[]>([]);
  const [resolving, setResolving] = useState(false);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const deferred = useDeferredValue(query);

  // resolve sections (async thunks allowed) each time the palette opens
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    setSections([]);
    setResolving(true);
    let cancelled = false;
    (async () => {
      const resolved = await Promise.all(
        getCommandSections().map(async (s) => ({
          title: s.title,
          hideWhenEmpty: s.hideWhenEmpty,
          limit: s.limit,
          groupLimit: s.groupLimit,
          commands:
            typeof s.commands === "function"
              ? await s.commands()
              : s.commands,
        })),
      );
      if (!cancelled) {
        setSections(resolved);
        setResolving(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  // parsed once per (deferred) query — matching then walks token arrays
  const input = useMemo(() => parseQuery(deferred), [deferred]);

  // ranked rows per section; `flat` holds the rendered order for the keyboard
  const ranked = useMemo(() => {
    const flat: RankedCommand[] = [];
    const out = sections.map((s) => {
      const { rows, total } = rankCommands(input, s.commands, {
        limit: s.limit ?? (s.title === "Themes" ? THEME_LIMIT : 40),
        groupLimit: s.groupLimit ?? 6,
        hideWhenEmpty: s.hideWhenEmpty,
      });
      flat.push(...rows);
      return { title: s.title, rows, total, hidden: rows.length === 0 };
    });
    return { out, flat };
  }, [sections, input]);

  // keep the active row visible
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active, ranked]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((a) => Math.min(a + 1, ranked.flat.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => Math.max(a - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const hit = ranked.flat[active];
        if (hit) {
          onClose();
          hit.cmd.run();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, ranked, active, onClose]);

  if (!open) return null;

  // rows grouped by section, preserving flat order for navigation; a group
  // label is drawn whenever the row's group changes (course, folder, ...)
  let flatIdx = -1;
  let lastGroup: string | undefined;

  return (
    <div className="cmd-overlay" onPointerDown={onClose}>
      <div
        className="cmd-panel"
        role="dialog"
        aria-label="command palette"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="cmd-input-row">
          <PiMagnifyingGlass size={15} />
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            placeholder="search lessons, courses, settings…"
            spellCheck={false}
            autoComplete="off"
            aria-label="search"
          />
          <kbd className="cmd-esc">esc</kbd>
          <button
            type="button"
            className="cmd-close"
            onClick={onClose}
            aria-label="close search"
          >
            <PiX size={16} />
          </button>
        </div>
        <div
          className="cmd-list"
          ref={listRef}
          onMouseDown={(e) => {
            // keep focus in the input while clicking a row
            e.preventDefault();
          }}
        >
          {ranked.out.map((s) => {
            if (s.hidden) return null;
            lastGroup = undefined;
            return (
              <div className="cmd-section" key={s.title}>
                <div className="cmd-section-title">
                  <span>{s.title}</span>
                  {s.total > s.rows.length && (
                    <span className="cmd-section-count">
                      {s.rows.length} of {s.total}
                    </span>
                  )}
                </div>
                {s.rows.map(({ cmd, group }) => {
                  flatIdx += 1;
                  const idx = flatIdx;
                  const isActive = idx === active;
                  const showGroup = group !== undefined && group !== lastGroup;
                  lastGroup = group;
                  return (
                    <div key={cmd.id} className="cmd-row-wrap">
                      {showGroup && (
                        <div className="cmd-group-title">{group}</div>
                      )}
                      <button
                        data-idx={idx}
                        className={`cmd-row ${isActive ? "active" : ""}`}
                        onMouseEnter={() => setActive(idx)}
                        onClick={() => {
                          onClose();
                          cmd.run();
                        }}
                      >
                        <span className="cmd-icon">{cmd.icon}</span>
                        <span className="cmd-display">
                          {splitMatch(cmd.display, query).map((seg, i) =>
                            seg.hit ? (
                              <span key={i} className="cmd-match">
                                {seg.text}
                              </span>
                            ) : (
                              <span key={i}>{seg.text}</span>
                            )
                          )}
                        </span>
                        <span className="cmd-hint">{cmd.hint}</span>
                        {cmd.active?.() && (
                          <PiCheck size={12} className="cmd-check" />
                        )}
                        {isActive && <span className="cmd-caret" />}
                      </button>
                    </div>
                  );
                })}
              </div>
            );
          })}
          {resolving && sections.length === 0 && (
            <div className="cmd-empty">loading…</div>
          )}
          {ranked.flat.length === 0 && !resolving && (
            <div className="cmd-empty">
              {query ? <>no results for “{query}”</> : "start typing to search"}
            </div>
          )}
        </div>
        <div className="cmd-foot">
          <PiMagnifyingGlass size={11} /> search · <kbd>↑</kbd>
          <kbd>↓</kbd> navigate · <kbd>↵</kbd> run · <kbd>esc</kbd> close
        </div>
      </div>
    </div>
  );
}
