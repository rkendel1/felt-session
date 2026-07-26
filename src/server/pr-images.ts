/**
 * PR image attachments — upload local screenshots to an orphan
 * `opensession-assets` branch of the target GitHub repo via the git data API
 * (no local clone, and never the PR branch), returning
 * `github.com/<repo>/blob/opensession-assets/<path>?raw=true` URLs that render
 * inline in PR/issue markdown for anyone with access to the repo.
 *
 * Why this mechanism (verified empirically 2026-07-26 via a rendering-probe
 * issue on tellahq/backstage, since deleted):
 * - GitHub's own attachment CDN (what the web UI uses — POST
 *   /upload/policies/assets) is a cookie-session form endpoint: it 422s under
 *   a PAT/Bearer token and has no documented API. Not usable for a bot.
 * - raw.githubusercontent.com URLs are left un-proxied in rendered HTML but
 *   that domain never sees github.com session cookies, so they 404 for
 *   private repos — broken for every viewer.
 * - Release-asset URLs ride the same cookie→signed-redirect chain as blob
 *   URLs, but a release per screenshot batch pollutes the Releases page.
 * - os.tella.dev media URLs get rewritten to camo.githubusercontent.com,
 *   and camo can't reach the tailnet — always a broken image.
 * - blob `?raw=true` URLs stay un-proxied (github.com is a trusted host): the
 *   viewer's browser resolves them with its github.com session, which 302s to
 *   a signed raw URL. Renders for teammates with repo access, 404s for
 *   everyone else — the right visibility for screenshots that may contain
 *   customer data (a private tellahq repo is a channel we control).
 *
 * Each upload batch lands as ONE commit on the assets branch (blobs → tree →
 * commit → ref fast-forward), so PR branches and master history stay clean.
 */

import { existsSync, statSync } from "fs";
import { basename } from "path";
import {
  ghRateLimited,
  isGhRateLimitMsg,
  noteGhRateLimited,
} from "./github-limit";

export const ASSETS_BRANCH = "opensession-assets";

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export interface PrImageInput {
  /** Absolute local path to the image (under /tmp or /home/ubuntu). */
  path: string;
  /** Alt/caption text for the rendered image. */
  alt?: string;
}

export interface UploadedPrImage {
  alt: string;
  /** blob?raw=true URL that renders inline for repo members. */
  url: string;
  /** Path of the file on the assets branch. */
  repoPath: string;
}

const RATE_LIMIT_MESSAGE =
  "GitHub API rate limit is exhausted right now — try again once the window resets.";

function ext(p: string): string {
  return p.slice(p.lastIndexOf(".")).toLowerCase();
}

/** Same reachability rule as walkthrough media: absolute, no traversal, under
 *  the places agents can actually write. */
function readablePath(p: string): boolean {
  return (
    p.startsWith("/") &&
    !p.includes("..") &&
    (p.startsWith("/tmp/") || p.startsWith("/home/ubuntu/"))
  );
}

/** `gh api` with a JSON body via --input (argv can't carry multi-MB base64). */
async function ghApi(
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; json: any; err: string }> {
  const args = ["api", "-X", method, path];
  let tmp: string | null = null;
  if (body !== undefined) {
    tmp = `/tmp/opensession-pr-image-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
    await Bun.write(tmp, JSON.stringify(body));
    args.push("--input", tmp);
  }
  try {
    const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0 && isGhRateLimitMsg(err)) noteGhRateLimited("pr-images");
    let json: any = null;
    try {
      json = out.trim() ? JSON.parse(out) : null;
    } catch {}
    const status = code === 0 ? 200 : (json?.status ? Number(json.status) : 0);
    return { ok: code === 0, status, json, err: err.slice(0, 300) };
  } finally {
    if (tmp) await Bun.file(tmp).unlink().catch(() => {});
  }
}

function assetPath(localPath: string): string {
  const now = new Date();
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const name = basename(localPath);
  const dot = name.lastIndexOf(".");
  const stem = (dot > 0 ? name.slice(0, dot) : name)
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "image";
  const rand = Math.random().toString(36).slice(2, 8);
  return `pr-images/${month}/${stem}-${rand}${ext(name)}`;
}

/**
 * Upload local images as one commit on the repo's orphan assets branch.
 * Creates the branch (orphan — no parents, so no shared history with any
 * code branch) on first use. Retries the ref fast-forward once in case a
 * concurrent upload advanced the branch between read and write.
 */
export async function uploadPrImages(
  ghRepo: string,
  images: PrImageInput[],
): Promise<UploadedPrImage[]> {
  if (!images.length) throw new Error("no images given");
  if (ghRateLimited()) throw new Error(RATE_LIMIT_MESSAGE);

  for (const img of images) {
    const p = (img.path || "").trim();
    if (!readablePath(p))
      throw new Error(`image path must be absolute under /tmp or /home/ubuntu: ${p}`);
    if (!IMAGE_EXTS.has(ext(p)))
      throw new Error(`image must be one of ${[...IMAGE_EXTS].join(" ")}: ${p}`);
    if (!existsSync(p)) throw new Error(`image file not found: ${p}`);
    if (statSync(p).size > MAX_IMAGE_BYTES)
      throw new Error(`image too large (max ${MAX_IMAGE_BYTES / 1024 / 1024}MB): ${p}`);
  }

  // One blob per image (these carry the actual bytes).
  const entries: Array<{ input: PrImageInput; repoPath: string; blobSha: string }> = [];
  for (const img of images) {
    const bytes = await Bun.file(img.path.trim()).arrayBuffer();
    const content = Buffer.from(bytes).toString("base64");
    const blob = await ghApi("POST", `repos/${ghRepo}/git/blobs`, {
      content,
      encoding: "base64",
    });
    if (!blob.ok)
      throw new Error(`git blob upload failed for ${img.path}: ${blob.json?.message || blob.err}`);
    entries.push({ input: img, repoPath: assetPath(img.path), blobSha: blob.json.sha });
  }

  // Tree + commit + ref, with one retry if a concurrent upload moved the ref.
  for (let attempt = 0; ; attempt++) {
    const head = await ghApi("GET", `repos/${ghRepo}/git/ref/heads/${ASSETS_BRANCH}`);
    const headSha: string | null = head.ok ? head.json?.object?.sha : null;
    let baseTree: string | undefined;
    if (headSha) {
      const commit = await ghApi("GET", `repos/${ghRepo}/git/commits/${headSha}`);
      if (!commit.ok)
        throw new Error(`reading assets branch head failed: ${commit.json?.message || commit.err}`);
      baseTree = commit.json?.tree?.sha;
    }
    const tree = await ghApi("POST", `repos/${ghRepo}/git/trees`, {
      ...(baseTree ? { base_tree: baseTree } : {}),
      tree: entries.map((e) => ({
        path: e.repoPath,
        mode: "100644",
        type: "blob",
        sha: e.blobSha,
      })),
    });
    if (!tree.ok) throw new Error(`git tree failed: ${tree.json?.message || tree.err}`);
    const commit = await ghApi("POST", `repos/${ghRepo}/git/commits`, {
      message: `opensession: attach ${entries.length} PR image${entries.length === 1 ? "" : "s"}`,
      tree: tree.json.sha,
      parents: headSha ? [headSha] : [],
    });
    if (!commit.ok) throw new Error(`git commit failed: ${commit.json?.message || commit.err}`);
    const ref = headSha
      ? await ghApi("PATCH", `repos/${ghRepo}/git/refs/heads/${ASSETS_BRANCH}`, {
          sha: commit.json.sha,
        })
      : await ghApi("POST", `repos/${ghRepo}/git/refs`, {
          ref: `refs/heads/${ASSETS_BRANCH}`,
          sha: commit.json.sha,
        });
    if (ref.ok) break;
    // Not-fast-forward / already-exists: someone raced us — retry once on the
    // fresh head (blobs are content-addressed, so they carry over as-is).
    if (attempt >= 1)
      throw new Error(`updating assets branch failed: ${ref.json?.message || ref.err}`);
  }

  return entries.map((e) => ({
    alt: e.input.alt?.trim() || basename(e.input.path).replace(/\.[^.]+$/, ""),
    url: `https://github.com/${ghRepo}/blob/${ASSETS_BRANCH}/${e.repoPath}?raw=true`,
    repoPath: e.repoPath,
  }));
}

/** Markdown for one uploaded image. */
export function prImageMarkdown(img: UploadedPrImage): string {
  return `![${img.alt}](${img.url})`;
}

/**
 * Substitute `{{image:N}}` placeholders (1-based) in a markdown body with the
 * uploaded images; any images never referenced are appended at the end so
 * nothing silently vanishes.
 */
export function spliceImagesIntoMarkdown(
  markdown: string,
  uploaded: UploadedPrImage[],
): string {
  const used = new Set<number>();
  let body = markdown.replace(/\{\{\s*image:(\d+)\s*\}\}/gi, (m, n) => {
    const idx = parseInt(n, 10) - 1;
    if (idx < 0 || idx >= uploaded.length) return m;
    used.add(idx);
    return prImageMarkdown(uploaded[idx]);
  });
  const rest = uploaded.filter((_, i) => !used.has(i));
  if (rest.length) {
    body = `${body.trimEnd()}\n\n${rest.map(prImageMarkdown).join("\n\n")}`;
  }
  return body;
}
