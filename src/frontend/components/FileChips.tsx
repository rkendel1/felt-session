import React from "react";
import type { FileAttachment } from "../lib/images";

interface Props {
  files: FileAttachment[];
  onRemove: (index: number) => void;
  disabled?: boolean;
}

/** File-type category → chip accent color (drives the icon badge tint). */
type Category = "code" | "doc" | "data" | "media" | "archive" | "file";

const EXT_CATEGORY: Record<string, Category> = {
  // code
  ts: "code", tsx: "code", js: "code", jsx: "code", res: "code", rs: "code",
  py: "code", go: "code", rb: "code", java: "code", c: "code", h: "code",
  cpp: "code", css: "code", html: "code", sh: "code", sql: "code",
  // docs
  md: "doc", mdx: "doc", txt: "doc", pdf: "doc", doc: "doc", docx: "doc", rtf: "doc",
  // structured data
  json: "data", yaml: "data", yml: "data", toml: "data", csv: "data", xml: "data",
  // media
  png: "media", jpg: "media", jpeg: "media", gif: "media", webp: "media", svg: "media",
  mp4: "media", mov: "media", webm: "media", mp3: "media", wav: "media",
  // archives
  zip: "archive", tar: "archive", gz: "archive", rar: "archive", "7z": "archive",
};

function categoryFor(name: string): Category {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return EXT_CATEGORY[ext] ?? "file";
}

function extLabel(name: string): string {
  const ext = name.includes(".") ? name.split(".").pop()! : "";
  return ext.slice(0, 4).toUpperCase();
}

/**
 * Removable chip row for non-image file attachments (staged to disk
 * server-side). Each chip leads with a small type-colored badge (the file's
 * extension) so it reads at a glance, mirroring the file previews in the input.
 */
export function FileChips({ files, onRemove, disabled }: Props) {
  if (files.length === 0) return null;
  return (
    <div className="composer-files">
      {files.map((f, i) => {
        const cat = categoryFor(f.name);
        return (
          <div key={i} className={`composer-file-chip cat-${cat}`} title={f.name}>
            <span className="composer-file-badge">{extLabel(f.name) || "•"}</span>
            <span className="composer-file-name">{f.name}</span>
            <button
              type="button"
              className="composer-file-remove"
              onClick={() => onRemove(i)}
              disabled={disabled}
              title="Remove file"
              aria-label={`Remove ${f.name}`}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
