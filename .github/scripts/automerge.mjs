// Merges a pull request that carries the "automerge" label once it is exactly what a
// maintainer approved. Run by .github/workflows/automerge.yml.
//
// Adding the label means: "merge this as I reviewed it, once the author has committed my
// suggested changes and CI is green." So the script
//   1. takes the reviewed commit from the review that the person who added the label
//      submitted before adding it. GitHub records that commit; nobody else can write it;
//   2. computes what the files look like with the maintainers' suggestions applied to that
//      commit, and compares git blob hashes with the pull request's head: every changed
//      file must be a suggested file with exactly the suggested content;
//   3. waits for CI on that head, then squash-merges exactly that head.
// Anything else (another change, an edited title, a new base branch) removes the label and
// says why. Nothing is ever merged on a guess: when in doubt the label comes off.
//
// Every fact a decision rests on comes from GitHub's own records of what maintainers did:
// label events, reviews, review comments, git trees. Comments are never read as state: other
// workflows here post comments as github-actions[bot] in reply to anyone, so a comment
// proves nothing.
//
// The workflow has a write token on events a contributor can trigger, so this script must
// never read or run files from the pull request: it works through the GitHub API only, and
// the pull request's text (title, paths, comment bodies) is data. It is never put into a
// shell, and never into the merge commit message, where "[skip ci]" would be an instruction.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const LABEL = "automerge";

/** Workflows that must have passed on the head commit, as a pull_request run. */
export const REQUIRED_WORKFLOWS = [
  ".github/workflows/ci.yml",
  ".github/workflows/action-self-test.yml",
];

/**
 * Workflows started on the default branch after a merge. A merge made with the workflow
 * token starts no "push" workflows, so the ones that matter and allow workflow_dispatch are
 * started by hand. release.yml has no workflow_dispatch on purpose; it runs on the next
 * ordinary push.
 */
export const FOLLOW_UP_WORKFLOWS = ["pages.yml"];

/**
 * The issues a pull request closes: its closing keywords ("Closes #12") and the issues
 * linked in the sidebar, as GitHub resolves them.
 */
const LINKED_ISSUES = `
query ($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      closingIssuesReferences(first: 20) {
        nodes {
          number
          state
          repository { nameWithOwner }
        }
      }
    }
  }
}`;

/** Repository permissions that allow merging; only these people may arm or suggest. */
const CAN_MERGE = new Set(["admin", "maintain", "write"]);
const PASSING = new Set(["success", "skipped", "neutral"]);
/** Above this many suggestions in one file, only "none" and "all" applied are recognised. */
const MAX_PARTIAL_SUGGESTIONS = 10;
/** The id git gives a file with these bytes; the same value the trees API reports. */
export function gitBlobSha(buffer) {
  return createHash("sha1").update(`blob ${buffer.length}\0`).update(buffer).digest("hex");
}

/**
 * The ```suggestion blocks of a review comment, each as its replacement lines (an empty
 * block deletes the lines). Other code blocks are skipped, so a suggestion quoted inside
 * one does not count. An unclosed suggestion block makes the comment unreadable: undefined.
 */
export function parseSuggestions(body) {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  for (let index = 0; index < lines.length; index++) {
    const open = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)/.exec(lines[index]);
    if (!open) {
      continue;
    }
    const [, fence, info] = open;
    const close = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*$`);
    const isSuggestion = /^suggestion(?:$|:)/.test(info);
    const end = lines.findIndex((line, at) => at > index && close.test(line));
    if (end === -1) {
      // Markdown treats the rest of the comment as this block.
      return isSuggestion ? undefined : blocks;
    }
    if (isSuggestion) {
      blocks.push(lines.slice(index + 1, end));
    }
    index = end;
  }
  return blocks;
}

/**
 * The commit the labeller reviewed: the commit of their latest review submitted no later
 * than `labelledAt`. A review made after the label does not move it, so the label always
 * covers a review its owner had finished. Replies in a thread are reviews for GitHub too;
 * they are skipped, because a reply is not a look at the code.
 */
export function reviewedCommit({ reviews, reviewComments, labeller, labelledAt }) {
  const startsThread = new Set(
    reviewComments
      .filter((comment) => !comment.in_reply_to_id)
      .map((comment) => comment.pull_request_review_id),
  );
  return reviews
    .filter(
      (review) =>
        review.user?.login === labeller &&
        /^[0-9a-f]{40}$/.test(review.commit_id ?? "") &&
        typeof review.submitted_at === "string" &&
        Date.parse(review.submitted_at) <= Date.parse(labelledAt) &&
        (review.state === "APPROVED" ||
          review.state === "CHANGES_REQUESTED" ||
          (review.state === "COMMENTED" &&
            ((review.body ?? "").trim() !== "" || startsThread.has(review.id)))),
    )
    .sort((a, b) => Date.parse(a.submitted_at) - Date.parse(b.submitted_at))
    .at(-1)?.commit_id;
}

/**
 * `content` with the suggestions applied. Each suggestion replaces lines start..end
 * (1-based, inclusive) with its own lines. Works on bytes, so the result hashes exactly
 * like the file GitHub writes. Throws when suggestions overlap or point outside the file.
 */
export function applySuggestions(content, suggestions) {
  const lines = content.toString("latin1").split("\n");
  const endsWithNewline = lines.at(-1) === "";
  const lineCount = endsWithNewline ? lines.length - 1 : lines.length;
  const crlf = lines.length > 1 && lines[0].endsWith("\r");
  const ordered = [...suggestions].sort((a, b) => a.start - b.start);
  ordered.forEach((suggestion, index) => {
    const { start, end } = suggestion;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
      throw new Error("a suggestion has no usable line range");
    }
    if (end > lineCount) {
      throw new Error("a suggestion points past the end of the file");
    }
    if (index > 0 && start <= ordered[index - 1].end) {
      throw new Error("two suggestions cover the same lines");
    }
  });
  for (const { start, end, lines: replacement } of ordered.reverse()) {
    const isLastLine = end === lines.length;
    const encoded = replacement.map((line, index) => {
      const bytes = Buffer.from(line, "utf8").toString("latin1");
      const keepBare = isLastLine && index === replacement.length - 1;
      return crlf && !keepBare ? `${bytes}\r` : bytes;
    });
    lines.splice(start - 1, end - start + 1, ...encoded);
  }
  return Buffer.from(lines.join("\n"), "latin1");
}

/**
 * The blob ids a suggested file may have: `full` with every suggestion applied, `partial`
 * with some of them (the author is still clicking through "Commit suggestion").
 */
export function expectedBlobs(content, suggestions) {
  const full = gitBlobSha(applySuggestions(content, suggestions));
  const partial = new Set();
  if (suggestions.length <= MAX_PARTIAL_SUGGESTIONS) {
    for (let mask = 1; mask < 2 ** suggestions.length - 1; mask++) {
      const subset = suggestions.filter((_, index) => mask & (2 ** index));
      partial.add(gitBlobSha(applySuggestions(content, subset)));
    }
  }
  return { full, partial };
}

/**
 * Compares the reviewed tree with the head tree (maps of path to { sha, mode }):
 * - "ready": the head is the reviewed commit with every suggestion applied, nothing else;
 * - "partial": only suggested files changed, and only by suggestions, but not all yet;
 * - "violation": `paths` changed in a way no suggestion explains.
 */
export function classifyTrees(reviewed, head, expected) {
  const unexplained = [];
  let complete = true;
  for (const path of new Set([...reviewed.keys(), ...head.keys()])) {
    const before = reviewed.get(path);
    const after = head.get(path);
    const wanted = expected.get(path);
    if (before && after && before.sha === after.sha && before.mode === after.mode) {
      if (wanted && wanted.full !== before.sha) {
        complete = false;
      }
    } else if (!before || !after || !wanted || before.mode !== after.mode) {
      unexplained.push(path);
    } else if (after.sha !== wanted.full) {
      if (wanted.partial.has(after.sha)) {
        complete = false;
      } else {
        unexplained.push(path);
      }
    }
  }
  if (unexplained.length > 0) {
    return { state: "violation", paths: unexplained.sort() };
  }
  return { state: complete ? "ready" : "partial" };
}

/** A fence longer than any backtick run inside, so untrusted paths cannot close the block. */
function fenced(text) {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text}\n${fence}`;
}

function githubApi(token) {
  const root = process.env.GITHUB_API_URL ?? "https://api.github.com";
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "user-agent": "releaseproof-automerge",
    "x-github-api-version": "2022-11-28",
  };
  return async (method, path, body) => {
    const response = await fetch(`${root}${path}`, {
      method,
      headers: body ? { ...headers, "content-type": "application/json" } : headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      const error = new Error(`GitHub API ${method} ${path} returned HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response.status === 204 ? undefined : response.json();
  };
}

/**
 * Handles one event. `api(method, path, body)` calls the GitHub REST API.
 * `eventName` is pull_request_target or workflow_run.
 */
export async function run({ eventName, event }, api, log = console.log) {
  const repository = event.repository?.full_name ?? "";
  const defaultBranch = event.repository?.default_branch ?? "";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !defaultBranch) {
    return log("no repository in the event; nothing to do");
  }
  const repo = `/repos/${repository}`;
  const permissions = new Map();

  /** Every item of a paginated list; refuses to guess when the list is implausibly long. */
  async function list(path, key) {
    const items = [];
    for (let page = 1; page <= 20; page++) {
      const data = await api(
        "GET",
        `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
      );
      const batch = key ? (data?.[key] ?? []) : (data ?? []);
      items.push(...batch);
      if (batch.length < 100) {
        return items;
      }
    }
    throw new Error(`${path} has more than 2000 entries; refusing to decide on a partial list`);
  }

  async function canMerge(login) {
    if (!login || !/^[A-Za-z0-9-]{1,39}(?:\[bot\])?$/.test(login)) {
      return false;
    }
    if (!permissions.has(login)) {
      let permission = "none";
      try {
        permission = (await api("GET", `${repo}/collaborators/${login}/permission`))?.permission;
      } catch (error) {
        if (error.status !== 404) {
          throw error;
        }
      }
      permissions.set(login, CAN_MERGE.has(permission));
    }
    return permissions.get(login);
  }

  /**
   * Closes the open issues of this repository that the merged pull request says it closes.
   * GitHub does this itself when a person merges; for a merge made with the workflow token
   * it leaves them open. A failure here is only logged: the merge has already happened.
   */
  async function closeLinkedIssues(number) {
    try {
      const [owner, name] = repository.split("/");
      const result = await api("POST", "/graphql", {
        query: LINKED_ISSUES,
        variables: { owner, name, number },
      });
      if (result?.errors?.length) {
        throw new Error(result.errors.map((entry) => entry.message).join("; "));
      }
      const linked = result?.data?.repository?.pullRequest?.closingIssuesReferences?.nodes ?? [];
      for (const issue of linked) {
        const sameRepository =
          issue?.repository?.nameWithOwner?.toLowerCase() === repository.toLowerCase();
        if (!sameRepository || issue.state !== "OPEN" || !Number.isInteger(issue.number)) {
          continue;
        }
        await api("PATCH", `${repo}/issues/${issue.number}`, {
          state: "closed",
          state_reason: "completed",
        });
        log(`#${number}: closed issue #${issue.number}`);
      }
    } catch (error) {
      log(`#${number}: could not close its linked issues: ${error.message}`);
    }
  }

  /** Takes the label off and says why. Silent when another run already removed it. */
  async function disarm(number, reason, details) {
    try {
      await api("DELETE", `${repo}/issues/${number}/labels/${encodeURIComponent(LABEL)}`);
    } catch (error) {
      if (error.status === 404) {
        return log(`#${number}: label already removed (${reason})`);
      }
      throw error;
    }
    log(`#${number}: label removed: ${reason}`);
    await api("POST", `${repo}/issues/${number}/comments`, {
      body: [
        `**Automerge is off:** ${reason}`,
        ...(details ? ["", fenced(details)] : []),
        "",
        `Nothing was merged. A maintainer can review the pull request as it is now and add the \`${LABEL}\` label again.`,
      ].join("\n"),
    });
  }

  async function tree(sha) {
    const data = await api("GET", `${repo}/git/trees/${sha}?recursive=1`);
    if (data?.truncated || !Array.isArray(data?.tree)) {
      return undefined;
    }
    return new Map(
      data.tree
        .filter((entry) => entry.type !== "tree")
        .map((entry) => [entry.path, { sha: entry.sha, mode: entry.mode }]),
    );
  }

  /** undefined when CI passed on `head`; otherwise what is still missing. */
  async function ciProblem(head) {
    // The newest pull_request run of each workflow on this commit. A re-opened pull request
    // has older runs on the same commit; only the newest one says how things stand.
    const latest = new Map();
    for (const candidate of await list(`${repo}/actions/runs?head_sha=${head}`, "workflow_runs")) {
      if (candidate.event !== "pull_request" || candidate.head_sha !== head) {
        continue;
      }
      const known = latest.get(candidate.path);
      if (!known || candidate.run_number > known.run_number) {
        latest.set(candidate.path, candidate);
      }
    }
    for (const path of REQUIRED_WORKFLOWS) {
      const required = latest.get(path);
      if (required?.status !== "completed" || required.conclusion !== "success") {
        return `${path} has not passed on ${head.slice(0, 7)}`;
      }
    }
    // Check runs of those newest runs, and of apps such as secret scanners. Runs of this
    // repository's own automation (pull_request_target) are not tests of the change, and
    // check runs of superseded runs no longer count.
    const current = new Set([...latest.values()].map((candidate) => String(candidate.id)));
    for (const check of await list(`${repo}/commits/${head}/check-runs`, "check_runs")) {
      if (check.app?.slug === "github-actions") {
        const runId = /\/actions\/runs\/(\d+)(?:\/|$)/.exec(check.details_url ?? "")?.[1];
        if (!runId || !current.has(runId)) {
          continue;
        }
      }
      if (check.status !== "completed" || !PASSING.has(check.conclusion)) {
        return `a check has not passed on ${head.slice(0, 7)}`;
      }
    }
    const status = await api("GET", `${repo}/commits/${head}/status`);
    if (status?.total_count > 0 && status.state !== "success") {
      return `a commit status has not passed on ${head.slice(0, 7)}`;
    }
    return undefined;
  }

  /**
   * `justLabelled` is set on the event that added the label: who added it and when. The
   * events list may not show that event yet, so the newer of the two is used.
   */
  async function evaluate(number, justLabelled) {
    const pr = await api("GET", `${repo}/pulls/${number}`);
    if (pr.state !== "open" || pr.merged) {
      return log(`#${number}: not open`);
    }
    if (!(pr.labels ?? []).some((label) => label.name === LABEL)) {
      return log(`#${number}: no ${LABEL} label`);
    }
    const events = await list(`${repo}/issues/${number}/events`);
    const recorded = events
      .filter((entry) => entry.event === "labeled" && entry.label?.name === LABEL)
      .map((entry) => ({ by: entry.actor?.login ?? "", at: entry.created_at }))
      .at(-1);
    const labelled = [recorded, justLabelled]
      .filter((entry) => entry && !Number.isNaN(Date.parse(entry.at)))
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
      .at(-1);
    if (!labelled) {
      return log(`#${number}: labelled, but GitHub does not say by whom yet`);
    }
    if (!(await canMerge(labelled.by))) {
      return disarm(number, "only people who can merge here may add the label.");
    }
    if (pr.base?.ref !== defaultBranch) {
      return disarm(number, "the pull request does not target the default branch.");
    }
    if (
      events.some(
        (entry) =>
          entry.event === "renamed" && Date.parse(entry.created_at) > Date.parse(labelled.at),
      )
    ) {
      return disarm(number, "the title was changed after the label was added.");
    }
    const reviewComments = await list(`${repo}/pulls/${number}/comments`);
    const reviewed = reviewedCommit({
      reviews: await list(`${repo}/pulls/${number}/reviews`),
      reviewComments,
      labeller: labelled.by,
      labelledAt: labelled.at,
    });
    if (!reviewed) {
      return disarm(
        number,
        "the person who added the label has no review on this pull request from before the label. Submit your review first (approve, or comment with suggestions), then add the label.",
      );
    }
    if (pr.draft) {
      return log(`#${number}: still a draft`);
    }

    const head = pr.head.sha;
    const [reviewedTree, headTree] = await Promise.all([tree(reviewed), tree(head)]);
    if (!reviewedTree || !headTree) {
      return disarm(number, "the repository is too large to compare completely.");
    }

    // Suggestions made on the reviewed commit by people who can merge.
    const byPath = new Map();
    for (const comment of reviewComments) {
      if (comment.original_commit_id !== reviewed) {
        continue;
      }
      const blocks = parseSuggestions(comment.body ?? "");
      if (blocks?.length === 0 || !(await canMerge(comment.user?.login))) {
        continue;
      }
      if (!blocks || blocks.length > 1) {
        return disarm(
          number,
          "a maintainer's comment has an unclosed suggestion block or more than one, so the expected result is not certain.",
        );
      }
      const end = comment.original_line;
      const start = comment.original_start_line ?? end;
      const onNewSide =
        (comment.side ?? "RIGHT") === "RIGHT" && (comment.start_side ?? "RIGHT") === "RIGHT";
      if (!Number.isInteger(end) || !onNewSide) {
        continue; // GitHub offers no "Commit suggestion" there, so it can never be applied.
      }
      byPath.set(comment.path, [
        ...(byPath.get(comment.path) ?? []),
        { start, end, lines: blocks[0] },
      ]);
    }
    const expected = new Map();
    for (const [path, suggestions] of byPath) {
      const entry = reviewedTree.get(path);
      try {
        if (!entry) {
          throw new Error("a suggestion is on a file the reviewed commit does not have");
        }
        const blob = await api("GET", `${repo}/git/blobs/${entry.sha}`);
        expected.set(path, expectedBlobs(Buffer.from(blob.content, "base64"), suggestions));
      } catch (error) {
        if (error.status) {
          throw error;
        }
        return disarm(number, `the suggestions cannot be applied cleanly: ${error.message}.`);
      }
    }

    const verdict = classifyTrees(reviewedTree, headTree, expected);
    if (verdict.state === "violation") {
      const shown = verdict.paths.slice(0, 20).map((path) => JSON.stringify(path));
      const more = verdict.paths.length > 20 ? [`… ${verdict.paths.length - 20} more`] : [];
      return disarm(
        number,
        `the pull request changed in a way the suggestions do not explain (reviewed at \`${reviewed.slice(0, 7)}\`, now \`${head.slice(0, 7)}\`). Files that differ:`,
        [...shown, ...more].join("\n"),
      );
    }
    const count = [...byPath.values()].reduce((sum, suggestions) => sum + suggestions.length, 0);
    /** Tells the author what happens next, once, when the label is added. Not read back. */
    const announce = async () => {
      if (!justLabelled) {
        return;
      }
      await api("POST", `${repo}/issues/${number}/comments`, {
        body: [
          `**Automerge is on**, for the review at \`${reviewed.slice(0, 7)}\`. This pull request is squash-merged automatically once:`,
          "",
          count > 0
            ? `1. its content is exactly that commit plus the ${count} suggested change${count === 1 ? "" : "s"} from maintainers on it (use **Commit suggestion**), and nothing else;`
            : "1. its content is still exactly that commit;",
          "2. its title and base branch are unchanged;",
          "3. CI has passed on the head.",
          "",
          `Any other change takes the \`${LABEL}\` label off again, and a maintainer has to look once more.`,
        ].join("\n"),
      });
    };
    if (verdict.state === "partial") {
      await announce();
      return log(`#${number}: waiting, not every suggestion is committed yet`);
    }
    if (pr.mergeable === false) {
      return disarm(number, "the pull request has conflicts with the base branch.");
    }
    const waiting = await ciProblem(head);
    if (waiting) {
      await announce();
      return log(`#${number}: waiting, ${waiting}`);
    }

    try {
      await api("PUT", `${repo}/pulls/${number}/merge`, {
        sha: head, // GitHub refuses if the head moved after the comparison above
        merge_method: "squash",
        commit_title: `${pr.title} (#${number})`,
        // Written here on purpose: the default squash message is the author's commit
        // messages, which nobody reviewed.
        commit_message: `Merged by the ${LABEL} label: reviewed at ${reviewed} by ${labelled.by}${count > 0 ? `, plus ${count} suggested change${count === 1 ? "" : "s"} from the review` : ""}. CI passed on ${head}.`,
      });
    } catch (error) {
      if (![405, 409, 422].includes(error.status)) {
        throw error;
      }
      if ((await api("GET", `${repo}/pulls/${number}`)).merged) {
        return log(`#${number}: already merged`);
      }
      return disarm(
        number,
        `GitHub refused the merge (HTTP ${error.status}); the head may have moved, or a branch rule blocks it.`,
      );
    }
    log(`#${number}: merged ${head}`);
    await closeLinkedIssues(number);
    for (const workflow of FOLLOW_UP_WORKFLOWS) {
      try {
        await api("POST", `${repo}/actions/workflows/${workflow}/dispatches`, {
          ref: defaultBranch,
        });
      } catch (error) {
        log(`could not start ${workflow} on ${defaultBranch}: ${error.message}`);
      }
    }
  }

  if (eventName === "pull_request_target") {
    const pr = event.pull_request;
    if (!pr) {
      return log("not a pull request event; nothing to do");
    }
    const addedNow = event.action === "labeled" && event.label?.name === LABEL;
    return evaluate(
      pr.number,
      // updated_at is when the label was added: adding a label updates the pull request.
      addedNow ? { by: event.sender?.login ?? "", at: pr.updated_at } : undefined,
    );
  }
  if (eventName === "workflow_run") {
    // workflow_run names no pull request for forks, so look at every labelled one.
    const labelled = await list(`${repo}/issues?state=open&labels=${encodeURIComponent(LABEL)}`);
    for (const issue of labelled.filter((candidate) => candidate.pull_request)) {
      await evaluate(issue.number);
    }
    return;
  }
  log(`event ${eventName} is not handled`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  await run(
    { eventName: process.env.GITHUB_EVENT_NAME, event },
    githubApi(process.env.GITHUB_TOKEN),
  );
}
