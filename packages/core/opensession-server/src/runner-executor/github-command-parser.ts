/**
 * GitHub Command Parser for Mission Control.
 *
 * Translates natural language commands to GitHub API operations.
 */

import type { GitHubCommand } from "./mission-control-github";

/**
 * Parse natural language commands for GitHub.
 */
export class GitHubCommandParser {
  /**
   * Parse a command string.
   */
  parse(command: string): GitHubCommand | null {
    const lowerCommand = command.toLowerCase().trim();

    // MOST SPECIFIC FIRST (specific issue/PR numbers)
    
    // Get specific PR (must come before get_issue)
    let match = command.match(/^(?:get|show|check)?\s*(?:pr|pull)\s+#?(\d+)/i);
    if (match) {
      return {
        action: "get_pr",
        params: { number: parseInt(match[1], 10) },
      };
    }

    // Close PR (must come before close_issue)
    match = command.match(/^close\s+(?:pr|pull)\s+#?(\d+)/i);
    if (match) {
      return {
        action: "close_pr",
        params: { number: parseInt(match[1], 10) },
      };
    }

    // Merge PR
    match = command.match(/^merge\s+(?:pr|pull)?\s*#?(\d+)/i);
    if (match) {
      const method = lowerCommand.includes("squash")
        ? "squash"
        : lowerCommand.includes("rebase")
          ? "rebase"
          : "merge";
      return {
        action: "merge_pr",
        params: { number: parseInt(match[1], 10), method },
      };
    }

    // Comment on PR/issue
    match = command.match(/^comment\s+(?:on|to)\s+(?:pr|pull|issue)?\s*#?(\d+)\s+(?:with\s+)?(?:message|say|write)?\s*(?:")?([^"]+)/i);
    if (match) {
      return {
        action: "comment",
        params: {
          number: parseInt(match[1], 10),
          message: match[2].trim(),
        },
      };
    }

    // Add labels to issue/PR
    match = command.match(/^(?:add|tag|label)\s+(?:labels?|tags?)\s+([^"]+?)\s+(?:to|on)\s+(?:issue|pr|pull)?\s*#?(\d+)/i);
    if (match) {
      return {
        action: "label",
        params: {
          labels: match[1].split(/[,;]\s*/).map((l) => l.trim()),
          number: parseInt(match[2], 10),
        },
      };
    }

    // Get specific issue (must come after get_pr)
    match = command.match(/^(?:get|show|check)?\s*issue\s+#?(\d+)/i);
    if (match) {
      return {
        action: "get_issue",
        params: { number: parseInt(match[1], 10) },
      };
    }

    // Close issue
    match = command.match(/^close\s+issue\s+#?(\d+)/i);
    if (match) {
      return {
        action: "close_issue",
        params: { number: parseInt(match[1], 10) },
      };
    }

    // LESS SPECIFIC (list, create, etc)

    // List PRs
    if (lowerCommand.match(/^(?:show|list|get)\s+(?:open|my)?\s*(?:prs?|pull\s+requests?)/i)) {
      return {
        action: "list_prs",
        params: { state: lowerCommand.includes("closed") ? "closed" : "open" },
      };
    }

    // List issues
    if (lowerCommand.match(/^(?:show|list|get)\s+(?:open)?\s*issues?/i)) {
      return {
        action: "list_issues",
        params: { state: lowerCommand.includes("closed") ? "closed" : "open" },
      };
    }

    // List commits
    if (lowerCommand.match(/^(?:show|list|get)\s+(?:changes?|commits?)/i)) {
      const sinceDaysMatch = command.match(/since\s+(\d+)\s+days?/i);
      return {
        action: "list_commits",
        params: { sinceDays: sinceDaysMatch ? parseInt(sinceDaysMatch[1], 10) : 1 },
      };
    }

    // Create PR
    if (lowerCommand.match(/^(?:create|open)\s+(?:pr|pull)/i)) {
      const titleMatch = command.match(/(?:pr|pull)\s+(?:titled?|called?|named?|")?([^"]+)/i);
      return {
        action: "create_pr",
        params: {
          title: titleMatch ? titleMatch[1].trim() : "New PR",
          body: command,
        },
      };
    }

    // Create issue
    if (lowerCommand.match(/^create\s+(?:issue|bug|feature)/i)) {
      const titleMatch = command.match(/(?:issue|bug|feature)\s+(?:titled?|called?|named?|")?([^"]+)/i);
      return {
        action: "create_issue",
        params: {
          title: titleMatch ? titleMatch[1].trim() : "New issue",
          body: command,
        },
      };
    }

    // Reopen
    if (lowerCommand.match(/^reopen/i)) {
      const numberMatch = command.match(/(?:issue|pr|pull|#)?\s*#?(\d+)/i);
      return {
        action: "reopen",
        params: {
          number: numberMatch ? parseInt(numberMatch[1], 10) : 0,
          type: lowerCommand.includes("issue") ? "issue" : "pr",
        },
      };
    }

    return null;
  }
}

/**
 * Create a GitHub command parser.
 */
export function createGitHubCommandParser(): GitHubCommandParser {
  return new GitHubCommandParser();
}
