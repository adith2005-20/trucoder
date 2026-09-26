import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { PiArrowLeft, PiBookOpen, PiCheck, PiCaretRight } from "react-icons/pi";
import { api } from "../api";
import { useDocumentTitle } from "../title";
import type { CourseDetail, Difficulty } from "../types";
import Loader from "./Loader";
import Markdown from "./Markdown";

const DIFF_LABEL: Record<Difficulty, string> = {
  beginner: "beginner",
  easy: "easy",
  medium: "medium",
  hard: "hard",
};

export default function CourseDashboard() {
  const { courseId = "" } = useParams();
  const [course, setCourse] = useState<CourseDetail | null>(null);
  useDocumentTitle(course?.title);

  useEffect(() => {
    api.course(courseId).then(setCourse);
  }, [courseId]);

  if (!course) return <Loader />;

  const done = course.lessons.filter((l) => l.solved).length;
  const pct = course.lessons.length ? Math.round((done / course.lessons.length) * 100) : 0;

  return (
    <div className="page">
      {course.folder && course.folderTitle ? (
        <nav className="crumb">
          <Link to="/" className="crumb-link">
            <PiArrowLeft size={13} /> all courses
          </Link>
          <span className="crumb-sep" aria-hidden="true">/</span>
          <Link to={`/folder/${course.folder}`} className="crumb-link">
            {course.folderTitle}
          </Link>
        </nav>
      ) : (
        <Link to="/" className="back">
          <PiArrowLeft size={14} /> all courses
        </Link>
      )}

      <header className="course-head">
        <h1>{course.title}</h1>
        <p className="muted">{course.description}</p>
      </header>

      <div className="progress">
        <div className="progress-label">
          <span>
            {done} of {course.lessons.length} lessons
          </span>
          <span className="muted">{pct}%</span>
        </div>
        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${pct}%` }} />
        </div>
      </div>

      {course.body && (
        <div className="syllabus">
          <Markdown>{course.body}</Markdown>
        </div>
      )}

      <ol className="roadmap">
        {course.lessons.map((l) => (
          <li key={l.id}>
            <Link to={`/course/${course.id}/lessons/${l.id}`} className="lesson-row">
              <span className={`lesson-state ${l.solved ? "done" : ""}`}>
                {l.solved ? (
                  <PiCheck size={16} />
                ) : l.hasExercise ? (
                  String(l.order).padStart(2, "0")
                ) : (
                  <PiBookOpen size={15} />
                )}
              </span>
              <span className="lesson-info">
                <span className="lesson-title">{l.title}</span>
                <span className="lesson-tags">
                  {!l.hasExercise && <span className="tag">reading</span>}
                  {l.tags.map((t) => (
                    <span key={t} className="tag">
                      {t}
                    </span>
                  ))}
                </span>
              </span>
              <span className={`diff diff-${l.difficulty}`}>
                {DIFF_LABEL[l.difficulty]}
              </span>
              <PiCaretRight size={14} className="row-arrow" />
            </Link>
          </li>
        ))}
      </ol>
    </div>
  );
}
