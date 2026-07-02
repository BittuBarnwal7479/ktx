"use client";

import { useState } from "react";
import { CircleAlert, PencilLine } from "lucide-react";

type Props = {
  mdxSource?: string;
  issueUrl?: string;
  sourceEditUrl?: string;
};

function stripFrontmatter(source: string) {
  return source.trim().replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
}

const actionClassName =
  "inline-flex h-8 items-center gap-1.5 rounded-md border border-fd-border bg-fd-background px-3 font-medium text-fd-muted-foreground transition-colors hover:border-fd-primary/40 hover:text-fd-foreground";

export function DocsPageActions({ mdxSource, issueUrl, sourceEditUrl }: Props) {
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    if (mdxSource === undefined) return;

    try {
      await navigator.clipboard.writeText(stripFrontmatter(mdxSource));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard denied - fail silently
    }
  };

  return (
    <div className="not-prose flex flex-wrap items-center gap-2 text-xs">
      {mdxSource !== undefined && (
        <button
          type="button"
          onClick={onCopy}
          className={`${actionClassName} data-[state=copied]:border-emerald-500/40 data-[state=copied]:text-emerald-600`}
          data-state={copied ? "copied" : "idle"}
        >
          {copied ? "Copied" : "Copy as Markdown"}
        </button>
      )}
      {sourceEditUrl !== undefined && (
        <a
          href={sourceEditUrl}
          target="_blank"
          rel="noreferrer noopener"
          className={actionClassName}
        >
          <PencilLine className="size-3.5" aria-hidden="true" />
          Suggest edits
        </a>
      )}
      {issueUrl !== undefined && (
        <a
          href={issueUrl}
          target="_blank"
          rel="noreferrer noopener"
          className={actionClassName}
        >
          <CircleAlert className="size-3.5" aria-hidden="true" />
          Raise issue
        </a>
      )}
    </div>
  );
}
