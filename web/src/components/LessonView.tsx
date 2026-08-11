import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { api, ApiError, assetUrl } from "../api";
import { useDocumentTitle } from "../title";
import { PiArrowLeft, PiArrowRight, PiArrowSquareOut, PiCheck, PiRows } from "react-icons/pi";
import type {
  Block,
  CodeBlock,
  Lang,
  Lesson,
  QuizBlock as QuizBlockType,
} from "../types";
import CodeWorkbench from "./CodeWorkbench";
import FlowchartBlock from "./FlowchartBlock";
import Lightbox from "./Lightbox";
import Markdown from "./Markdown";
import Mascot from "./Mascot";
import QuizBlock from "./QuizBlock";
import Loader from "./Loader";

const LANGS: { id: Lang; label: string }[] = [
  { id: "java", label: "Java" },
  { id: "javascript", label: "JavaScript" },
  { id: "python", label: "Python" },
];

export default function LessonView() {
  const { courseId = "", lessonId = "" } = useParams();
  const [lesson, setLesson] = useState<Lesson | null>(null);
  useDocumentTitle(lesson?.title);
  const [error, setError] = useState("");
  const [zen, setZen] = useState<boolean>(() => {
    try {
      return localStorage.getItem("tc:zen") === "1";
    } catch {
      return false;
    }
  });
  const [solvedBlocks, setSolvedBlocks] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [lightbox, setLightbox] = useState<
    | { src: string; alt: string; caption?: string; w: number; h: number }
    | null
  >(null);
  const imgRefs = useRef<(HTMLImageElement | null)[]>([]);

  // Auto-mark content-only lessons when scrolled to the bottom (once per
  // visit). Short lessons that already fit the viewport mark immediately.
  // Graded lessons (exercise/quizzes) never auto-mark — they must be solved.
  // NOTE: these hooks MUST stay above the early returns (rules of hooks).
  const autoMarked = useRef(false);
  const pageRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const l = lesson;
    if (!l) return;
    const hasGraded = l.blocks.some(
      (b) => b.type === "code" || b.type === "mcq" || b.type === "mscq"
    );
    if (hasGraded || l.progress.solved) return;
    const el = pageRef.current;
    if (!el) return;
    const check = () => {
      if (autoMarked.current) return;
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 120) {
        autoMarked.current = true;
        markRead();
      }
    };
    check(); // a lesson shorter than the viewport counts as "reached the bottom"
    el.addEventListener("scroll", check, { passive: true });
    return () => el.removeEventListener("scroll", check);
  }, [lesson, courseId, lessonId]);

  useEffect(() => {
    let active = true;
    api
      .lesson(courseId, lessonId)
      .then((l) => {
        if (!active) return;
        setLesson(l);
        setSolvedBlocks(l.solvedBlocks);
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : "load failed"));
    return () => {
      active = false;
    };
  }, [courseId, lessonId]);

  if (error) return <div className="center error">{error}</div>;
  if (!lesson) return <Loader />;
  const p = lesson;

  const codeBlock = p.blocks.find((b) => b.type === "code") as
    | CodeBlock
    | undefined;
  const hasGradedBlocks =
    codeBlock !== undefined ||
    p.blocks.some((b) => b.type === "mcq" || b.type === "mscq");

  function toggleZen() {
    setZen((z) => {
      const n = !z;
      try {
        localStorage.setItem("tc:zen", n ? "1" : "0");
      } catch {
        /* ignore */
      }
      return n;
    });
  }

  async function markRead() {
    setBusy(true);
    setError("");
    try {
      await api.markRead(courseId, lessonId);
      setLesson((prev) =>
        prev ? { ...prev, progress: { ...prev.progress, solved: true } } : prev
      );
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "failed to mark as read");
      autoMarked.current = false; // allow a later scroll to retry
    } finally {
      setBusy(false);
    }
  }

  function onQuizSolved(blockIndex: number, lessonSolved: boolean) {
    setSolvedBlocks((prev) =>
      prev.includes(blockIndex) ? prev : [...prev, blockIndex]
    );
    if (lessonSolved) {
      setLesson((prev) =>
        prev ? { ...prev, progress: { ...prev.progress, solved: true } } : prev
      );
    }
  }

  const renderBlock = (b: Block, i: number) => {
    switch (b.type) {
      case "markdown":
        return (
          <div key={i} className="lesson-body">
            <Markdown>{b.content}</Markdown>
          </div>
        );
      case "code": {
        const sigs = LANGS.filter((l) => b.signature[l.id]);
        return (
          <div key={i} className="task">
            <span className="task-label">task</span>
            <p>{b.task}</p>
            {sigs.length > 0 && (
              <div className="sigs">
                {sigs.map((l) => (
                  <code key={l.id} className="sig">
                    {b.signature[l.id]}
                  </code>
                ))}
              </div>
            )}
            {b.hints.length > 0 && (
              <div className="hints">
                <div className="hints-head">
                  <span className="hints-title">hints</span>
                </div>
                <ul className="hint-list">
                  {b.hints.map((h, hi) => (
                    <li key={hi}>{h}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        );
      }
      case "mcq":
      case "mscq":
        return (
          <QuizBlock
            key={i}
            courseId={courseId}
            lessonId={lessonId}
            blockId={i}
            block={b as QuizBlockType}
            solved={solvedBlocks.includes(i)}
            onSolved={(lessonSolved) => onQuizSolved(i, lessonSolved)}
          />
        );
      case "image": {
        const src = assetUrl(courseId, b.src);
        return (
          <figure key={i} className="block-image">
            <div className="block-image-wrap">
              <img
                ref={(el) => {
                  imgRefs.current[i] = el;
                }}
                src={src}
                alt={b.alt}
              />
              <button
                className="img-expand"
                onClick={() => {
                  const el = imgRefs.current[i];
                  if (!el) return;
                  setLightbox({
                    src,
                    alt: b.alt,
                    caption: b.caption,
                    w: el.naturalWidth || 0,
                    h: el.naturalHeight || 0,
                  });
                }}
                aria-label="view fullscreen"
                title="view fullscreen"
              >
                <PiArrowSquareOut size={15} />
              </button>
            </div>
            {b.caption && <figcaption>{b.caption}</figcaption>}
          </figure>
        );
      }
      case "flowchart":
        return <FlowchartBlock key={i} block={b} />;
      default:
        return null;
    }
  };

  const flow = p.blocks.filter((b) => b.type !== "code");

  const navRow = (
    <div className="lesson-nav">
      {p.prevLesson ? (
        <Link
          to={`/course/${courseId}/lessons/${p.prevLesson.id}`}
          className="ghost"
          title={p.prevLesson.title}
        >
          <PiArrowLeft size={14} /> previous
        </Link>
      ) : (
        <span className="ghost disabled" aria-disabled="true">
          <PiArrowLeft size={14} /> previous
        </span>
      )}
      <span className="nav-count">
        {p.lessonIndex + 1} / {p.lessonCount}
      </span>
      {p.nextLesson ? (
        <Link
          to={`/course/${courseId}/lessons/${p.nextLesson.id}`}
          className="ghost"
          title={p.nextLesson.title}
        >
          next <PiArrowRight size={14} />
        </Link>
      ) : (
        <span className="ghost disabled" aria-disabled="true">
          next <PiArrowRight size={14} />
        </span>
      )}
    </div>
  );

  // Only content-only lessons (no exercise, no quizzes) get the read UI —
  // graded lessons are solved by their graded blocks; the server rejects
  // read-marking them.
  const readActions = !hasGradedBlocks && (
    <div className="read-actions">
      {p.progress.solved ? (
        <span className="read-done">
          <PiCheck size={14} /> read
        </span>
      ) : (
        <button className="btn submit" onClick={markRead} disabled={busy}>
          <PiCheck size={14} /> {busy ? "marking…" : "mark as read"}
        </button>
      )}
    </div>
  );

  return (
    <div className={`lesson-page ${zen && codeBlock ? "lesson-page-zen" : ""}`} ref={pageRef}>
      <div className="lesson-head">
        <div className="lesson-head-top">
          <Link to={`/course/${courseId}`} className="back">
            <PiArrowLeft size={14} /> course
          </Link>
          {codeBlock && (
            <button
              className="ghost"
              onClick={toggleZen}
              title={zen ? "exit zen mode" : "zen mode"}
            >
              <PiRows size={15} /> {zen ? "exit" : "zen"}
            </button>
          )}
        </div>
        <div className="lesson-head-title-row">
          <h1 className="lesson-head-title">{p.title}</h1>
          {p.progress.solved && (
            <span className="solved-badge">
              <Mascot state="correct" size={12} className="mascot-ok" />
              {codeBlock ? "solved" : hasGradedBlocks ? "completed" : "read"}
            </span>
          )}
        </div>
      </div>

      {codeBlock ? (
        zen ? (
          <div className="zen-body">
            <div className="zen-content">
              {flow.map(renderBlock)}
            </div>
            <div className="zen-editor">
              <CodeWorkbench
                courseId={courseId}
                lessonId={lessonId}
                block={codeBlock}
                lastLanguage={p.lastLanguage}
                onAccepted={() =>
                  setLesson((prev) =>
                    prev
                      ? { ...prev, progress: { ...prev.progress, solved: true } }
                      : prev
                  )
                }
              />
            </div>
            {navRow}
          </div>
        ) : (
          <PanelGroup
            direction="horizontal"
            autoSaveId="trucoder-split-h"
            className="split-group"
          >
            <Panel defaultSize={42} minSize={28} className="lesson-content">
              <div className="lesson-scroll">
                {flow.map(renderBlock)}
                {navRow}
              </div>
            </Panel>

            <PanelResizeHandle className="resize-handle" />

            <Panel defaultSize={58} minSize={42} className="workbench">
              <CodeWorkbench
                courseId={courseId}
                lessonId={lessonId}
                block={codeBlock}
                lastLanguage={p.lastLanguage}
                onAccepted={() =>
                  setLesson((prev) =>
                    prev
                      ? { ...prev, progress: { ...prev.progress, solved: true } }
                      : prev
                  )
                }
              />
            </Panel>
          </PanelGroup>
        )
      ) : (
        <div className="zen-body">
          <div className="zen-content">
            {p.blocks.map(renderBlock)}
            {readActions}
            {error && <div className="form-error">{error}</div>}
            {navRow}
          </div>
        </div>
      )}

      <Lightbox
        open={lightbox !== null}
        onClose={() => setLightbox(null)}
        label={lightbox?.caption ?? lightbox?.alt}
        contentW={lightbox?.w}
        contentH={lightbox?.h}
      >
        {(s) =>
          lightbox && (
            <img
              className="lightbox-img"
              src={lightbox.src}
              alt={lightbox.alt}
              width={lightbox.w * s}
              height={lightbox.h * s}
            />
          )
        }
      </Lightbox>
    </div>
  );
}
