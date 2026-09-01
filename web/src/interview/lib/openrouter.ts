// Shared, free-only OpenRouter access — proxied through the TruCoder SERVER so
// the shared key never enters the browser. The server validates the model is
// :free, rate-limits per IP, and injects the key.
const FREE_API = "/api/interview/free";

/** Fetch the server-side curried list of free OpenRouter models. */
export async function freeModels(): Promise<string[]> {
  try {
    const r = await fetch(`${FREE_API}/models`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return [];
    const d = (await r.json()) as string[];
    return Array.isArray(d) ? d : [];
  } catch {
    return [];
  }
}

export function isFreeModel(id: string): boolean {
  return id.endsWith(":free");
}

/** OpenAI-SSE streaming chat, proxied via the server (key held server-side). */
export async function openrouterStreamChat(
  model: string,
  messages: { role: string; content: string }[],
  onDelta: (text: string) => void,
  signal?: AbortSignal
): Promise<string> {
  if (!isFreeModel(model)) throw new Error(`model not allowed for shared free tier: ${model}`);
  const res = await fetch(`${FREE_API}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages }),
    signal,
  });
  if (!res.ok || !res.body) {
    let msg = `free tier ${res.status}`;
    try {
      const d = (await res.json()) as { error?: unknown };
      if (d.error) msg = typeof d.error === "string" ? d.error : JSON.stringify(d.error);
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let full = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const chunk = JSON.parse(payload) as {
          choices?: { delta?: { content?: string | null } }[];
        };
        const delta = chunk.choices?.[0]?.delta?.content ?? "";
        if (delta) {
          full += delta;
          onDelta(delta);
        }
      } catch {
        /* ignore partial */
      }
    }
  }
  return full;
}