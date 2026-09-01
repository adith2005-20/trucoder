// Shared free-tier OpenRouter proxy (key held SERVER-SIDE — never in the
// browser). Any signed-in user can run interviews with OpenRouter's free
// models; the server validates the model is :free and rate-limits per IP so
// the shared key can't be abused for paid models.
import { Router, type Request, type Response } from "express";
import https from "https";
import { createRateLimiter } from "../rate-limit";

const OPENROUTER = "https://openrouter.ai/api/v1";
const key = process.env.OPENROUTER_SHARED_KEY || "";

const FREE_FALLBACK = [
  "z-ai/glm-5.2:free",
  "google/gemma-4-31b-it:free",
  "google/gemma-4-26b-a4b-it:free",
  "minimax/minimax-m3:free",
  "minimax/minimax-m2.7:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "nvidia/nemotron-3.5-lightning:free",
  "cohere/north-mini-code:free",
  "liquid/lfm-2.5-2.6b:free",
  "thinkingmachines/inkling:free",
].sort();

const isFree = (id: string) => id.endsWith(":free");

export const interviewFreeRouter = Router();

// per-IP middleware wrappers over the in-memory limiter
const listLimiter = createRateLimiter(60_000, 30);
const chatLimiter = createRateLimiter(60_000, 12);
const ipOf = (req: Request) => req.ip || req.socket.remoteAddress || "?";
const mw =
  (rl: { check: (k: string) => { allowed: boolean; retryAfterSecs: number } }) =>
  (req: Request, res: Response, next: () => void) => {
    const r = rl.check(ipOf(req));
    if (!r.allowed) {
      res.setHeader("Retry-After", String(r.retryAfterSecs));
      return res.status(429).json({ error: `too many requests — retry in ${r.retryAfterSecs}s` });
    }
    next();
  };

interviewFreeRouter.get("/free/models", mw(listLimiter), (_req, res) => {
  if (!key) return res.json([...FREE_FALLBACK]);
  https
    .get(`${OPENROUTER}/models`, { headers: { Authorization: `Bearer ${key}` } }, (up) => {
      let body = "";
      up.on("data", (c) => (body += c));
      up.on("end", () => {
        try {
          const d = JSON.parse(body) as { data?: { id: string }[] };
          const list = (d.data ?? [])
            .map((m) => m.id)
            .filter(isFree)
            .sort();
          res.json(list.length ? list : FREE_FALLBACK);
        } catch {
          res.json(FREE_FALLBACK);
        }
      });
    })
    .on("error", () => res.json(FREE_FALLBACK));
});

interviewFreeRouter.post("/free/chat", mw(chatLimiter), (req: Request, res: Response) => {
  const model = typeof req.body?.model === "string" ? req.body.model : "";
  const messages = Array.isArray(req.body?.messages) ? (req.body.messages as { content?: unknown }[]) : null;
  if (!isFree(model)) return res.status(400).json({ error: "model not allowed on the shared free tier" });
  if (!messages || !messages.length || messages.some((m) => !m || typeof m.content !== "string"))
    return res.status(400).json({ error: "messages required" });
  if (!key) return res.status(503).json({ error: "shared OpenRouter key not configured" });

  const payload = JSON.stringify({ model, messages, stream: true });
  const req2 = https.request(
    `${OPENROUTER}/chat/completions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        "X-Title": "TruCoder Interview",
      },
      timeout: 120000,
    },
    (up) => {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-store");
      res.flushHeaders();
      if (up.statusCode && up.statusCode >= 300) {
        let body = "";
        up.on("data", (c) => (body += c));
        up.on("end", () => res.end(body));
        return;
      }
      up.pipe(res);
    }
  );
  req2.on("error", () => {
    if (!res.headersSent) res.status(502).json({ error: "upstream error" });
    else res.end();
  });
  req2.write(payload);
  req2.end();
});