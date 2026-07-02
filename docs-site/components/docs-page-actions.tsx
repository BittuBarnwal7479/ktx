"use client";

import { type ReactNode, useEffect, useId, useRef, useState } from "react";

type Props = {
  title: string;
  description?: string;
  contentId: string;
  markdownHref: string;
};

export function DocsPageActions({
  title,
  description,
  contentId,
  markdownHref,
}: Props) {
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const onCopy = async () => {
    const content = document.getElementById(contentId);
    if (!content) return;

    try {
      await navigator.clipboard.writeText(
        buildPageMarkdown({ title, description, content }),
      );
      setCopied(true);
      setOpen(false);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard denied - fail silently
    }
  };

  const absoluteMarkdownUrl = `https://docs.kaelio.com/ktx${markdownHref}`;
  const assistantPrompt = () =>
    `Use this documentation page to answer questions about ${title}: ${absoluteMarkdownUrl}`;
  const chatGptHref = () =>
    `https://chatgpt.com/?q=${encodeURIComponent(assistantPrompt())}`;
  const claudeHref = () =>
    `https://claude.ai/new?q=${encodeURIComponent(assistantPrompt())}`;

  return (
    <div
      ref={rootRef}
      className="not-prose relative flex flex-wrap items-center gap-2 text-sm"
    >
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        className="inline-flex h-10 items-center overflow-hidden rounded-full border border-fd-border bg-fd-background text-fd-foreground shadow-sm transition-colors hover:border-fd-primary/40"
        data-state={copied ? "copied" : "idle"}
      >
        <span className="inline-flex h-full items-center gap-2.5 px-4 font-semibold">
          {copied ? <CheckIcon /> : <CopyIcon />}
          <span>{copied ? "Copied" : "Copy page"}</span>
        </span>
        <span className="inline-flex h-full w-10 items-center justify-center border-l border-fd-border text-fd-muted-foreground">
          <ChevronIcon open={open} />
        </span>
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          className="absolute right-0 top-12 z-30 w-[min(22rem,calc(100vw-2rem))] rounded-2xl border border-fd-border bg-fd-popover p-1.5 text-fd-popover-foreground shadow-xl"
        >
          <MenuButton
            icon={<CopyIcon />}
            title="Copy page"
            description="Copy page as Markdown for LLMs"
            onClick={onCopy}
          />
          <MenuLink
            icon={<MarkdownIcon />}
            title="View as Markdown"
            description="View this page as plain text"
            href={absoluteMarkdownUrl}
          />
          <MenuLink
            icon={<ChatGptIcon />}
            title="Open in ChatGPT"
            description="Ask questions about this page"
            href={chatGptHref()}
          />
          <MenuLink
            icon={<ClaudeIcon />}
            title="Open in Claude"
            description="Ask questions about this page"
            href={claudeHref()}
          />
        </div>
      )}
    </div>
  );
}

function MenuButton({
  icon,
  title,
  description,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-fd-muted focus:bg-fd-muted focus:outline-none"
    >
      <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-fd-border text-fd-muted-foreground">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block font-semibold leading-5">{title}</span>
        <span className="block truncate text-sm leading-5 text-fd-muted-foreground">
          {description}
        </span>
      </span>
    </button>
  );
}

function MenuLink({
  icon,
  title,
  description,
  href,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  href: string;
}) {
  return (
    <a
      role="menuitem"
      href={href}
      target="_blank"
      rel="noreferrer"
      className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left no-underline transition-colors hover:bg-fd-muted focus:bg-fd-muted focus:outline-none"
    >
      <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-fd-border text-fd-muted-foreground">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="flex items-center gap-1.5 font-semibold leading-5">
          {title}
          <ExternalIcon />
        </span>
        <span className="block truncate text-sm leading-5 text-fd-muted-foreground">
          {description}
        </span>
      </span>
    </a>
  );
}

function buildPageMarkdown({
  title,
  description,
  content,
}: {
  title: string;
  description?: string;
  content: HTMLElement;
}) {
  const parts = [`# ${title}`];
  if (description) {
    parts.push(`> ${description}`);
  }

  const body = childrenToMarkdown(content).trim();
  if (body) {
    parts.push(body);
  }

  return `${parts.join("\n\n")}\n`;
}

function childrenToMarkdown(parent: Element) {
  return Array.from(parent.childNodes)
    .map((node) => nodeToMarkdown(node))
    .filter(Boolean)
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n");
}

function nodeToMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return normalizeText(node.textContent ?? "");
  }

  if (!(node instanceof HTMLElement)) {
    return "";
  }

  const tagName = node.tagName.toLowerCase();
  if (["button", "script", "style", "svg"].includes(tagName)) {
    return "";
  }

  if (tagName === "br") {
    return "\n";
  }

  if (/^h[1-6]$/.test(tagName)) {
    const level = Number(tagName.slice(1));
    return `${"#".repeat(level)} ${inlineChildrenToMarkdown(node)}`.trim();
  }

  if (tagName === "pre") {
    const code = node.querySelector("code");
    const language = getCodeLanguage(code);
    return `\`\`\`${language}\n${(code ?? node).textContent?.trimEnd() ?? ""}\n\`\`\``;
  }

  if (tagName === "table") {
    return tableToMarkdown(node);
  }

  if (tagName === "ul" || tagName === "ol") {
    return listToMarkdown(node, tagName === "ol");
  }

  if (tagName === "blockquote") {
    return childrenToMarkdown(node)
      .split("\n")
      .map((line) => (line ? `> ${line}` : ">"))
      .join("\n");
  }

  if (tagName === "hr") {
    return "---";
  }

  if (tagName === "p" || tagName === "figcaption") {
    return inlineChildrenToMarkdown(node);
  }

  return childrenToMarkdown(node) || inlineChildrenToMarkdown(node);
}

function inlineChildrenToMarkdown(parent: Element) {
  return Array.from(parent.childNodes)
    .map((node) => inlineNodeToMarkdown(node))
    .join("")
    .replace(/[ \t\n]+/g, " ")
    .trim();
}

function inlineNodeToMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return normalizeText(node.textContent ?? "");
  }

  if (!(node instanceof HTMLElement)) {
    return "";
  }

  const tagName = node.tagName.toLowerCase();
  if (["button", "script", "style", "svg"].includes(tagName)) {
    return "";
  }

  const text = inlineChildrenToMarkdown(node);
  if (!text) {
    return "";
  }

  if (tagName === "a") {
    const href = node.getAttribute("href");
    return href ? `[${text}](${href})` : text;
  }

  if (tagName === "code") {
    return `\`${text}\``;
  }

  if (tagName === "strong" || tagName === "b") {
    return `**${text}**`;
  }

  if (tagName === "em" || tagName === "i") {
    return `_${text}_`;
  }

  if (tagName === "br") {
    return "\n";
  }

  return text;
}

function listToMarkdown(list: HTMLElement, ordered: boolean) {
  return Array.from(list.children)
    .filter((child) => child.tagName.toLowerCase() === "li")
    .map((item, index) => {
      const marker = ordered ? `${index + 1}.` : "-";
      const content =
        childrenToMarkdown(item).trim() || inlineChildrenToMarkdown(item);
      const [firstLine = "", ...restLines] = content.split("\n");
      const continuationIndent = " ".repeat(marker.length + 1);

      return [
        `${marker} ${firstLine}`,
        ...restLines.map((line) =>
          line ? `${continuationIndent}${line}` : "",
        ),
      ].join("\n");
    })
    .join("\n");
}

function tableToMarkdown(table: HTMLElement) {
  const rows = Array.from(table.querySelectorAll("tr")).map((row) =>
    Array.from(row.children).map((cell) => inlineChildrenToMarkdown(cell)),
  );
  const [header, ...body] = rows;
  if (!header) return "";

  return [
    markdownTableRow(header),
    markdownTableRow(header.map(() => "---")),
    ...body.map(markdownTableRow),
  ].join("\n");
}

function markdownTableRow(cells: string[]) {
  return `| ${cells.map((cell) => cell.replace(/\|/g, "\\|")).join(" | ")} |`;
}

function getCodeLanguage(code: Element | null) {
  const className = code?.className;
  if (typeof className !== "string") return "";

  return (
    className
      .split(/\s+/)
      .find((name) => name.startsWith("language-"))
      ?.slice("language-".length) ?? ""
  );
}

function normalizeText(text: string) {
  return text.replace(/\s+/g, " ");
}

function CopyIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={open ? "rotate-180 transition-transform" : "transition-transform"}
      aria-hidden="true"
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function MarkdownIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path d="M7 14V10l2.5 3L12 10v4" />
      <path d="M15 10v4" />
      <path d="M13.5 12.5 15 14l1.5-1.5" />
    </svg>
  );
}

function ChatGptIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3.5a4 4 0 0 1 3.8 2.7 4 4 0 0 1 3.1 6.1 4 4 0 0 1-3.6 6.1A4 4 0 0 1 8 18.8a4 4 0 0 1-3-6.5 4 4 0 0 1 3.2-6.1A4 4 0 0 1 12 3.5Z" />
      <path d="m8.5 6.8 6.9 4v7.4" />
      <path d="m15.5 6.2-7 4.1-3.2-1.9" />
      <path d="M5.1 12.3 12 16.2l3.3-1.9" />
      <path d="M18.9 12.3 12 8.4 8.7 10.3" />
    </svg>
  );
}

function ClaudeIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3v18" />
      <path d="m5.6 5.6 12.8 12.8" />
      <path d="M3 12h18" />
      <path d="M18.4 5.6 5.6 18.4" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function ExternalIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M7 7h10v10" />
      <path d="M7 17 17 7" />
    </svg>
  );
}
