import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { PiCheck, PiX } from "react-icons/pi";
import { api } from "../api";
import type { CourseDetail } from "../types";

/** One detail fetch per course per session — the rail reuses the cache for an
 *  instant open and refreshes in the background on every lesson change so the
 *  solved ticks stay current. */
const courseCache = new Map<string, CourseDetail>();

/**
 * Floating lesson list for the current course (desktop only, hidden by CSS
 * below 860px). Fixed to the left edge, vertically centered, never taller
 * than ~62vh — the page yields the same width so the rail never covers the
 * reading column (see `.lesson-page.rail-open`).
 */
export default function LessonRail({
  courseId,
  lessonId,
  refreshKey = 0,
  onClose,
}: {
  courseId: string;
  lessonId: string;
  /** Bumped by the lesson page when a read mark changes, so the solved ticks
   *  refresh without a route change. */
  refreshKey?: number;
  onClose: () => void;
}) {
  const [course, setCourse] = useState<CourseDetail | null>(
    courseCache.get(courseId) ?? null
  );
  const [more, setMore] = useState(false);
  const activeRef = useRef<HTMLAnchorElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // "more below" cue: a soft fade over the last row while the list can scroll
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const update = () =>
      setMore(el.scrollHeight - el.scrollTop - el.clientHeight > 4);
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [course]);

  useEffect(() => {
    let live = true;
    api
      .course(courseId)
      .then((d) => {
        courseCache.set(courseId, d);
        if (live) setCourse(d);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [courseId, lessonId, refreshKey]);

  // Escape hides the rail — the same key that closes the palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Open with the current lesson in view — courses run to hundreds of lessons.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "center" });
  }, [course, lessonId]);

  const lessons = course?.lessons ?? [];
  const idx = lessons.findIndex((l) => l.id === lessonId);

  return (
    <aside className="lesson-rail" id="lesson-rail" aria-label="lessons">
      <div className="rail-head">
        <span className="rail-course" title={course?.title}>
          {course?.title ?? "lessons"}
        </span>
        <span className="rail-count">
          {idx >= 0 ? idx + 1 : "–"} / {lessons.length || "–"}
        </span>
        <button
          className="rail-close"
          onClick={onClose}
          title="hide lesson list"
          aria-label="hide lesson list"
        >
          <PiX size={13} />
        </button>
      </div>
      <nav className={`rail-list ${more ? "more" : ""}`} ref={listRef}>
        {lessons.map((l) => (
          <Link
            key={l.id}
            ref={l.id === lessonId ? activeRef : undefined}
            to={`/course/${courseId}/lessons/${l.id}`}
            className={`rail-row ${l.id === lessonId ? "active" : ""}`}
            aria-current={l.id === lessonId ? "page" : undefined}
            title={l.title}
          >
            <span className="rail-idx">{String(l.order).padStart(2, "0")}</span>
            <span className="rail-title">{l.title}</span>
            {l.solved && <PiCheck size={12} className="rail-ok" />}
          </Link>
        ))}
      </nav>
      {more && <span className="rail-fade" aria-hidden="true" />}
    </aside>
  );
}
