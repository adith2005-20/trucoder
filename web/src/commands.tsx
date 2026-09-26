/** Command registry — the extensible core behind the command palette.
 *
 * ANY feature can register a command section at module load:
 *
 *   registerCommandSection({
 *     title: "My feature",
 *     commands: [
 *       { id: "my-action", display: "Do the thing", alias: "thing action",
 *         icon: <PiStar />, run: () => doTheThing() },
 *     ],
 *   });
 *
 * The palette renders whatever is registered — nothing else needs to change.
 *
 * Search model (rewritten 2026-09 — the palette became the primary nav and the
 * old per-keystroke string splitting was the bottleneck):
 *   - every command carries a PRE-TOKENIZED index: `tokens` (display + alias
 *     words) and `soft` (content words, e.g. a lesson's body keywords);
 *   - a query is parsed once per keystroke, then matched word-wise against
 *     those arrays with a small score (exact > prefix, tokens > soft);
 *   - rows are ranked, then capped per section and per group, so the palette
 *     never renders thousands of rows.
 */

import type { ReactNode } from "react";

export interface Command {
  id: string;
  /** Human label shown in the list. */
  display: string;
  /** Extra search words (abbreviations, synonyms). */
  alias?: string;
  /** Content words (weak matches — a lesson's body vocabulary). */
  keywords?: string[];
  /** Pre-tokenized search index. The registry builds it from display+alias
   *  on first use; large sections (the lesson index) build it once when the
   *  section is constructed so opening the palette does no tokenizing. */
  tokens?: string[];
  /** Pre-tokenized weak index (see `keywords`). */
  soft?: string[];
  /** Left-side icon. */
  icon?: ReactNode;
  /** Right-side adornment (theme swatch, keybind chip, ...). */
  hint?: ReactNode;
  /** Hide the command when this returns false. */
  available?: () => boolean;
  /** Marks the row as the current state (checkmark). */
  active?: () => boolean;
  /** Group header rendered above the row (e.g. the course a lesson lives in).
   *  Consecutive rows sharing a group render under one header, which is what
   *  separates results when several courses are listed together. */
  group?: string;
  run: () => void;
}

export interface CommandSection {
  title: string;
  /** Static list, or a thunk (sync or async) resolved when the palette opens. */
  commands: Command[] | (() => Command[] | Promise<Command[]>);
  /** Skip this section while the query is empty (big content indexes). */
  hideWhenEmpty?: boolean;
  /** Max rows rendered for this section per render. */
  limit?: number;
  /** Max rows rendered per group inside this section. */
  groupLimit?: number;
}

const sections: CommandSection[] = [];

export function registerCommandSection(section: CommandSection): void {
  // replace-by-title: the app registers sections every render; a plain push
  // would duplicate every section (and freeze stale closures) on re-render
  const i = sections.findIndex((s) => s.title === section.title);
  if (i >= 0) sections[i] = section;
  else sections.push(section);
}

export function getCommandSections(): CommandSection[] {
  return sections;
}

const stripPunct = (w: string) => w.replace(/[^a-z0-9]/g, "");

/** Words of a text, lowercased and stripped — the token form used everywhere. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .map(stripPunct)
    .filter(Boolean);
}

/** The query, parsed once per keystroke. */
export function parseQuery(query: string): string[] {
  return tokenize(query);
}

/** Fill in `tokens`/`soft` for a command (idempotent, in place). Sections that
 *  build rows in bulk call this once when they build them. */
export function indexCommand(cmd: Command): Command {
  if (!cmd.tokens) cmd.tokens = tokenize(`${cmd.display} ${cmd.alias ?? ""}`);
  if (!cmd.soft && cmd.keywords?.length) cmd.soft = tokenize(cmd.keywords.join(" "));
  return cmd;
}

/** Word-prefix match for plain text pairs (theme picker, ad-hoc filters):
 *  every query word must prefix-match a word of display+alias. */
export function matchQuery(query: string, display: string, alias = ""): boolean {
  const input = tokenize(query);
  if (input.length === 0) return true;
  const hay = tokenize(`${display} ${alias}`);
  return input.every((word) => hay.some((w) => w.startsWith(word)));
}

/** Split a display string into matched and unmatched runs. The palette draws
 *  the runs so a row shows WHY it matched instead of leaving the learner to
 *  guess. Whitespace stays in the unmatched runs. */
export function splitMatch(
  display: string,
  query: string
): { text: string; hit: boolean }[] {
  const words = tokenize(query);
  if (words.length === 0) return [{ text: display, hit: false }];
  const out: { text: string; hit: boolean }[] = [];
  for (const part of display.split(/(\s+)/)) {
    if (part === "") continue;
    const lower = part.toLowerCase();
    const hit = /\S/.test(part) && words.some((w) => lower.includes(w));
    out.push({ text: part, hit });
  }
  return out;
}

/**
 * Score a command against a parsed query. 0 means "no match".
 *
 * Display/alias words are strong (exact 4, prefix 3); content words are weak
 * (exact 2, prefix 1). Every query word must match something, so "two sum"
 * finds the lesson and "island" finds it through its body vocabulary too.
 * The sum makes a title hit outrank a content hit, and a two-word title hit
 * outrank a single-word one.
 */
export function scoreCommand(input: string[], cmd: Command): number {
  const tokens = cmd.tokens ?? (indexCommand(cmd).tokens as string[]);
  const soft = cmd.soft;
  let total = 0;
  for (const word of input) {
    let best = 0;
    for (const t of tokens) {
      if (t === word) {
        best = 4;
        break;
      }
      if (t.startsWith(word) && best < 3) best = 3;
    }
    if (best < 3 && soft) {
      for (const t of soft) {
        if (t === word) {
          best = 2;
          break;
        }
        if (t.startsWith(word) && best < 1) best = 1;
      }
    }
    if (best === 0) return 0;
    total += best;
  }
  return total;
}

export interface RankedCommand {
  cmd: Command;
  /** Row group (undefined = no group header). */
  group?: string;
}

/**
 * Filter + rank a section's commands for one query.
 *
 * - Empty query: insertion order, capped at `limit` per section (the sections
 *   are built in a meaningful order — folders, then courses, then the rest).
 * - Query: matched rows ordered by score, then by display length (shorter =
 *   tighter match), then alphabetically, capped per group and per section.
 */
export function rankCommands(
  input: string[],
  commands: Command[],
  opts: { limit?: number; groupLimit?: number; hideWhenEmpty?: boolean } = {}
): { rows: RankedCommand[]; total: number } {
  const limit = opts.limit ?? 40;
  const groupLimit = opts.groupLimit ?? limit;
  const usable = commands.filter((c) => !c.available || c.available());

  if (input.length === 0) {
    if (opts.hideWhenEmpty) return { rows: [], total: 0 };
    return {
      rows: usable.slice(0, limit).map((cmd) => ({ cmd, group: cmd.group })),
      total: usable.length,
    };
  }

  const scored: { cmd: Command; group?: string; score: number }[] = [];
  for (const cmd of usable) {
    const score = scoreCommand(input, cmd);
    if (score > 0) scored.push({ cmd, group: cmd.group, score });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.cmd.display.length - b.cmd.display.length ||
      a.cmd.display.localeCompare(b.cmd.display)
  );

  // Keep each group together: rank the groups by their best row, then stable
  // sort by that rank. Score order survives inside a group, so the palette
  // draws one header per course instead of repeating it down the list.
  const groupRank = new Map<string, number>();
  for (const hit of scored) {
    if (hit.group !== undefined && !groupRank.has(hit.group)) {
      groupRank.set(hit.group, groupRank.size);
    }
  }
  scored.sort(
    (a, b) =>
      (groupRank.get(a.group ?? "\u0000") ?? -1) -
      (groupRank.get(b.group ?? "\u0000") ?? -1)
  );

  const rows: RankedCommand[] = [];
  const perGroup = new Map<string, number>();
  for (const hit of scored) {
    if (rows.length >= limit) break;
    if (hit.group !== undefined) {
      const used = perGroup.get(hit.group) ?? 0;
      if (used >= groupLimit) continue;
      perGroup.set(hit.group, used + 1);
    }
    rows.push({ cmd: hit.cmd, group: hit.group });
  }
  return { rows, total: scored.length };
}
