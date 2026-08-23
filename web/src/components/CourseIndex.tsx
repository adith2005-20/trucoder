import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { PiArrowRight } from "react-icons/pi";
import { api } from "../api";
import { useDocumentTitle } from "../title";
import type { ContinueTarget, CourseSummary } from "../types";
import GdEasterEgg from "./GdEasterEgg";
import SectionTabs from "./SectionTabs";
import Loader from "./Loader";

export default function CourseIndex() {
  useDocumentTitle("courses");
  const [courses, setCourses] = useState<CourseSummary[] | null>(null);
  const [cont, setCont] = useState<ContinueTarget | null>(null);
  const [err, setErr] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    setErr(false);
    api
      .courses()
      .then((r) => {
        setCourses(r.courses);
        setCont(r.continue);
      })
      .catch(() => setErr(true));
  }, [tick]);

  if (err) {
    return (
      <div className="page">
        <header className="page-head">
          <h1>courses</h1>
          <p>pick one and work through it at your own pace.</p>
        </header>
        <div className="empty">
          <div className="empty-title">couldn&apos;t load courses</div>
          <p className="muted">
            the request failed — <a href="#" onClick={(e) => { e.preventDefault(); setTick((t) => t + 1); }}>try again</a>
          </p>
        </div>
      </div>
    );
  }

  if (!courses) {
    return (
      <div className="page">
        <header className="page-head">
          <h1>courses</h1>
          <p>pick one and work through it at your own pace.</p>
        </header>
        <Loader />
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-head">
        <h1>courses</h1>
        <p>pick one and work through it at your own pace.</p>
      </header>

      <SectionTabs />

      {courses.length === 0 ? (
        <div className="empty">
          <div className="empty-title">no courses yet</div>
          <p className="muted">
            Add a course under <code>courses/&lt;id&gt;/</code> — see{" "}
            <code>courses/AGENTS.md</code>. TruCoder picks it up automatically.
          </p>
        </div>
      ) : (
        <>
          {cont && (
            <Link
              to={`/course/${cont.courseId}/lessons/${cont.lessonId}`}
              className="continue-card"
            >
              <span className="continue-label">continue</span>
              <span className="continue-copy">
                <span className="continue-course">{cont.courseTitle}</span>
                <span className="continue-separator" aria-hidden="true">/</span>
                <span className="continue-lesson">{cont.lessonTitle}</span>
              </span>
              <span className="continue-action">
                resume <PiArrowRight size={15} />
              </span>
            </Link>
          )}
          <div className="course-grid">
            {courses.map((c) => {
              const pct = c.lessonCount ? Math.round((c.solved / c.lessonCount) * 100) : 0;
              return (
                <Link key={c.id} to={`/course/${c.id}`} className="course-card">
                  <div className="course-card-title">{c.title}</div>
                  <div className="course-card-desc">{c.description}</div>
                  <div className="progress-track-sm">
                    <div className="progress-fill-sm" style={{ width: `${pct}%` }} />
                  </div>
                  <div className="course-card-meta">
                    <span>
                      {c.solved}/{c.lessonCount} done · {pct}%
                    </span>
                    <PiArrowRight size={14} />
                  </div>
                </Link>
              );
            })}
          </div>
        </>
      )}
      {/* the easter egg must live INSIDE .page — the route body is a fixed
          height flex column, so an 86vh sibling crushes .page to a sliver
          (the "where are my courses" bug, 2026-08-09). .page scrolls, so
          the egg sits at the bottom of the scroll — exactly the intended
          "scroll past the last content" behavior. */}
      <GdEasterEgg />
    </div>
  );
}
