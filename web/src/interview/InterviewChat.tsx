import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useChat, type Message } from "@ai-sdk/react";
import { PiMicrophone, PiMicrophoneSlash, PiStopCircle, PiPencilLine } from "react-icons/pi";
import { sessionStore, type InterviewSession } from "./lib/db";
import { fetchModuleText, buildSystemPrompt, gradeInterview } from "./lib/engine";
import { parseQuizzes, letter, type ChatQuiz } from "./lib/quiz";
import { startRecording } from "./lib/stt";
import { openrouterStreamChat } from "./lib/openrouter";
import InterviewReport from "./InterviewReport";
import Markdown from "../components/Markdown";
import BlackboardModal from "./BlackboardModal";

const RELAY = "http://127.0.0.1:3177";
// Only the last N messages are sent to the model per request — the SDK
// otherwise resends the full history, which grows without bound on long
// interviews (16 turns ≈ 32 messages is plenty of conversational context;
// resume/modules live in the system prompt).
const SENT_HISTORY = 32;

function errMsg(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e);
}

function toSdk(s: InterviewSession): Message[] {
  return s.messages
    .filter((m) => !m.content.startsWith("‹control›"))
    .map((m, i) => ({
      id: `m${i}`,
      role: m.role === "interviewer" ? "assistant" : "user",
      content: m.content,
    }));
}

function toSession(msgs: Message[]): InterviewSession["messages"] {
  return msgs
    .filter((m) => (m.role === "assistant" || m.role === "user") && !m.content.startsWith("‹control›"))
    .map((m) => ({
      role: m.role === "assistant" ? "interviewer" as const : "user" as const,
      content: m.content,
    }));
}

function isControl(m: Message): boolean {
  return m.role === "user" && m.content.startsWith("‹control›");
}

/** A quiz embedded in an interviewer message: click an option to answer. */
function ChatQuizBlock({ quiz, onAnswer }: { quiz: ChatQuiz; onAnswer: (i: number) => void }) {
  const [picked, setPicked] = useState<number | null>(null);
  return (
    <div className="chat-quiz">
      <div className="chat-quiz-q">{quiz.question}</div>
      <div className="chat-quiz-opts">
        {quiz.options.map((o, i) => {
          const state = picked === null ? "idle" : i === quiz.answer ? "correct" : i === picked ? "wrong" : "idle";
          return (
            <button
              key={i}
              className={`chat-quiz-opt ${state}`}
              disabled={picked !== null}
              onClick={() => {
                setPicked(i);
                onAnswer(i);
              }}
            >
              <span className="chat-quiz-letter">{letter(i)}</span>
              <span>{o}</span>
              {state === "correct" && <span className="chat-quiz-mark">✓</span>}
              {state === "wrong" && <span className="chat-quiz-mark">✗</span>}
            </button>
          );
        })}
      </div>
      {picked !== null && (
        <div className={`chat-quiz-verdict ${picked === quiz.answer ? "right" : "wrong"}`}>
          {picked === quiz.answer ? "correct — nice." : "not quite — the interviewer will unpack it."}
        </div>
      )}
    </div>
  );
}

/** Interviewer message with rich rendering: markdown (code fences) + quizzes. */
function AssistantMessage({ content, onQuizAnswer }: { content: string; onQuizAnswer: (i: number) => void }) {
  const { quizzes, text } = parseQuizzes(content);
  return (
    <div className="chat-bubble">
      {text && <Markdown>{text}</Markdown>}
      {quizzes.map((q, i) => (
        <ChatQuizBlock key={i} quiz={q} onAnswer={onQuizAnswer} />
      ))}
    </div>
  );
}

/** Auto-growing textarea. */
function AutosizeInput({
  value,
  onChange,
  onKeyDown,
  disabled,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  disabled: boolean;
  placeholder: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.35)) + "px";
  }, [value]);
  return (
    <textarea
      ref={ref}
      className="chat-input"
      placeholder={placeholder}
      value={value}
      rows={1}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      disabled={disabled}
    />
  );
}

export default function InterviewChat() {
  const { id } = useParams();
  const [session, setSession] = useState<InterviewSession | null>(null);
  const [ctx, setCtx] = useState<{ resume: string; focus: string; moduleText: string; model: string } | null>(null);
  const [error, setError] = useState("");
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [boardOpen, setBoardOpen] = useState(false);
  const [orBusy, setOrBusy] = useState(false);
  const [seeded, setSeeded] = useState(false);
  const recRef = useRef<{ stop: () => Promise<string>; cancel: () => void } | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const systemRef = useRef("");
  const modelRef = useRef("deepseek-v4-flash");

  const chat = useChat({
    api: RELAY + "/v1/chat/text",
    streamProtocol: "text",
    body: { system: systemRef.current, model: modelRef.current },
    // Keep the request bounded even though the SDK keeps the full list for
    // the UI: slice the messages that actually go to the relay.
    experimental_prepareRequestBody: ({ messages, requestBody }) => ({
      ...(requestBody as Record<string, unknown>),
      messages: messages.slice(-SENT_HISTORY).map((m) => ({
        role: m.role,
        content: typeof m.content === "string" ? m.content : "",
      })),
    }),
    onError: (e) => setError(errMsg(e)),
  });

  useEffect(() => {
    if (!id) return;
    // Fresh mount state per session id — React Router reuses this component
    // between /interviews/:id routes, so stale session/seeded state must not
    // leak across ids.
    setSession(null);
    setSeeded(false);
    sessionStore.get(id).then((s) => {
      setSession(s ?? null);
      if (s) {
        fetchModuleText(s.modules).then((moduleText) => {
          const c = { resume: s.resume, focus: s.focus, moduleText, model: s.model };
          setCtx(c);
          systemRef.current = buildSystemPrompt(c);
          modelRef.current = s.model;
        });
      }
    });
  }, [id]);

  // seed the SDK chat once the session + context are ready
  useEffect(() => {
    if (!session || !ctx || seeded) return;
    setSeeded(true);
    chat.setMessages(toSdk(session));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id, ctx]);

  // opening question
  useEffect(() => {
    if (
      seeded &&
      session &&
      session.messages.length === 0 &&
      chat.messages.length === 0 &&
      !chat.isLoading &&
      !orBusy &&
      systemRef.current
    ) {
      if (or && session.provider === "openrouter") {
        orTurn("‹control›(The interview is starting — greet me and ask your opening question.)");
      } else {
        void chat.append({ role: "user", content: "‹control›(The interview is starting — greet me and ask your opening question.)" });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seeded, session?.id, chat.messages.length, chat.isLoading]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chat.messages.length, chat.isLoading]);

  // Persist the transcript once per completed turn. NOTE: this must NOT be
  // done in useChat's onFinish — in @ai-sdk/react 0.0.70 that callback is
  // captured in a first-render closure (useCallback([]) inside the SDK),
  // so it would always see the initial empty messages and wipe the saved
  // session after every turn. An effect on the isLoading edge always sees
  // the latest render's chat.messages.
  const prevLoading = useRef(chat.isLoading);
  useEffect(() => {
    const finished = prevLoading.current && !chat.isLoading;
    prevLoading.current = chat.isLoading;
    if (!finished || !seeded) return;
    setSession((prev) => {
      if (!prev) return prev;
      const next = { ...prev, messages: toSession(chat.messages) };
      void sessionStore.put(next);
      return next;
    });
  }, [chat.isLoading, chat.messages, seeded]);

  function orTurn(text: string) {
    const sys = systemRef.current;
    const model = session?.model || "";
    // build history BEFORE appending so the new user text is the last message
    const prior = chat.messages.map((m) => ({
      role: (m.role === "assistant" ? "assistant" : "user") as "assistant" | "user",
      content: m.content,
    }));
    const history = [...prior, { role: "user" as const, content: text }];
    const aid = "m" + Math.random().toString(36).slice(2);
    setOrBusy(true);
    setError("");
    chat.setMessages((m) => [
      ...m,
      { id: "m" + Math.random().toString(36).slice(2), role: "user", content: text },
      { id: aid, role: "assistant", content: "" },
    ]);
    void (async () => {
      try {
        const full = await openrouterStreamChat(
          model,
          [{ role: "system", content: sys }, ...history],
          (d) => chat.setMessages((cur) => cur.map((x) => (x.id === aid ? { ...x, content: x.content + d } : x))),
          undefined
        );
        chat.setMessages((cur) => cur.map((x) => (x.id === aid ? { ...x, content: full } : x)));
        setSession((prev) => {
          if (!prev) return prev;
          const next = { ...prev, messages: toSession(chat.messages) };
          void sessionStore.put(next);
          return next;
        });
      } catch (e) {
        setError(errMsg(e));
        chat.setMessages((cur) => cur.filter((x) => x.id !== aid));
      } finally {
        setOrBusy(false);
      }
    })();
  }

  function send() {
    const text = chat.input.trim();
    if (!text || streaming) return;
    chat.setInput("");
    if (or) {
      orTurn(text);
      setError("");
      return;
    }
    chat.append({ role: "user", content: text }); // clear happens in the SDK
    setError("");
  }

  function control(kind: "hint" | "go-deeper" | "skip") {
    if (streaming) return;
    const hint =
      kind === "hint"
        ? "‹control›(The candidate asked for a hint. Give ONE small hint — never the full answer.)"
        : kind === "go-deeper"
          ? "‹control›(The candidate wants to go DEEPER on the current topic. Ask a harder, more subtle follow-up — trade-offs, edge cases, design decisions. One question.)"
          : "‹control›(The candidate wants to move on. Wrap up the topic in one short sentence and open the next topic with one question.)";
    if (or) {
      orTurn(hint);
      return;
    }
    void chat.append({ role: "user", content: hint });
  }

  async function endInterview() {
    if (!session || !ctx || chat.isLoading) return;
    setError("");
    try {
      const report = await gradeInterview(ctx, toSession(chat.messages), undefined, session.provider);
      setSession((prev) => {
        if (!prev) return prev;
        const next = { ...prev, status: "done" as const, report };
        void sessionStore.put(next);
        return next;
      });
    } catch (e) {
      setError(errMsg(e));
    }
  }

  function toggleMic() {
    if (listening) {
      // stop recording → transcribe → fill the input
      const rec = recRef.current;
      if (rec) {
        setListening(false);
        setTranscribing(true);
        setError("");
        rec
          .stop()
          .then((text) => {
            if (text) chat.setInput(text);
            else setError("no speech heard — try again");
          })
          .catch((e: unknown) => setError(errMsg(e)))
          .finally(() => setTranscribing(false));
      }
      return;
    }
    setError("");
    try {
      const rec = startRecording();
      recRef.current = rec;
      setListening(true);
    } catch (e) {
      setError(errMsg(e));
    }
  }

  const streaming = chat.isLoading || orBusy;
  const or = !!session && session.provider === "openrouter";
  const lastAssistant = [...chat.messages].reverse().find((m) => m.role === "assistant");

  if (!session) {
    return (
      <div className="page">
        <div className="empty">
          <div className="empty-title">session not found</div>
          <Link to="/interviews" className="btn run">
            back to interviews
          </Link>
        </div>
      </div>
    );
  }

  if (session.status === "done" && session.report) {
    return <InterviewReport session={session} />;
  }

  return (
    <div className="page interview-page">
      <header className="page-head interview-head">
        <div>
          <h1>{session.title}</h1>
          <p className="muted small">
            {session.model} · {session.modules.length} module{session.modules.length === 1 ? "" : "s"} referenced
            {session.focus ? " · custom focus" : ""}
          </p>
        </div>
        <div className="interview-head-actions">
          <button className="ctrl-btn" onClick={() => control("hint")} disabled={streaming}>
            hint
          </button>
          <button className="ctrl-btn" onClick={() => control("go-deeper")} disabled={streaming}>
            go deeper
          </button>
          <button className="ctrl-btn" onClick={() => control("skip")} disabled={streaming}>
            skip topic
          </button>
          <button className="ctrl-btn primary" onClick={() => void endInterview()} disabled={streaming}>
            end interview
          </button>
        </div>
      </header>

      <div className="chat">
        {chat.messages.length === 0 && !streaming && (
          <div className="chat-empty muted">the interviewer will open with a question from your resume…</div>
        )}
        {chat.messages.map((m) =>
          isControl(m) ? null : m.role === "assistant" ? (
            <div key={m.id} className="chat-msg interviewer">
              <AssistantMessage
                content={m.content}
                onQuizAnswer={(i) => void chat.append({ role: "user", content: `My answer: ${letter(i)}` })}
              />
            </div>
          ) : m.role === "user" ? (
            <div key={m.id} className="chat-msg user">
              <div className="chat-bubble">{m.content}</div>
            </div>
          ) : null
        )}
        {streaming && lastAssistant && lastAssistant.content.length === 0 && (
          <div className="chat-msg interviewer">
            <div className="chat-bubble typing">
              <span className="typing-dots" />
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {error && <div className="form-error chat-error">{error}</div>}

      <BlackboardModal
        open={boardOpen}
        onClose={() => setBoardOpen(false)}
        onSend={(content) => {
          void chat.append({ role: "user", content });
          chat.setInput("");
        }}
      />

      <div className="composer">
        <AutosizeInput
          value={chat.input}
          onChange={(v) => chat.setInput(v)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          disabled={streaming}
          placeholder="your answer… (or speak it with the mic)"
        />
        <button
          className="icon-btn"
          onClick={() => setBoardOpen(true)}
          title="open the blackboard (draw → mermaid)"
        >
          <PiPencilLine size={17} />
        </button>
        <button
          className={`icon-btn ${listening || transcribing ? "on" : ""}`}
          onClick={toggleMic}
          title={listening ? "stop & transcribe" : "speak your answer (local whisper)"}
        >
          {listening ? <PiMicrophoneSlash size={17} /> : <PiMicrophone size={17} />}
          {(listening || transcribing) && (
            <span className="mic-live">{transcribing ? "transcribing…" : "recording…"}</span>
          )}
        </button>
        {streaming ? (
          <button className="stop-btn" onClick={() => chat.stop()} title="stop generating">
            <PiStopCircle size={16} /> stop
          </button>
        ) : (
          <button className="send-btn" onClick={send} disabled={!chat.input.trim()}>
            send
          </button>
        )}
      </div>
    </div>
  );
}
