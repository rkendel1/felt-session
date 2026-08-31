/**
 * Deliberately share a merged visual change in Slack. A walkthrough's durable
 * `after` screenshot is both the visual-change signal and the attachment; the
 * route calls this only after a teammate clicks Share to Slack.
 */
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  statSync,
  unlinkSync,
} from "fs";
import { basename, relative, resolve } from "path";
import { tmpdir } from "node:os";
import { createHash } from "crypto";
import type { StateFirstDB } from "@feltdb/core";
import { configuredIntegration } from "../../server/config";
import { audit } from "../../server/audit";
import { stateDir } from "../../server/paths";
import { managedFeltDb } from "../../server/managed-feltdb";
import { UPLOADS_DIR } from "../../server/uploads";
import { homeDir } from "../../server/paths";
import type { UnifiedSession } from "../../server/types";
import {
  postSlackFiles,
  sendSlackMessage,
  slackPermalink,
  slackUploadTs,
} from "../slack/slack-api";
import { shippedChangesChannel } from "./constants";

export interface ShippedVisualChange {
  sessionId: string;
  screenshots: string[];
  summary: string;
}

export interface ShippedChangeChannel {
  id: string;
  name: string;
}

const ANNOUNCEMENT_STATE_ROOT = `${stateDir("github")}/shipped-visual-changes`;
const ANNOUNCEMENT_COLLECTION = "opensession_github_shipped_change_receipts";
const ANNOUNCEMENT_MIGRATION = "github-shipped-change-receipts-json-to-managed-feltdb-v1";
const MAX_SCREENSHOT_BYTES = 20 * 1024 * 1024;
const SCREENSHOT_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

interface AnnouncementReceipt {
  id: string;
  __version?: number;
  status: "pending" | "sent";
  claimId: string;
  at: string;
  sessionId?: string;
}

let announcementDb: StateFirstDB | undefined;
const announcementId = (key: string) => `shipped_change_${createHash("sha256").update(key).digest("hex")}`;

export async function initializeManagedShippedChangeAnnouncements(
  db: StateFirstDB = announcementDb ?? managedFeltDb(),
): Promise<void> {
  announcementDb = db;
  const migrations = db.collection<{ id: string }>("opensession_migrations");
  if (await migrations.get(ANNOUNCEMENT_MIGRATION)) return;
  if (existsSync(ANNOUNCEMENT_STATE_ROOT)) {
    for (const name of readdirSync(ANNOUNCEMENT_STATE_ROOT)) {
      if (!name.endsWith(".json")) continue;
      const path = `${ANNOUNCEMENT_STATE_ROOT}/${name}`;
      let legacy: Omit<AnnouncementReceipt, "id">;
      try {
        legacy = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        legacy = { status: "pending", claimId: "legacy-corrupt", at: new Date(0).toISOString() };
      }
      const digest = basename(name, ".json");
      const id = `shipped_change_${digest}`;
      await db.transaction((tx) => {
        tx.collection<AnnouncementReceipt>(ANNOUNCEMENT_COLLECTION).set(id, { ...legacy, id, __version: 1 });
      }, { transactionId: `opensession:shipped-change:migrate:${id}` });
      unlinkSync(path);
    }
    try { rmdirSync(ANNOUNCEMENT_STATE_ROOT); } catch {}
  }
  await db.transaction((tx) => {
    tx.collection("opensession_migrations").set(ANNOUNCEMENT_MIGRATION, { id: ANNOUNCEMENT_MIGRATION, completedAt: Date.now() }, { requireAbsent: true });
  }, { transactionId: `opensession:migration:${ANNOUNCEMENT_MIGRATION}` });
}

export async function claimShippedChangeAnnouncement(
  key: string,
  now = Date.now(),
): Promise<string | null> {
  const db = announcementDb ?? managedFeltDb();
  const claimId = crypto.randomUUID();
  const id = announcementId(key);
  try {
    await db.transaction((tx) => {
      tx.collection<AnnouncementReceipt>(ANNOUNCEMENT_COLLECTION).set(id, {
        id, status: "pending", claimId, at: new Date(now).toISOString(),
      }, { requireAbsent: true });
    }, { transactionId: `opensession:shipped-change:claim:${id}:${claimId}` });
  } catch (error) {
    if (!await db.collection<AnnouncementReceipt>(ANNOUNCEMENT_COLLECTION).get(id)) throw error;
    return null;
  }
  return claimId;
}

export async function settleShippedChangeAnnouncement(
  key: string,
  claimId: string,
  sent: boolean,
  sessionId?: string,
): Promise<void> {
  const db = announcementDb ?? managedFeltDb();
  const id = announcementId(key);
  const receipt = await db.collection<AnnouncementReceipt>(ANNOUNCEMENT_COLLECTION).get(id);
  if (receipt?.claimId !== claimId || !Number.isSafeInteger(receipt.__version)) return;
  try {
    await db.transaction((tx) => {
      const collection = tx.collection<AnnouncementReceipt>(ANNOUNCEMENT_COLLECTION);
      if (sent) collection.set(id, {
        id, status: "sent", claimId, at: new Date().toISOString(), sessionId,
      }, { ifVersion: receipt.__version });
      else collection.delete(id, { ifVersion: receipt.__version });
    }, { transactionId: `opensession:shipped-change:settle:${id}:${claimId}:${sent}` });
  } catch (error) {
    const current = await db.collection<AnnouncementReceipt>(ANNOUNCEMENT_COLLECTION).get(id);
    if (current?.claimId === claimId && (sent ? current.status !== "sent" : current)) throw error;
  }
}

/**
 * Drop a receipt so the same update can be shared again. Undo removes the
 * message from Slack, so the claim that stopped a second send is stale.
 */
export async function forgetShippedChangeAnnouncement(
  key: string,
): Promise<void> {
  const db = announcementDb ?? managedFeltDb();
  const id = announcementId(key);
  const receipt = await db.collection<AnnouncementReceipt>(ANNOUNCEMENT_COLLECTION).get(id);
  if (!receipt || !Number.isSafeInteger(receipt.__version)) return;
  await db.transaction((tx) => {
    tx.collection<AnnouncementReceipt>(ANNOUNCEMENT_COLLECTION).delete(id, { ifVersion: receipt.__version });
  }, { transactionId: `opensession:shipped-change:forget:${id}:${receipt.__version}` });
}

export function validWalkthroughScreenshot(
  path: string,
  sessionId: string,
  uploadsRoot = UPLOADS_DIR,
): boolean {
  try {
    const root = realpathSync(resolve(uploadsRoot, "walkthrough", sessionId));
    const candidate = realpathSync(path);
    const within = relative(root, candidate);
    if (within.startsWith("..") || resolve(root, within) !== candidate) return false;
    const dot = candidate.lastIndexOf(".");
    if (dot < 0 || !SCREENSHOT_EXTS.has(candidate.slice(dot).toLowerCase())) return false;
    const stat = statSync(candidate);
    return stat.isFile() && stat.size > 0 && stat.size <= MAX_SCREENSHOT_BYTES;
  } catch {
    return false;
  }
}

export function validFeaturedScreenshot(path: string): boolean {
	try {
		const candidate = realpathSync(path);
		const tempRoot = realpathSync(tmpdir());
		const scoped = candidate.startsWith(`${tempRoot}/`) || candidate.startsWith(`${homeDir()}/`);
		if (!scoped) return false;
		const dot = candidate.lastIndexOf(".");
		if (dot < 0 || !SCREENSHOT_EXTS.has(candidate.slice(dot).toLowerCase())) return false;
		const stat = statSync(candidate);
		return stat.isFile() && stat.size > 0 && stat.size <= MAX_SCREENSHOT_BYTES;
	} catch {
		return false;
	}
}

export function selectShippedVisualChange(
  session: UnifiedSession,
  fileExists: (path: string, sessionId: string) => boolean = validWalkthroughScreenshot,
  requestedScreenshots?: string[],
): ShippedVisualChange | null {
  const walkthroughScreenshot = session.walkthrough?.shots?.find((shot) => shot.after)?.after;
  const screenshots = [...new Set(
    requestedScreenshots === undefined
      ? walkthroughScreenshot && fileExists(walkthroughScreenshot, session.id)
        ? [walkthroughScreenshot]
        : []
      : requestedScreenshots.filter(validFeaturedScreenshot),
  )].slice(0, 10);
  if (!screenshots.length) return null;
  return {
    sessionId: session.id,
    screenshots,
    summary: session.walkthrough?.summary || "",
  };
}

/** Collapse the walkthrough's first prose paragraph into Slack-sized copy. */
export function shippedChangeOneLiner(markdown: string, max = 280): string {
  const paragraphs = markdown
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);
  const prose =
    paragraphs.find((part) => !/^#{1,6}\s/.test(part) && !/^[-*]\s*$/.test(part)) || "";
  const plain = prose
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s*(?:#{1,6}|[-*+])\s+/gm, "")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= max) return plain;
  const clipped = plain.slice(0, max - 1);
  const wordBoundary = clipped.lastIndexOf(" ");
  return `${clipped.slice(0, wordBoundary > max * 0.7 ? wordBoundary : undefined).trimEnd()}…`;
}

function slackText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function shippedChangeChannels(): ShippedChangeChannel[] {
  const names = configuredIntegration("slack").channelNames;
  if (!names || typeof names !== "object" || Array.isArray(names)) return [];
  return Object.entries(names)
    .filter(([id, name]) => /^C[A-Z0-9]+$/.test(id) && typeof name === "string" && name.trim())
    .map(([id, name]) => ({ id, name: String(name).trim() }));
}

export function normalizeShippedChangeMessage(value: unknown): string {
  if (typeof value !== "string") return "";
  const message = value.replace(/\s+/g, " ").trim();
  if (message.length > 500) throw new Error("Slack message must be 500 characters or fewer");
  return message;
}

export function shippedChangeAnnouncementKey(
  repoFullName: string,
  prNumber: number,
  channel: string,
  comment: string,
  screenshots: string[],
): string {
  const payload = JSON.stringify({ channel, comment, screenshots });
  return `${repoFullName}#${prNumber}:${createHash("sha256").update(payload).digest("hex")}`;
}

export async function shareShippedVisualChange(opts: {
  session: UnifiedSession;
  pr: { number: number; title: string; url: string };
  repoFullName: string;
  requestedBy?: string;
  channel?: string;
  message?: string;
  slackToken?: string;
  screenshots?: string[];
}): Promise<{
  status: "shared" | "already_shared";
  channel?: ShippedChangeChannel;
  permalink?: string;
  /** Message timestamp, so the sender can undo the post. */
  ts?: string;
  announcementKey?: string;
}> {
  const channels = shippedChangeChannels();
  const channel = opts.channel || shippedChangesChannel();
  if (!channel) throw new Error("Shipped changes channel is not configured");
  if (!channels.some((candidate) => candidate.id === channel)) {
    throw new Error("Choose a configured Slack channel");
  }
  if (!opts.slackToken) {
    throw new Error("Connect your Slack account in Settings → Account to post as yourself");
  }
  const visual = selectShippedVisualChange(
    opts.session,
    validWalkthroughScreenshot,
    opts.screenshots,
  );
  const title = opts.pr.title.replace(/\|/g, "¦");
  const message = normalizeShippedChangeMessage(opts.message) ||
    shippedChangeOneLiner(visual?.summary || "");
  if (!message) throw new Error("Write a short Slack message first");
  const comment = slackText(message);
  const announcementKey = shippedChangeAnnouncementKey(
    opts.repoFullName,
    opts.pr.number,
    channel,
    comment,
    visual?.screenshots || [],
  );
  const claimId = await claimShippedChangeAnnouncement(announcementKey);
  if (!claimId) return { status: "already_shared" };
  let permalink: string | undefined;
  let ts: string | undefined;
  try {
    if (visual) {
      const completed = await postSlackFiles(channel, visual.screenshots, comment, {
        title: `${title} · shipped`,
        altText: `Screenshot of the shipped visual change: ${title}`,
      }, opts.slackToken);
      ts = await slackUploadTs(completed, channel, opts.slackToken);
    } else {
      const posted = await sendSlackMessage(channel, comment, undefined, opts.slackToken);
      if (!posted?.ok) throw new Error(`Slack message failed: ${posted?.error || "invalid response"}`);
      ts = typeof posted.ts === "string" ? posted.ts : undefined;
    }
    permalink = ts ? await slackPermalink(channel, ts, opts.slackToken) : undefined;
    await settleShippedChangeAnnouncement(
      announcementKey,
      claimId,
      true,
      opts.session.id,
    );
  } catch (error) {
    await settleShippedChangeAnnouncement(announcementKey, claimId, false);
    throw error;
  }
  audit({
    msg: "github_shipped_visual_change_announced",
    repo: opts.repoFullName,
    pr_number: opts.pr.number,
    session_id: opts.session.id,
    slack_channel: channel,
    requested_by: opts.requestedBy,
  });
  console.log(
    `[github] Shared merged change ${opts.repoFullName}#${opts.pr.number} in Slack from ${opts.session.id}`,
  );
  return {
    status: "shared",
    channel: channels.find((candidate) => candidate.id === channel),
    permalink,
    ts,
    announcementKey,
  };
}
