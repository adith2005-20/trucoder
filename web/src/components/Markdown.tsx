import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkDirective from "remark-directive";
import rehypeHighlight from "rehype-highlight";
// Grammars are imported ONE BY ONE instead of taking highlight.js' `common`
// bundle: `rehype-highlight` REPLACES its default set when you pass
// `languages` (lib/index.js: `settings.languages || common`), so the set has
// to be explicit. This list is every language the courses actually fence,
// which also keeps the bundle smaller than `common` (no abap/clojure/elixir…).
import hlBash from "highlight.js/lib/languages/bash";
import hlShell from "highlight.js/lib/languages/shell";
import hlC from "highlight.js/lib/languages/c";
import hlCpp from "highlight.js/lib/languages/cpp";
import hlJava from "highlight.js/lib/languages/java";
import hlJavascript from "highlight.js/lib/languages/javascript";
import hlPython from "highlight.js/lib/languages/python";
import hlSql from "highlight.js/lib/languages/sql";
import hlXml from "highlight.js/lib/languages/xml";
import hlCss from "highlight.js/lib/languages/css";
import hlJson from "highlight.js/lib/languages/json";
import hlYaml from "highlight.js/lib/languages/yaml";
import hlIni from "highlight.js/lib/languages/ini";
import hlMarkdown from "highlight.js/lib/languages/markdown";
import hlDiff from "highlight.js/lib/languages/diff";
import hlDockerfile from "highlight.js/lib/languages/dockerfile";
import katex from "katex";
import { visit } from "unist-util-visit";
import { useState } from "react";
import { PiCheck, PiCopy } from "react-icons/pi";
import VideoEmbed from "./VideoEmbed";

/** Turn `:::tip` / `:::warning` / `:::note` / `:::example` container
 *  directives into a `callout` element we can render as a styled component. */
function remarkCallout() {
  return (tree: unknown) => {
    visit(tree as any, (node: any) => {
      if (node.type === "containerDirective") {
        const data = node.data || (node.data = {});
        data.hName = "callout";
        data.hProperties = { type: node.name };
      }
    });
  };
}

/** Turn `:::video url="..." title="..." credit="..."` container directives
 *  into a `videoEmbed` element we render as a styled YouTube player. */
function remarkVideo() {
  return (tree: unknown) => {
    visit(tree as any, (node: any) => {
      if (
        (node.type === "containerDirective" || node.type === "leafDirective") &&
        node.name === "video"
      ) {
        const data = node.data || (node.data = {});
        data.hName = "videoEmbed";
        data.hProperties = {
          url: node.attributes?.url ?? "",
          title: node.attributes?.title ?? "",
          credit: node.attributes?.credit ?? "",
        };
      }
    });
  };
}

/** Math parsing done HERE, not remark-math: remark-math v6 mis-parses
 *  `$$...$$` as inline math (display math never gets a block wrapper), and
 *  rehype-katex v7 loses display mode with react-markdown 9.0.1. This plugin
 *  splits text nodes on `$$...$$` (display) and `$...$` (inline) and emits
 *  custom nodes our KaTeX components render with explicit displayMode.
 *  Inline math is extracted ONLY OUTSIDE display spans, so a `$$...$$`
 *  block can never also produce an inline render. */
function extractInline(segment: string, parts: { kind: "text" | "display" | "inline"; value: string }[]) {
  const re = /\$([^$\n]+)\$/g;
  let im: RegExpExecArray | null;
  let last = 0;
  while ((im = re.exec(segment)) !== null) {
    if (im.index > last) parts.push({ kind: "text", value: segment.slice(last, im.index) });
    parts.push({ kind: "inline", value: im[1] });
    last = im.index + im[0].length;
  }
  if (last < segment.length) parts.push({ kind: "text", value: segment.slice(last) });
}

function splitMath(value: string) {
  const displaySpans: { start: number; end: number; value: string }[] = [];
  const dispRe = /\$\$([\s\S]+?)\$\$/g;
  let m: RegExpExecArray | null;
  while ((m = dispRe.exec(value)) !== null) {
    displaySpans.push({ start: m.index, end: m.index + m[0].length, value: m[1] });
  }
  const parts: { kind: "text" | "display" | "inline"; value: string }[] = [];
  let pos = 0;
  for (const ds of displaySpans) {
    if (ds.start > pos) extractInline(value.slice(pos, ds.start), parts);
    parts.push({ kind: "display", value: ds.value });
    pos = ds.end;
  }
  if (pos < value.length) extractInline(value.slice(pos), parts);
  return parts;
}

function remarkMathCustom() {
  return (tree: unknown) => {
    visit(tree as any, "text", (node: any, index: number | undefined, parent: any) => {
      if (!parent || index === undefined) return;
      const parts = splitMath(node.value);
      // a text node that is EXACTLY one math expression (e.g. a table cell
      // "$3/6 = 0.5$") yields a single math part — replace it, don't skip
      if (parts.length === 1 && parts[0].kind === "text") return;
      const children = parts.map((p) => {
        if (p.kind === "text") return { type: "text", value: p.value };
        const type = p.kind === "display" ? "mathblock" : "inlinemath";
        return {
          type,
          value: p.value,
          data: { hName: type, hProperties: { value: p.value } },
        };
      });
      parent.children.splice(index, 1, ...children);
    });
  };
}

function Callout({ type, children }: { type: string; children: React.ReactNode }) {
  return (
    <div className={`callout callout-${type || "note"}`}>
      <span className="callout-label">{type || "note"}</span>
      <div className="callout-body">{children}</div>
    </div>
  );
}

// Math is rendered DIRECTLY with KaTeX. Custom components keep full
// control: display math always gets .katex-display.
function renderMath(value: string, displayMode: boolean) {
  return katex.renderToString(value, { displayMode, throwOnError: false });
}

function MathBlock({ value }: { value: string }) {
  return (
    <span
      className="katex-display"
      dangerouslySetInnerHTML={{ __html: renderMath(value, true) }}
    />
  );
}

function InlineMath({ value }: { value: string }) {
  return (
    <span dangerouslySetInnerHTML={{ __html: renderMath(value, false) }} />
  );
}

/** Flatten react-markdown's children tree into plain text (for copying). */
function nodeText(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (node && typeof node === "object" && "props" in (node as any)) {
    return nodeText((node as any).props?.children);
  }
  return "";
}

/** Language label for the code-block header strip. Fences use short names
 *  (js, py, cpp), so map them to the label a reader expects. */
const LANG_LABELS: Record<string, string> = {
  js: "JavaScript", javascript: "JavaScript", ts: "TypeScript", typescript: "TypeScript",
  py: "Python", python: "Python", java: "Java", cpp: "C++", c: "C",
  sql: "SQL", mysql: "MySQL", pgsql: "PostgreSQL", html: "HTML", xml: "HTML",
  css: "CSS", json: "JSON", yaml: "YAML", yml: "YAML", bash: "Bash", sh: "Shell",
  shell: "Shell", console: "Console", ini: "INI", text: "Text", plaintext: "Text",
  dockerfile: "Dockerfile", hcl: "HCL", promql: "PromQL", jinja: "Jinja",
  md: "Markdown", markdown: "Markdown", diff: "Diff", toml: "TOML", go: "Go",
  rust: "Rust", ruby: "Ruby", php: "PHP", kotlin: "Kotlin", swift: "Swift",
};

/** The fenced language lives in the className of the `code` element that
 *  react-markdown builds — walk the children to find it. */
function codeClassName(node: React.ReactNode): string {
  if (!node || typeof node !== "object") return "";
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = codeClassName(child);
      if (hit) return hit;
    }
    return "";
  }
  const props = (node as { props?: { className?: unknown; children?: unknown } }).props;
  if (!props) return "";
  const cls = typeof props.className === "string" ? props.className : "";
  if (/language-/.test(cls)) return cls;
  return codeClassName(props.children as React.ReactNode);
}

/** Copy button on every fenced code block. */
function CodeBlock({ children }: { children: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const text = nodeText(children).replace(/\n$/, "");
  const lang = /language-([\w+#.-]+)/.exec(codeClassName(children))?.[1]?.toLowerCase() ?? "";
  const label = LANG_LABELS[lang] ?? (lang ? lang.toUpperCase() : "code");
  return (
    <div className="md-codeblock">
      <div className="md-code-head">
        <span className="md-code-lang">{label}</span>
        <button
          className="md-code-copy"
          aria-label="copy code"
          title="copy code"
          data-copied={copied ? "1" : "0"}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(text);
            } catch {
              // Clipboard API unavailable (insecure context) — legacy fallback.
              const ta = document.createElement("textarea");
              ta.value = text;
              document.body.appendChild(ta);
              ta.select();
              document.execCommand("copy");
              ta.remove();
            }
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <PiCheck size={13} /> : <PiCopy size={13} />}
          <span>{copied ? "copied" : "copy"}</span>
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

export default function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkDirective, remarkCallout, remarkVideo, remarkMathCustom]}
      // Syntax highlighting for fenced code blocks. `detect: false` keeps a
      // fence WITHOUT a language plain (no guessing). Languages the courses
      // never use are absent, and the ones with no grammar at all (promql,
      // hcl, jinja) sit in `plainText` so they render plain WITHOUT a
      // "not registered" message. Token colours come from the theme vars in
      // styles.css, so every theme keeps its own palette.
      rehypePlugins={[
        [
          rehypeHighlight,
          {
            detect: false,
            languages: {
              bash: hlBash,
              shell: hlShell,
              c: hlC,
              cpp: hlCpp,
              java: hlJava,
              javascript: hlJavascript,
              python: hlPython,
              sql: hlSql,
              xml: hlXml,
              css: hlCss,
              json: hlJson,
              yaml: hlYaml,
              ini: hlIni,
              markdown: hlMarkdown,
              diff: hlDiff,
              dockerfile: hlDockerfile,
            },
            aliases: { shell: ["console", "session"] },
            plainText: ["text", "plaintext", "txt", "promql", "hcl", "jinja"],
          },
        ],
      ]}
      components={{
        callout: Callout,
        videoEmbed: VideoEmbed,
        mathblock: MathBlock,
        inlinemath: InlineMath,
        pre: CodeBlock,
      } as unknown as React.ComponentProps<typeof ReactMarkdown>["components"]}
    >
      {children}
    </ReactMarkdown>
  );
}
