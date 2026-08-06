/**
 * SlackProgress — a live, in-place progress checklist for the persistent
 * "Working…" card.
 *
 * Unlike SlackStreamer.setStatus (which uses the Assistant typing indicator and
 * is therefore DM-only), this edits a real channel message via chat.update, so
 * it works in shared channels too — that's where the bot previously showed *no*
 * progress at all between the :eyes: reaction and the final answer.
 *
 * Design (mirrors Claude Tag's Slack UX):
 *   - One message, edited in place — never a stream of new posts.
 *   - Updates happen at semantic boundaries (a step starts/completes, a tool
 *     runs), NOT per token.
 *   - Edits are throttled to ~1/sec because Slack soft-limits chat.update to
 *     roughly one call per second per channel; bursting causes the very lag and
 *     stutter we're trying to remove.
 */

import { updateSlackBlocks } from "./slack-api";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface ProgressTodo {
  content: string;
  status: TodoStatus;
  activeForm?: string;
}

/** Slack soft-limits chat.update to ~1/sec/channel. Stay just above that. */
const MIN_EDIT_INTERVAL_MS = 1100;

export class SlackProgress {
  private channel: string;
  private ts: string | null;
  /** Action block(s) shown while running (Stop + Open Session). */
  private runningBlocks: any[];
  /** Action block(s) shown after finishing (Open Session only). */
  private finalBlocks: any[];

  private todos: ProgressTodo[] = [];
  private action: string | null = null;
  private title = "Working…";

  private lastEditAt: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private finished = false;
  /** In-flight edit, so finish() can wait for it and avoid a stale overwrite. */
  private inflight: Promise<void> | null = null;

  constructor(
    channel: string,
    ts: string | null,
    runningBlocks: any[],
    finalBlocks: any[]
  ) {
    this.channel = channel;
    this.ts = ts;
    this.runningBlocks = runningBlocks;
    this.finalBlocks = finalBlocks;
    // The card is posted with an initial section already rendered, so don't
    // immediately re-edit it — let the throttle window pass first.
    this.lastEditAt = Date.now();
  }

  /** Replace the checklist from a TodoWrite tool call. */
  setTodos(todos: ProgressTodo[] | undefined): void {
    if (!Array.isArray(todos)) return;
    this.todos = todos;
    this.schedule();
  }

  /** Set the current activity line (from a tool call / TaskCreate). */
  setAction(text: string | undefined): void {
    if (!text) return;
    this.action = text;
    this.schedule();
  }

  private renderText(includeAction: boolean): string {
    const lines: string[] = [`:hourglass_flowing_sand: *${this.title}*`];
    for (const t of this.todos) {
      const label = t.content?.trim() || "(step)";
      if (t.status === "completed") {
        lines.push(`:white_check_mark: ~${label}~`);
      } else if (t.status === "in_progress") {
        lines.push(`:hourglass_flowing_sand: *${t.activeForm?.trim() || label}*`);
      } else {
        lines.push(`:white_large_square: ${label}`);
      }
    }
    if (includeAction && this.action) lines.push(`_${this.action}_`);
    return lines.join("\n");
  }

  private schedule(): void {
    if (this.finished || !this.ts) return;
    const wait = this.lastEditAt + MIN_EDIT_INTERVAL_MS - Date.now();
    if (wait <= 0) {
      void this.flush();
      return;
    }
    // Coalesce: a single trailing edit captures whatever the latest state is.
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, wait);
    }
  }

  private async flush(): Promise<void> {
    if (this.finished || !this.ts) return;
    this.lastEditAt = Date.now();
    const ts = this.ts;
    const blocks = [
      { type: "section", text: { type: "mrkdwn", text: this.renderText(true) } },
      ...this.runningBlocks,
    ];
    this.inflight = (async () => {
      try {
        await updateSlackBlocks(this.channel, ts, this.title, blocks);
      } catch (e) {
        console.warn("[slack] progress flush failed:", e);
      }
    })();
    try {
      await this.inflight;
    } finally {
      this.inflight = null;
    }
  }

  /**
   * Stop updating and render the terminal state of the card. The completed
   * checklist stays visible; the Stop button is swapped for the Open Session link.
   */
  async finish(label: string): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Let any in-flight running-state edit land first, so our terminal render
    // isn't immediately overwritten by a stale update.
    if (this.inflight) {
      try {
        await this.inflight;
      } catch {
        /* already logged */
      }
    }
    if (!this.ts) return;
    this.title = label;
    const blocks: any[] = [];
    if (this.todos.length) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: this.renderText(false) },
      });
    } else {
      blocks.push({
        type: "context",
        elements: [{ type: "mrkdwn", text: `_${label}_` }],
      });
    }
    blocks.push(...this.finalBlocks);
    try {
      await updateSlackBlocks(this.channel, this.ts, label, blocks);
    } catch (e) {
      console.warn("[slack] progress finish failed:", e);
    }
    this.ts = null;
  }
}
