import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PiCaretDown, PiCheck } from "react-icons/pi";
import { api } from "../api";
import type { CourseSummary, LessonMeta } from "../types";
import { parseResumeFile } from "./lib/resume";
import { relay } from "./lib/relay";
import { freeModels } from "./lib/openrouter";
import { newSessionId, sessionStore, type InterviewSession } from "./lib/db";

type Step = 1 | 2 | 3;

export default function InterviewWizard() {
  const nav = useNavigate();
  const [step, setStep] = useState<Step>(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // step 1 — resume
  const [resume, setResume] = useState("");
  const [resumeName, setResumeName] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  // step 2 — modules + focus
  const [courses, setCourses] = useState<CourseSummary[] | null>(null);
  const [lessons, setLessons] = useState<Record<string, LessonMeta[]>>({});
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [focus, setFocus] = useState("");

  // step 3 — AI
  const [key, setKey] = useState("");
  const [keyState, setKeyState] = useState<"unknown" | "set" | "missing">("unknown");
  const [provider, setProvider] = useState<"openrouter" | "zen">("openrouter");
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState("");
  const [modelOpen, setModelOpen] = useState(false);

  const loadModels = useCallback(
    (p: "openrouter" | "zen") => {
      setModels([]);
      setModel("");
      if (p === "openrouter") {
        freeModels().then((list) => {
          setModels(list);
          if (list.length) setModel(list[0]);
        });
      } else {
        relay
          .models()
          .then((r) => {
            const list = (r.data ?? []).map((m) => m.id).sort();
            setModels(list);
            if (list.length) setModel("deepseek-v4-flash");
          })
          .catch(() => setModels([]));
      }
    },
    []
  );

  useEffect(() => {
    api.courses().then((r) => setCourses(r.courses)).catch(() => setCourses([]));
    relay.hasKey().then((r) => setKeyState(r.hasKey ? "set" : "missing")).catch(() => setKeyState("missing"));
    loadModels(provider);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function pickCourse(courseId: string): Promise<LessonMeta[]> {
    if (lessons[courseId]) return lessons[courseId];
    try {
      const r = await api.course(courseId);
      const ls = r.lessons ?? [];
      setLessons((m) => ({ ...m, [courseId]: ls }));
      return ls;
    } catch {
      setLessons((m) => ({ ...m, [courseId]: [] }));
      return [];
    }
  }

  function toggle(ref: string, on: boolean) {
    setSelected((s) => ({ ...s, [ref]: on }));
  }

  async function onFile(f: File | undefined) {
    if (!f) return;
    setBusy(true);
    setError("");
    try {
      const text = await parseResumeFile(f);
      setResume(text || "");
      setResumeName(f.name);
      if (!text) setError("no text found — the PDF may be a scan; paste text instead");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function saveKey() {
    setBusy(true);
    setError("");
    try {
      await relay.saveKey(key.trim());
      setKey("");
      setKeyState("set");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    const modules = Object.keys(selected).filter((k) => selected[k]);
    if (!resume.trim() && !focus.trim() && modules.length === 0) {
      setError("add a resume, a session focus, or at least one module");
      return;
    }
    if (provider === "zen" && keyState !== "set") {
      setError("save your API key first (step 3)");
      return;
    }
    setBusy(true);
    setError("");
    const session: InterviewSession = {
      id: newSessionId(),
      title: resumeName || focus.trim().slice(0, 40) || "Untitled interview",
      createdAt: Date.now(),
      resume,
      focus,
      modules,
      provider,
      messages: [],
      status: "active",
      model: model || "deepseek-v4-flash",
    };
    try {
      await sessionStore.put(session);
      nav(`/interviews/${session.id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const moduleCount = Object.keys(selected).filter((k) => selected[k]).length;

  return (
    <div className="page">
      <header className="page-head">
        <h1>new interview</h1>
        <p>step {step} of 3 — {step === 1 ? "resume" : step === 2 ? "focus & modules" : "ai setup"}</p>
      </header>

      <div className="wizard">
        <div className="wizard-steps">
          {[1, 2, 3].map((s) => (
            <button
              key={s}
              className={`wizard-step ${step === s ? "active" : ""} ${step > s ? "done" : ""}`}
              onClick={() => s < step && setStep(s as Step)}
            >
              {s}. {s === 1 ? "resume" : s === 2 ? "focus & modules" : "ai setup"}
            </button>
          ))}
        </div>

        {step === 1 && (
          <div className="wizard-body">
            <div
              className="dropzone"
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                void onFile(e.dataTransfer.files?.[0]);
              }}
            >
              <input
                ref={fileRef}
                type="file"
                accept=".pdf,.docx,.txt,.md"
                hidden
                onChange={(e) => onFile(e.target.files?.[0])}
              />
              <div className="dropzone-title">{busy ? "parsing…" : "drop your resume here (PDF / DOCX)"}</div>
              <div className="muted small">parsed entirely in your browser — it never leaves this machine</div>
            </div>
            {resumeName && (
              <div className="muted small" style={{ marginTop: 6 }}>
                {resumeName} · {resume.length.toLocaleString()} chars
              </div>
            )}
            <textarea
              className="resume-preview"
              value={resume}
              onChange={(e) => setResume(e.target.value)}
              placeholder="…or paste your resume text here"
            />
            <div className="wizard-nav">
              <button
                className="btn submit"
                onClick={() => setStep(2)}
                disabled={!resume.trim() && !focus.trim() && moduleCount === 0}
                title="you can start without a resume — focus or modules alone work too"
              >
                next
              </button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="wizard-body">
            <textarea
              className="resume-preview focus-box"
              value={focus}
              onChange={(e) => setFocus(e.target.value)}
              placeholder="Session focus (optional) — e.g. a job description, or: “focus on the XYZ project on my resume and test me on it”"
            />
            <div className="muted small" style={{ margin: "6px 0 10px" }}>
              selected {moduleCount} module{moduleCount === 1 ? "" : "s"} · lesson text is used as the interviewer's reference
            </div>
            <div className="module-tree">
              {courses === null ? (
                <div className="muted small">loading courses…</div>
              ) : (
                courses.map((c) => {
                  const ls = lessons[c.id] ?? [];
                  const loaded = lessons[c.id] !== undefined;
                  const allSel = loaded && ls.length > 0 && ls.every((l) => selected[`${c.id}/${l.id}`]);
                  const someSel = loaded && ls.some((l) => selected[`${c.id}/${l.id}`]);
                  const isOpen = !!expanded[c.id];
                  return (
                    <div key={c.id} className="module-course">
                      <button
                        className="module-course-head"
                        onClick={() => {
                          if (!loaded) void pickCourse(c.id);
                          setExpanded((m) => ({ ...m, [c.id]: !m[c.id] }));
                        }}
                      >
                        <PiCaretDown className={`chevron ${isOpen ? "open" : ""}`} size={15} />
                        <span className="module-course-title">{c.title}</span>
                        {loaded && <span className="module-course-count">{ls.length} lessons</span>}
                        <span
                          role="checkbox"
                          aria-checked={allSel}
                          className={`custom-check ${allSel ? "checked" : ""} ${someSel && !allSel ? "partial" : ""}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            void pickCourse(c.id).then((l) => {
                              for (const lesson of l) toggle(`${c.id}/${lesson.id}`, !allSel);
                            });
                          }}
                          title={allSel ? "deselect all" : "select all"}
                        >
                          <PiCheck size={12} />
                        </span>
                      </button>
                      {isOpen && (
                        <div className="module-lessons">
                          {loaded ? (
                            ls.length === 0 ? (
                              <div className="muted small">no lessons</div>
                            ) : (
                              ls.map((l) => {
                                const on = !!selected[`${c.id}/${l.id}`];
                                return (
                                  <button
                                    key={l.id}
                                    className={`module-lesson ${on ? "on" : ""}`}
                                    onClick={() => toggle(`${c.id}/${l.id}`, !on)}
                                  >
                                    <span className={`custom-check ${on ? "checked" : ""}`}>
                                      <PiCheck size={11} />
                                    </span>
                                    <span className="module-lesson-title">{l.title}</span>
                                  </button>
                                );
                              })
                            )
                          ) : (
                            <div className="muted small">loading…</div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
            <div className="wizard-nav">
              <button className="ghost" onClick={() => setStep(1)}>
                back
              </button>
              <button className="btn submit" onClick={() => setStep(3)}>
                next
              </button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="wizard-body">
            {/* provider picker — free (shared OpenRouter) vs BYOK (Zen) */}
            <div className="provider-toggle-row">
              <button
                className={`provider-opt ${provider === "openrouter" ? "active" : ""}`}
                onClick={() => {
                  setProvider("openrouter");
                  loadModels("openrouter");
                }}
              >
                <span className="provider-opt-title">Free (shared)</span>
                <span className="muted small">OpenRouter free models · no key needed</span>
              </button>
              <button
                className={`provider-opt ${provider === "zen" ? "active" : ""}`}
                onClick={() => {
                  setProvider("zen");
                  loadModels("zen");
                }}
              >
                <span className="provider-opt-title">My Key</span>
                <span className="muted small">OpenCode Zen via local relay (BYOK)</span>
              </button>
            </div>
            <div className="ai-card">
              <div className="ai-card-head">
                <span>
                  {provider === "openrouter" ? "OpenRouter · free models" : "OpenCode Zen (via local relay)"}
                </span>
                {provider === "zen" ? (
                  <span className={`pill ${keyState === "set" ? "ok" : ""}`}>
                    {keyState === "set" ? "key stored locally" : "no key yet"}
                  </span>
                ) : (
                  <span className="pill ok">free — no key needed</span>
                )}
              </div>
              {provider === "zen" ? (
                <>
                  <div className="muted small" style={{ margin: "4px 0 10px" }}>
                    your key is saved to a local file on this machine (0600) and injected by the relay at
                    127.0.0.1:3177 — it never reaches the TruCoder server or any network
                  </div>
                  {keyState !== "set" ? (
                    <div className="ai-key-row">
                      <input
                        type="password"
                        className="text-input"
                        placeholder="paste your OPENCODE_GO_API_KEY"
                        value={key}
                        onChange={(e) => setKey(e.target.value)}
                      />
                      <button className="btn submit" onClick={() => void saveKey()} disabled={busy || key.trim().length < 8}>
                        {busy ? "saving…" : "save key"}
                      </button>
                    </div>
                  ) : (
                    <div className="ai-key-row">
                      <span className="muted small">✓ key present locally</span>
                      <button
                        className="ghost small-ghost"
                        onClick={() => relay.deleteKey().then(() => setKeyState("missing"))}
                      >
                        remove
                      </button>
                    </div>
                  )}
                </>
              ) : (
                <div className="muted small" style={{ margin: "4px 0 10px" }}>
                  anyone can run an interview here with OpenRouter's free models — no key needed. Choose a
                  free model below. (Bring your own key for heavier/personal use.)
                </div>
              )}
              <div className="ai-model-row">
                <span className="muted small">model</span>
                <div className="model-picker">
                  <button
                    className="model-trigger"
                    onClick={() => setModelOpen((v) => !v)}
                    aria-expanded={modelOpen}
                  >
                    <span className="model-trigger-name">{model}</span>
                    <PiCaretDown size={14} className={`chevron ${modelOpen ? "open" : ""}`} />
                  </button>
                  {modelOpen && (
                    <>
                      <div className="model-backdrop" onClick={() => setModelOpen(false)} />
                      <div className="model-pop" role="listbox">
                        {models.length === 0 && (
                          <button
                            className="model-opt"
                            role="option"
                            onClick={() => {
                              setModel(provider === "openrouter" ? "" : "deepseek-v4-flash");
                              setModelOpen(false);
                            }}
                          >
                            {provider === "openrouter" ? "loading free models…" : "deepseek-v4-flash"}
                          </button>
                        )}
                        {models.map((m) => (
                          <button
                            key={m}
                            className={`model-opt ${m === model ? "active" : ""}`}
                            role="option"
                            onClick={() => {
                              setModel(m);
                              setModelOpen(false);
                            }}
                          >
                            {m}
                            {m === model && <PiCheck size={14} />}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
            <div className="wizard-nav">
              <button className="ghost" onClick={() => setStep(2)}>
                back
              </button>
              <button className="btn submit" onClick={() => void start()} disabled={busy}>
                {busy ? "starting…" : "start interview"}
              </button>
            </div>
          </div>
        )}

        {error && <div className="form-error">{error}</div>}
      </div>
    </div>
  );
}
