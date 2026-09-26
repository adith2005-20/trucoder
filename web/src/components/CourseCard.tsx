import { Link } from "react-router-dom";
import { PiArrowRight } from "react-icons/pi";
import type { CourseSummary } from "../types";

/** One course row on the index / inside a folder. The card is borderless and
 *  hairline-separated in the grid: hover tints the surface, moves the title to
 *  the accent colour and slides the arrow — the same behaviour in both places,
 *  so a course looks identical wherever it lives. */
export default function CourseCard({ course }: { course: CourseSummary }) {
  const pct = course.lessonCount
    ? Math.round((course.solved / course.lessonCount) * 100)
    : 0;
  return (
    <Link to={`/course/${course.id}`} className="course-card">
      <div className="course-card-title">{course.title}</div>
      <div className="course-card-desc">{course.description}</div>
      <div className="progress-track-sm">
        <div className="progress-fill-sm" style={{ width: `${pct}%` }} />
      </div>
      <div className="course-card-meta">
        <span>
          {course.solved}/{course.lessonCount} done · {pct}%
        </span>
        <PiArrowRight size={14} />
      </div>
    </Link>
  );
}
