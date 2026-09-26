import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { PiArrowRight } from "react-icons/pi";
import { api } from "../api";
import { useDocumentTitle } from "../title";
import type { ContinueTarget, CourseSummary, FolderSummary } from "../types";
import CourseCard from "./CourseCard";
import FolderCard from "./FolderCard";
import GdEasterEgg from "./GdEasterEgg";
import SectionTabs from "./SectionTabs";
import Loader from "./Loader";

export default function CourseIndex() {
  useDocumentTitle("courses");
  const [courses, setCourses] = useState<CourseSummary[] | null>(null);
  const [folders, setFolders] = useState<FolderSummary[]>([]);
  const [cont, setCont] = useState<ContinueTarget | null>(null);
  const [err, setErr] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    setErr(false);
    api
      .courses()
      .then((r) => {
        setCourses(r.courses);
        setFolders(r.folders ?? []);
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

  // Folders hold grouped courses; everything without a folder stays in the
  // root. With no folders at all the page renders exactly as it did before
  // folders existed (one flat grid, no section labels).
  const rootCourses = courses.filter((c) => !c.folder);

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

          {folders.length > 0 && (
            <section className="index-section">
              <div className="index-label">
                folders
                <span className="index-label-count">{folders.length}</span>
              </div>
              <div className="folder-grid">
                {folders.map((f) => (
                  <FolderCard key={f.id} folder={f} />
                ))}
              </div>
            </section>
          )}

          {rootCourses.length > 0 && (
            <section className="index-section">
              {folders.length > 0 && (
                <div className="index-label">
                  courses
                  <span className="index-label-count">{rootCourses.length}</span>
                </div>
              )}
              <div className="course-grid">
                {rootCourses.map((c) => (
                  <CourseCard key={c.id} course={c} />
                ))}
              </div>
            </section>
          )}
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
