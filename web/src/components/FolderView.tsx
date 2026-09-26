import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { PiArrowLeft, PiArrowRight } from "react-icons/pi";
import { api } from "../api";
import { useDocumentTitle } from "../title";
import type { CourseSummary, FolderSummary } from "../types";
import CourseCard from "./CourseCard";
import Loader from "./Loader";

/** A folder page: the dossier opened. The head carries the tab motif, the
 *  folder's aggregate progress and its first unsolved lesson (so a folder is
 *  one click away from resuming, not just a list); the body is the same course
 *  grid the index uses, so a course looks identical inside and outside a
 *  folder. */
export default function FolderView() {
  const { folderId } = useParams<{ folderId: string }>();
  const [courses, setCourses] = useState<CourseSummary[] | null>(null);
  const [folders, setFolders] = useState<FolderSummary[]>([]);
  const [err, setErr] = useState(false);

  useEffect(() => {
    setErr(false);
    api
      .courses()
      .then((r) => {
        setCourses(r.courses);
        setFolders(r.folders ?? []);
      })
      .catch(() => setErr(true));
  }, [folderId]);

  const folder = folders.find((f) => f.id === folderId) ?? null;
  const members = (courses ?? []).filter((c) => c.folder === folderId);
  useDocumentTitle(folder?.title ?? "folder");

  if (err) {
    return (
      <div className="page">
        <div className="empty">
          <div className="empty-title">couldn&apos;t load this folder</div>
        </div>
      </div>
    );
  }

  if (!courses) {
    return (
      <div className="page">
        <Loader />
      </div>
    );
  }

  if (!folder) {
    return (
      <div className="page">
        <div className="empty">
          <div className="empty-title">no such folder</div>
          <p className="muted">
            <Link to="/">back to all courses</Link>
          </p>
        </div>
      </div>
    );
  }

  const pct = folder.lessonCount
    ? Math.round((folder.solved / folder.lessonCount) * 100)
    : 0;
  const resume = members.find((c) => c.nextLesson);

  return (
    <div className="page folder-page">
      <nav className="crumb">
        <Link to="/" className="crumb-link">
          <PiArrowLeft size={13} /> courses
        </Link>
        <span className="crumb-sep" aria-hidden="true">/</span>
        <span className="crumb-current">{folder.title}</span>
      </nav>

      <header className="folder-page-head">
        <h1 className="folder-head-title">{folder.title}</h1>
        {folder.description && (
          <p className="folder-head-desc">{folder.description}</p>
        )}
        <div className="folder-head-stats">
          <span>{folder.courseCount} courses</span>
          <span className="dot" aria-hidden="true">·</span>
          <span>{folder.lessonCount} lessons</span>
          {resume?.nextLesson && (
            <Link
              to={`/course/${resume.id}/lessons/${resume.nextLesson.id}`}
              className="folder-resume"
            >
              resume {resume.title}
              <PiArrowRight size={13} />
            </Link>
          )}
        </div>
        <div className="folder-head-track-row">
          <div className="progress-track-sm">
            <div className="progress-fill-sm" style={{ width: `${pct}%` }} />
          </div>
          <span className="folder-head-pct">
            {folder.solved}/{folder.lessonCount} done · {pct}%
          </span>
        </div>
      </header>

      <div className="course-grid">
        {members.map((c) => (
          <CourseCard key={c.id} course={c} />
        ))}
      </div>
    </div>
  );
}
