import { Link } from "react-router-dom";
import { PiArrowRight } from "react-icons/pi";
import type { FolderSummary } from "../types";

/** A folder on the courses index — drawn as a dossier: a manila tab on the
 *  top-left edge, a stack of documents tucked into the body, and the folder's
 *  aggregate progress on the front cover.
 *
 *  On hover the documents slide up out of the folder with a small stagger and
 *  tilt (the "open the dossier" motion), the tab widens a hair, and the cover
 *  lifts. Nothing colour-loud happens: hairline borders, muted document rules,
 *  accent only on the progress fill, the title and the arrow.
 *
 *  Touch devices have no hover, so `(hover: none)` in CSS parks the documents
 *  in the fanned-out state — the dossier still reads as a dossier. */
export default function FolderCard({ folder }: { folder: FolderSummary }) {
  const pct = folder.lessonCount
    ? Math.round((folder.solved / folder.lessonCount) * 100)
    : 0;
  return (
    <Link to={`/folder/${folder.id}`} className="folder-card">
      <span className="folder-tab" aria-hidden="true" />
      <span className="folder-head">
        <span className="folder-title">{folder.title}</span>
        <span className="folder-count">
          {folder.courseCount} {folder.courseCount === 1 ? "course" : "courses"}
        </span>
      </span>
      <span className="folder-desc">{folder.description}</span>
      <span className="folder-papers" aria-hidden="true">
        <span className="folder-paper paper-1" />
        <span className="folder-paper paper-2" />
        <span className="folder-paper paper-3" />
      </span>
      <span className="folder-foot">
        <span className="progress-track-sm">
          <span className="progress-fill-sm" style={{ width: `${pct}%` }} />
        </span>
        <span className="course-card-meta">
          <span>
            {folder.solved}/{folder.lessonCount} lessons · {pct}%
          </span>
          <PiArrowRight size={14} />
        </span>
      </span>
    </Link>
  );
}
