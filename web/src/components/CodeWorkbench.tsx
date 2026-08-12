import { useEffect, useRef, useState } from "react";
import confetti from "canvas-confetti";
import { PiClock } from "react-icons/pi";
import { api, ApiError } from "../api";
import { diffLines } from "../diff";
import type { CodeBlock, CustomTestResult, Lang, RunResult, SubmissionSummary, SubmitResult } from "../types";
import CodeEditor from "./CodeEditor";
import Mascot from "./Mascot";
import ResultPanel from "./ResultPanel";

/** A quiet, tasteful celebration: theme-colored confetti from the bottom.
 *  Respects prefers-reduced-motion — no confetti there. */
function celebrate() {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const css = getComputedStyle(document.documentElement);
  const colors = [css.getPropertyValue("--accent"), css.getPropertyValue("--ok"), css.getPropertyValue("--ink")].map((c) => c.trim());
  const base = { colors, disableForReducedMotion: true, zIndex: 120 };
  confetti({ ...base, particleCount: 70, spread: 75, origin: { x: 0.2, y: 0.75 }, startVelocity: 42, ticks: 160, scalar: 0.9 });
  confetti({ ...base, particleCount: 70, spread: 75, origin: { x: 0.8, y: 0.75 }, startVelocity: 42, ticks: 160, scalar: 0.9 });
  setTimeout(() => confetti({ ...base, particleCount: 40, spread: 100, startVelocity: 28, ticks: 140, scalar: 0.8 }), 250);
}

const LANGS: { id: Lang; label: string }[] = [
  { id: "java", label: "Java" },
  { id: "javascript", label: "JavaScript" },
  { id: "python", label: "Python" },
  { id: "cpp", label: "C++" },
];

function storageKey(courseId: string, lessonId: string, lang: string) {
  return `tc:${courseId}:${lessonId}:${lang}`;
}

export default function CodeWorkbench({
  courseId,
  lessonId,
  block,
  lastLanguage,
  onAccepted,
}: {
  courseId: string;
  lessonId: string;
  block: CodeBlock;
  lastLanguage: Lang | null;
  onAccepted: () => void;
}) {
  const isModule = block.mode === "module";
  const moduleLang = block.module?.language ?? "javascript";
  const [lang, setLang] = useState<Lang>("java");
  const [code, setCode] = useState("");
  const [run, setRun] = useState<RunResult | null>(null);
  const [submit, setSubmit] = useState<SubmitResult | null>(null);
  const [busy, setBusy] = useState<"run" | "submit" | null>(null);
  const [error, setError] = useState("");
  const [showHints, setShowHints] = useState(false);
  const [showSolution, setShowSolution] = useState(false);
  const [solution, setSolution] = useState("");
  const [solutionLoading, setSolutionLoading] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<SubmissionSummary[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [selectedAttempt, setSelectedAttempt] = useState<number | null>(null);
  const [customArgs, setCustomArgs] = useState("");
  const [customExpected, setCustomExpected] = useState("");
  const [customResult, setCustomResult] = useState<CustomTestResult | null>(null);
  const [customBusy, setCustomBusy] = useState(false);
  const byLang = useRef<Partial<Record<string, string>>>({});

  // ---- debounced localStorage saves ----
  // A synchronous setItem per keystroke janks low-end machines; the save is
  // flushed on unmount and before any operation that reads the stored value.
  const pendingSave = useRef<{ key: string; value: string } | null>(null);
  const saveTimer = useRef<number>(0);
  const flushSave = () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = 0;
    }
    const p = pendingSave.current;
    if (!p) return;
    pendingSave.current = null;
    try {
      localStorage.setItem(p.key, p.value);
    } catch {
      /* storage full/unavailable — the code still lives in state */
    }
  };
  const scheduleSave = (key: string, value: string) => {
    pendingSave.current = { key, value };
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(flushSave, 300);
  };
  useEffect(() => () => flushSave(), []);

  // ---- attempt history ----
  async function toggleHistory() {
    if (historyOpen) {
      setHistoryOpen(false);
      return;
    }
    setHistoryOpen(true);
    if (history) return;
    setHistoryLoading(true);
    try {
      const r = await api.submissions(courseId, lessonId);
      setHistory(r.submissions);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "history unavailable");
    } finally {
      setHistoryLoading(false);
    }
  }

  const selectedSubmission =
    history?.find((s) => s.id === selectedAttempt) ?? null;
  const diff =
    selectedSubmission && history
      ? diffLines(
          history[history.indexOf(selectedSubmission) + 1]?.code ??
            (block.starterCode as Record<string, string>)[
              selectedSubmission.language
            ] ??
            "",
          selectedSubmission.code
        )
      : null;

  const activeLang = isModule ? moduleLang : lang;
  const starterFor = (l: string) =>
    (block.starterCode as Record<string, string>)[l] ?? "";

  useEffect(() => {
    if (isModule) {
      const k = storageKey(courseId, lessonId, moduleLang);
      byLang.current = {};
      byLang.current[moduleLang] =
        localStorage.getItem(k) ?? starterFor(moduleLang);
      setCode(byLang.current[moduleLang] ?? "");
      setRun(null);
      setSubmit(null);
      setError("");
      setHistoryOpen(false);
      setHistory(null);
      setSelectedAttempt(null);
      return;
    }
    const langs: Lang[] = block.languages.length ? block.languages : ["java"];
    const savedLang: Lang =
      lastLanguage && langs.includes(lastLanguage) ? lastLanguage : langs[0];
    byLang.current = {};
    for (const lg of langs) {
      const k = storageKey(courseId, lessonId, lg);
      byLang.current[lg] = localStorage.getItem(k) ?? block.starterCode[lg] ?? "";
    }
    setLang(savedLang);
    setCode(byLang.current[savedLang] ?? "");
    setRun(null);
    setSubmit(null);
    setError("");
    setHistoryOpen(false);
    setHistory(null);
    setSelectedAttempt(null);
    setCustomArgs("");
    setCustomExpected("");
    setCustomResult(null);
  }, [courseId, lessonId, block, lastLanguage, isModule, moduleLang]);

  function switchLang(l: Lang) {
    if (l === lang || isModule) return;
    flushSave();
    byLang.current[lang] = code;
    setCode(byLang.current[l] ?? block.starterCode[l] ?? "");
    setLang(l);
    setRun(null);
    setSubmit(null);
    setSelectedAttempt(null);
    setCustomResult(null);
  }

  function onCodeChange(v: string) {
    setCode(v);
    byLang.current[activeLang] = v;
    scheduleSave(storageKey(courseId, lessonId, activeLang), v);
    // The displayed result no longer matches the code — drop it so the user
    // doesn't read a stale "all tests passed" for code they just changed.
    setRun(null);
    setSubmit(null);
    setSelectedAttempt(null);
    setCustomResult(null);
  }

  function resetCode() {
    flushSave();
    const starter = starterFor(activeLang);
    byLang.current[activeLang] = starter;
    setCode(starter);
    localStorage.setItem(storageKey(courseId, lessonId, activeLang), starter);
    setRun(null);
    setSubmit(null);
    setSelectedAttempt(null);
    setCustomResult(null);
  }

  async function doRun() {
    setBusy("run");
    setRun(null);
    setSubmit(null);
    setError("");
    try {
      setRun(await api.run(courseId, lessonId, activeLang, code));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "run failed");
    } finally {
      setBusy(null);
    }
  }

  async function doSubmit() {
    setBusy("submit");
    setRun(null);
    setSubmit(null);
    setError("");
    try {
      const res = await api.submit(courseId, lessonId, activeLang, code);
      setSubmit(res);
      if (res.verdict === "accepted") {
        onAccepted();
        celebrate();
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "submit failed");
    } finally {
      setBusy(null);
    }
  }

  async function doCustomTest() {
    setCustomBusy(true);
    setCustomResult(null);
    setError("");
    try {
      setCustomResult(
        await api.customTest(
          courseId,
          lessonId,
          activeLang,
          code,
          customArgs,
          customExpected
        )
      );
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "custom test failed");
    } finally {
      setCustomBusy(false);
    }
  }

  async function toggleSolution() {
    if (showSolution) {
      setShowSolution(false);
      return;
    }
    setShowSolution(true);
    if (solution) return;
    setSolutionLoading(true);
    try {
      const res = await api.solution(courseId, lessonId, activeLang);
      setSolution(res.solution);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "solution unavailable");
    } finally {
      setSolutionLoading(false);
    }
  }

  // Ctrl/Cmd+Enter = run, Ctrl/Cmd+Shift+Enter = submit (module: check).
  // Re-registered every render so the handlers always see the latest code.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key !== "Enter") return;
      e.preventDefault();
      if (isModule) doSubmit();
      else if (e.shiftKey) doSubmit();
      else doRun();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const allPassed = (r: RunResult | SubmitResult | null) =>
    !!r && r.publicTests.length > 0 && r.publicTests.every((t) => t.passed);

  return (
    <>
      <div className="editor-window">
        <div className="editor-header">
          <div className="editor-tabs">
            {isModule ? (
              <span className="lang active" title={`editing ${block.module?.entry}`}>
                {block.module?.entry ?? moduleLang}
                <span className="lang-tag">
                  {moduleLang === "typescript" ? "TS" : "JS"}
                </span>
              </span>
            ) : (
              LANGS.filter((l) => block.starterCode[l.id]).map((l) => (
                <button
                  key={l.id}
                  className={`lang ${lang === l.id ? "active" : ""}`}
                  onClick={() => switchLang(l.id)}
                >
                  {l.label}
                </button>
              ))
            )}
          </div>
          {block.hints.length > 0 && (
            <button
              className={`ghost small-ghost ${showHints ? "on" : ""}`}
              onClick={() => setShowHints((s) => !s)}
            >
              hints
            </button>
          )}
          <button className="ghost small-ghost" onClick={toggleSolution}>
            {showSolution ? "hide solution" : "solution"}
          </button>
          <button
            className={`ghost small-ghost ${historyOpen ? "on" : ""}`}
            onClick={toggleHistory}
            title="past submissions"
          >
            <PiClock size={13} /> history
          </button>
          <button className="ghost small-ghost" onClick={resetCode}>
            reset
          </button>
        </div>
        <CodeEditor language={activeLang} value={code} onChange={onCodeChange} />
      </div>

      {historyOpen && (
        <div className="history-panel">
          <div className="history-head">
            <span className="muted small">past submissions</span>
            {historyLoading && <span className="muted small">loading…</span>}
            {!historyLoading && history?.length === 0 && (
              <span className="muted small">no submissions yet — submit once and it shows up here</span>
            )}
          </div>
          {history && history.length > 0 && (
            <>
              <div className="history-list">
                {history.map((s) => (
                  <button
                    key={s.id}
                    className={`history-row ${selectedAttempt === s.id ? "active" : ""}`}
                    onClick={() => setSelectedAttempt(s.id)}
                  >
                    <span className={`verdict-chip verdict-${s.verdict}`}>
                      {s.verdict}
                    </span>
                    <span className="history-meta">
                      {s.language} · {s.publicPassed}/{s.publicTotal} pub
                      {s.privateTotal > 0 && ` · ${s.privatePassed}/${s.privateTotal} hidden`}
                    </span>
                    <span className="muted small">
                      {new Date(s.createdAt).toLocaleString()}
                    </span>
                  </button>
                ))}
              </div>
              {selectedSubmission && (
                <div className="history-detail">
                  <div className="history-detail-head">
                    <span className="muted small">
                      diff vs the attempt before it {diff && diff.filter((l) => l.kind !== "same").length === 0 && "— identical code"}
                    </span>
                    <button
                      className="ghost small-ghost"
                      onClick={() => {
                        flushSave();
                        byLang.current[activeLang] = selectedSubmission.code;
                        setCode(selectedSubmission.code);
                        scheduleSave(
                          storageKey(courseId, lessonId, activeLang),
                          selectedSubmission.code
                        );
                        setRun(null);
                        setSubmit(null);
                        setSelectedAttempt(null);
                        setCustomResult(null);
                      }}
                    >
                      use this code
                    </button>
                  </div>
                  {diff && diff.some((l) => l.kind !== "same") ? (
                    <pre className="history-diff">
                      {diff
                        .filter((l) => l.kind !== "same")
                        .map((l, i) => (
                          <div key={i} className={`diff-${l.kind}`}>
                            {l.kind === "add" ? "+" : "−"} {l.text}
                          </div>
                        ))}
                    </pre>
                  ) : (
                    <pre className="history-code">{selectedSubmission.code}</pre>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {showHints && (
        <div className="hints-box">
          {block.hints.map((h, i) => (
            <div key={i} className="hint">
              <span className="muted">hint {i + 1}:</span> {h}
            </div>
          ))}
        </div>
      )}
      {showSolution && (
        <div className="solution-box">
          <div className="solution-head">
            <span className="muted">reference solution</span>
            <button className="ghost small-ghost" onClick={() => setShowSolution(false)}>
              hide
            </button>
          </div>
          {solutionLoading ? (
            <div className="muted small">loading…</div>
          ) : (
            <pre className="solution-code">{solution}</pre>
          )}
        </div>
      )}

      <div className="actions">
        {isModule ? (
          <button className="btn submit" onClick={doSubmit} disabled={busy !== null}>
            <Mascot size={14} state={busy === "submit" ? "running" : "idle"} />
            {busy === "submit" ? "checking…" : "check"}
          </button>
        ) : (
          <>
            <button className="btn run" onClick={doRun} disabled={busy !== null || customBusy}>
              <Mascot size={14} state={busy === "run" ? "running" : "idle"} />
              {busy === "run" ? "running…" : "run"}
            </button>
            <button className="btn submit" onClick={doSubmit} disabled={busy !== null || customBusy}>
              <Mascot size={14} state={busy === "submit" ? "running" : "idle"} />
              {busy === "submit" ? "submitting…" : "submit"}
            </button>
          </>
        )}
        <span className="muted small">
          {isModule
            ? "check = run the visible test suite on a real node server"
            : "run = visible tests · submit = hidden too"}
        </span>
      </div>

      {!isModule && (
        <div className="custom-test">
          <div className="custom-test-head muted small">
            custom test — run your own input against your code
          </div>
          <div className="custom-test-fields">
            <textarea
              className="custom-test-input"
              rows={2}
              placeholder="args — JSON array, e.g. [4, 80, 50]"
              value={customArgs}
              onChange={(e) => {
                setCustomArgs(e.target.value);
                setCustomResult(null);
              }}
              spellCheck={false}
            />
            <textarea
              className="custom-test-input"
              rows={2}
              placeholder="expected output, e.g. 7"
              value={customExpected}
              onChange={(e) => {
                setCustomExpected(e.target.value);
                setCustomResult(null);
              }}
              spellCheck={false}
            />
          </div>
          <div className="custom-test-actions">
            <button
              className="ghost"
              onClick={doCustomTest}
              disabled={busy !== null || customBusy}
            >
              {customBusy ? "running…" : "run custom test"}
            </button>
            {customResult && (
              <span
                className={`custom-test-verdict ${customResult.passed ? "ok" : "err"}`}
              >
                {customResult.passed ? (
                  "pass — output matches"
                ) : customResult.error ? (
                  customResult.error
                ) : (
                  <>
                    expected {customResult.expected} · got{" "}
                    {customResult.actual ?? "(none)"}
                  </>
                )}
              </span>
            )}
          </div>
        </div>
      )}

      {error && <div className="form-error">{error}</div>}
      <ResultPanel
        run={run}
        submit={submit}
        output={(run ?? submit)?.output}
        preview={block.module?.preview}
        previewUnlocked={allPassed(submit) || allPassed(run)}
      />
    </>
  );
}
