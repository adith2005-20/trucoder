// Interview engine: context assembly + turn logic (all client-side).
import { api } from "../../api";
import { relay } from "./relay";
import { openrouterStreamChat, isFreeModel } from "./openrouter";
import type { InterviewMessage } from "./db";
import INTERVIEWER from "../prompts/interviewer.md?raw";
import REPORT_GRADER from "../prompts/report-grader.md?raw";

const RESUME_CAP = 8000; // chars of resume used in context
const MODULE_CAP = 12000; // total chars of module reference used

/** Fetch + flatten lesson text for the selected module references. */
export async function fetchModuleText(modules: string[]): Promise<string> {
  const parts: string[] = [];
  let budget = MODULE_CAP;
  for (const ref of modules) {
    const [courseId, lessonId] = ref.split("/");
    if (!courseId || !lessonId) continue;
    try {
      const lesson = await api.lesson(courseId, lessonId);
      const blocks = (lesson.blocks ?? []) as { type: string; content?: string; prompt?: string }[];
      let text = blocks
        .filter((b) => b.type === "markdown" && b.content)
        .map((b) => b.content)
        .join("\n\n");
      // keep it bounded: prefer the top of each lesson
      if (text.length > 6000) text = text.slice(0, 6000) + "\n…";
      if (budget > 0) {
        parts.push(`### ${lessonId} (${courseId})\n${text}`);
        budget -= text.length;
      }
    } catch {
      /* skip lessons that fail to load */
    }
  }
  return parts.join("\n\n");
}

export interface InterviewContext {
  resume: string;
  focus: string;
  moduleText: string;
  model: string;
}

export function buildSystemPrompt(ctx: InterviewContext): string {
  const sections: string[] = [];
  sections.push(INTERVIEWER);
  if (ctx.focus.trim()) {
    sections.push(
      `## SESSION FOCUS\n${ctx.focus.trim()}\nThis has the HIGHEST priority — steer the interview toward it.`
    );
  }
  if (ctx.resume.trim()) {
    sections.push(
      `## RESUME\n${ctx.resume.trim().slice(0, RESUME_CAP)}\n(Resume may be truncated; work with what is here.)`
    );
  }
  if (ctx.moduleText.trim()) {
    sections.push(
      `## MODULE REFERENCE\n${ctx.moduleText.trim()}\n(Reference only — you may test beyond it.)`
    );
  }
  return sections.join("\n\n");
}

/** End-of-interview grading pass (separate prompt, JSON output). */
export async function gradeInterview(
  ctx: InterviewContext,
  history: InterviewMessage[],
  onDelta?: (t: string) => void,
  provider: "openrouter" | "zen" = "zen"
): Promise<unknown> {
  const transcript = history
    .map((m) => `${m.role === "interviewer" ? "Interviewer" : "Candidate"}: ${m.content}`)
    .join("\n\n");
  const msgs = [
    { role: "system", content: REPORT_GRADER },
    {
      role: "user",
      content: `## RESUME\n${ctx.resume.trim().slice(0, RESUME_CAP)}\n\n## SESSION FOCUS\n${ctx.focus.trim() || "(none)"}\n\n## MODULE REFERENCE (course ids for recommended_modules)\n${ctx.moduleText.trim().slice(0, MODULE_CAP)}\n\n## TRANSCRIPT\n${transcript.slice(0, 60000)}\n\nReturn ONLY the JSON.`,
    },
  ];
  let acc = "";
  if (provider === "openrouter") {
    // free-tier grading: same free model or a known fallback
    const model = isFreeModel(ctx.model) ? ctx.model : "z-ai/glm-5.2:free";
    acc = await openrouterStreamChat(model, msgs, (d) => {
      acc += d;
      onDelta?.(d);
    });
  } else {
    const out = await relay.streamChat(ctx.model, msgs, (d) => {
      acc += d;
      onDelta?.(d);
    });
    acc = out || acc;
  }
  // extract JSON from the (possibly fenced) response
  const fence = acc.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1] : acc;
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: raw };
  }
}
