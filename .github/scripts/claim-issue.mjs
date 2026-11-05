// Assigns an issue to a contributor who asks to work on it in a comment, and releases it
// again on request. Run by .github/workflows/claim-issue.yml on issue_comment events.
//
// The comment is untrusted input: it is only pattern-matched here, never passed to a shell,
// and never quoted back in a reply. Replies mention logins only.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const COMMAND_CLAIM = /^\s*[/.](?:assign|take)(?:\s+me)?\s*$/im;
const COMMAND_RELEASE = /^\s*\/unassign(?:\s+me)?\s*$/im;

const CLAIM_PHRASES = [
  /\b(?:i'?d like|i would like|i want|i'?m (?:happy|keen|glad|interested)|i am (?:happy|keen|glad|interested)|can i|could i|may i|let me|i'?ll|i will|i can)\b.{0,40}?\b(?:work on|pick (?:this |it )?up|take (?:this|it|this one|on this)|handle (?:this|it)|tackle (?:this|it)|fix (?:this|it))\b/i,
  /\bassign (?:it |this |this issue )?(?:to )?me\b/i,
  /\bi'?d like to be assigned\b/i,
];
const RELEASE_PHRASES = [/\bunassign me\b/i, /\b(?:i'?m|i am) no longer working on\b/i];
const NEGATION = /\b(?:don'?t|do not|not|no longer|can'?t|cannot|won'?t|will not|never)\b/i;

/**
 * Drops quoted lines and fenced code, so quoting someone else's "/assign" or pasting a log
 * does not count as asking.
 */
export function ownWords(body) {
  return String(body ?? "")
    .replace(/```[\s\S]*?(?:```|$)/g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(">"))
    .join("\n");
}

/** "claim", "release" or undefined for a comment body. */
export function parseIntent(body) {
  const text = ownWords(body);
  if (COMMAND_RELEASE.test(text)) {
    return "release";
  }
  if (COMMAND_CLAIM.test(text)) {
    return "claim";
  }
  const sentences = text.split(/[.!?\n]+/);
  if (sentences.some((s) => RELEASE_PHRASES.some((re) => re.test(s)))) {
    return "release";
  }
  if (sentences.some((s) => !NEGATION.test(s) && CLAIM_PHRASES.some((re) => re.test(s)))) {
    return "claim";
  }
  return undefined;
}

/**
 * What to do, from the facts only. Returns { action, reply } where action is "assign",
 * "unassign" or "none", and reply is the comment to post (undefined for none).
 */
export function decide({ intent, login, assignees, repository }) {
  const repo = `https://github.com/${repository}`;
  const mine = assignees.includes(login);
  if (intent === "release") {
    return mine
      ? {
          action: "unassign",
          reply: `@${login} you are no longer assigned; the issue is open for someone else. Thanks for letting us know.`,
        }
      : { action: "none" };
  }
  if (intent !== "claim" || mine) {
    return { action: "none" };
  }
  if (assignees.length > 0) {
    return {
      action: "none",
      reply: `@${login} this issue is already assigned to ${assignees.map((a) => `@${a}`).join(", ")}. Have a look at the other [good first issues](${repo}/labels/good%20first%20issue), or comment here if the assignee has gone quiet.`,
    };
  }
  return {
    action: "assign",
    reply: `Assigned to @${login}. Please open a pull request when you are ready (see [CONTRIBUTING.md](${repo}/blob/main/CONTRIBUTING.md)), or comment \`/unassign\` if you can no longer work on it. If you find releaseproof useful, giving the [repository](${repo}) a ⭐ helps others find it. Thank you!`,
  };
}

function githubApi(token, repository) {
  const base = `${process.env.GITHUB_API_URL ?? "https://api.github.com"}/repos/${repository}`;
  return async (method, path, body) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "releaseproof-claim-issue",
        "x-github-api-version": "2022-11-28",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      throw new Error(`GitHub API ${method} ${path} returned HTTP ${response.status}`);
    }
    return response.status === 204 ? undefined : response.json();
  };
}

/** Handles one issue_comment event. `api(method, path, body)` talks to the repository. */
export async function run(event, api, log = console.log) {
  const repository = event.repository?.full_name ?? "";
  const issue = event.issue;
  const comment = event.comment;
  const login = comment?.user?.login;
  if (!issue || !comment || !login || issue.pull_request || issue.state !== "open") {
    return log("not a comment on an open issue; nothing to do");
  }
  if (comment.user.type === "Bot" || comment.author_association === "OWNER") {
    return log("comment by a bot or the owner; nothing to do");
  }
  const intent = parseIntent(comment.body);
  if (!intent) {
    return log("no request to work on the issue; nothing to do");
  }

  const assignees = (issue.assignees ?? []).map((a) => a.login);
  const { action, reply } = decide({ intent, login, assignees, repository });
  log(`${intent} by ${login} on #${issue.number}: ${action}`);

  let message = reply;
  if (action === "assign") {
    const updated = await api("POST", `/issues/${issue.number}/assignees`, { assignees: [login] });
    // GitHub silently drops users it cannot assign instead of failing.
    if (!(updated.assignees ?? []).some((a) => a.login === login)) {
      message = `@${login} GitHub did not accept the assignment; a maintainer will assign you by hand.`;
    }
  } else if (action === "unassign") {
    await api("DELETE", `/issues/${issue.number}/assignees`, { assignees: [login] });
  }
  if (message) {
    await api("POST", `/issues/${issue.number}/comments`, { body: message });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  await run(event, githubApi(process.env.GITHUB_TOKEN, process.env.GITHUB_REPOSITORY));
}
