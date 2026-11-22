import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applySuggestions,
  classifyTrees,
  expectedBlobs,
  FOLLOW_UP_WORKFLOWS,
  gitBlobSha,
  LABEL,
  parseSuggestions,
  REQUIRED_WORKFLOWS,
  reviewedCommit,
  run,
} from "./automerge.mjs";

const text = (buffer) => buffer.toString("utf8");
const apply = (content, suggestions) => text(applySuggestions(Buffer.from(content), suggestions));

describe("gitBlobSha", () => {
  it("gives the ids git gives", () => {
    expect(gitBlobSha(Buffer.from(""))).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    expect(gitBlobSha(Buffer.from("hello\n"))).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });
});

describe("parseSuggestions", () => {
  it("reads one block, with LF or CRLF, and keeps the text around it out", () => {
    for (const newline of ["\n", "\r\n"]) {
      const body = [
        "Use the released package.",
        "```suggestion",
        '"releaseproof": patch',
        "```",
        "Thanks!",
      ];
      expect(parseSuggestions(body.join(newline))).toEqual([['"releaseproof": patch']]);
    }
  });

  it("reads an empty block as a deletion and an empty line as an empty line", () => {
    expect(parseSuggestions("```suggestion\n```")).toEqual([[]]);
    expect(parseSuggestions("```suggestion\n\n```")).toEqual([[""]]);
  });

  it("handles longer fences, so a suggestion can contain a code block", () => {
    expect(parseSuggestions("````suggestion\n```js\nx\n```\n````")).toEqual([
      ["```js", "x", "```"],
    ]);
  });

  it("does not count a suggestion quoted inside another code block", () => {
    expect(parseSuggestions("````md\n```suggestion\nx\n```\n````")).toEqual([]);
    expect(parseSuggestions("no code here")).toEqual([]);
    expect(parseSuggestions("```suggestions\nx\n```")).toEqual([]);
  });

  it("returns every block, and undefined for an unclosed suggestion", () => {
    expect(parseSuggestions("```suggestion\na\n```\n```suggestion\nb\n```")).toEqual([
      ["a"],
      ["b"],
    ]);
    expect(parseSuggestions("```suggestion\na")).toBeUndefined();
    expect(parseSuggestions("```suggestion\na\n```\n```js\nunclosed")).toEqual([["a"]]);
  });
});

describe("applySuggestions", () => {
  const file = "one\ntwo\nthree\nfour\n";

  it("replaces a line, a range with more or fewer lines, and deletes", () => {
    expect(apply(file, [{ start: 2, end: 2, lines: ["TWO"] }])).toBe("one\nTWO\nthree\nfour\n");
    expect(apply(file, [{ start: 2, end: 3, lines: ["x"] }])).toBe("one\nx\nfour\n");
    expect(apply(file, [{ start: 1, end: 1, lines: ["a", "b"] }])).toBe("a\nb\ntwo\nthree\nfour\n");
    expect(apply(file, [{ start: 4, end: 4, lines: [] }])).toBe("one\ntwo\nthree\n");
  });

  it("applies several suggestions whatever their order", () => {
    const suggestions = [
      { start: 4, end: 4, lines: ["FOUR", "five"] },
      { start: 1, end: 2, lines: ["ONE"] },
    ];
    expect(apply(file, suggestions)).toBe("ONE\nthree\nFOUR\nfive\n");
    expect(apply(file, [...suggestions].reverse())).toBe("ONE\nthree\nFOUR\nfive\n");
  });

  it("keeps CRLF line endings, a missing final newline and non-ASCII bytes", () => {
    expect(apply("a\r\nb\r\n", [{ start: 2, end: 2, lines: ["B", "c"] }])).toBe("a\r\nB\r\nc\r\n");
    expect(apply("a\nb", [{ start: 2, end: 2, lines: ["B"] }])).toBe("a\nB");
    expect(apply("café\nnaïve\n", [{ start: 2, end: 2, lines: ["日本語"] }])).toBe(
      "café\n日本語\n",
    );
  });

  it("refuses overlapping suggestions and lines outside the file", () => {
    const overlap = [
      { start: 1, end: 2, lines: ["x"] },
      { start: 2, end: 3, lines: ["y"] },
    ];
    expect(() => apply(file, overlap)).toThrow("cover the same lines");
    expect(() => apply(file, [{ start: 5, end: 5, lines: ["x"] }])).toThrow("past the end");
    expect(() => apply(file, [{ start: 0, end: 1, lines: ["x"] }])).toThrow("no usable line range");
    expect(() => apply(file, [{ start: 3, end: 2, lines: ["x"] }])).toThrow("no usable line range");
  });
});

describe("expectedBlobs", () => {
  it("knows the file with all suggestions and with only some of them", () => {
    const content = Buffer.from("a\nb\nc\n");
    const suggestions = [
      { start: 1, end: 1, lines: ["A"] },
      { start: 3, end: 3, lines: ["C"] },
    ];
    const { full, partial } = expectedBlobs(content, suggestions);
    expect(full).toBe(gitBlobSha(Buffer.from("A\nb\nC\n")));
    expect([...partial].sort()).toEqual(
      [gitBlobSha(Buffer.from("A\nb\nc\n")), gitBlobSha(Buffer.from("a\nb\nC\n"))].sort(),
    );
  });
});

describe("reviewedCommit", () => {
  const R1 = "1".repeat(40);
  const R2 = "2".repeat(40);
  const review = (overrides) => ({
    id: 1,
    user: { login: "owner" },
    state: "COMMENTED",
    body: "",
    commit_id: R1,
    submitted_at: "2026-01-01T09:00:00Z",
    ...overrides,
  });
  const find = (reviews, reviewComments = []) =>
    reviewedCommit({
      reviews,
      reviewComments,
      labeller: "owner",
      labelledAt: "2026-01-01T10:00:00Z",
    });

  it("is the commit of the labeller's latest review before the label", () => {
    expect(find([review({ state: "APPROVED" })])).toBe(R1);
    expect(
      find([
        review({ state: "CHANGES_REQUESTED" }),
        review({ id: 2, state: "APPROVED", commit_id: R2, submitted_at: "2026-01-01T09:30:00Z" }),
      ]),
    ).toBe(R2);
    expect(find([review({ state: "APPROVED", submitted_at: "2026-01-01T10:00:00Z" })])).toBe(R1);
  });

  it("counts a comment review with a body or its own inline comments, not a reply", () => {
    expect(find([review({ body: "Two small things." })])).toBe(R1);
    expect(find([review({ id: 5 })], [{ pull_request_review_id: 5 }])).toBe(R1);
    expect(find([review({ id: 5 })], [{ pull_request_review_id: 5, in_reply_to_id: 3 }])).toBe(
      undefined,
    );
    expect(find([review()])).toBeUndefined();
  });

  it("ignores reviews made after the label, by others, pending or dismissed", () => {
    const approved = { state: "APPROVED" };
    expect(find([review({ ...approved, submitted_at: "2026-01-01T10:00:01Z" })])).toBeUndefined();
    expect(find([review({ ...approved, user: { login: "contributor" } })])).toBeUndefined();
    expect(find([review({ state: "PENDING", submitted_at: undefined })])).toBeUndefined();
    expect(find([review({ state: "DISMISSED" })])).toBeUndefined();
    expect(find([review({ ...approved, commit_id: null })])).toBeUndefined();
    // A later review does not replace the one the label was added for.
    expect(
      find([
        review(approved),
        review({ ...approved, commit_id: R2, submitted_at: "2026-01-01T11:00:00Z" }),
      ]),
    ).toBe(R1);
  });
});

describe("classifyTrees", () => {
  const entry = (content, mode = "100644") => ({ sha: gitBlobSha(Buffer.from(content)), mode });
  const reviewed = new Map([
    ["a.txt", entry("a\n")],
    ["b.txt", entry("b\n")],
  ]);
  const expected = new Map([
    ["a.txt", { full: entry("A\n").sha, partial: new Set([entry("half\n").sha]) }],
  ]);

  it("is ready when exactly the suggested content is there", () => {
    const head = new Map([...reviewed, ["a.txt", entry("A\n")]]);
    expect(classifyTrees(reviewed, head, expected)).toEqual({ state: "ready" });
    expect(classifyTrees(reviewed, new Map(reviewed), new Map())).toEqual({ state: "ready" });
  });

  it("is partial while suggestions are still missing", () => {
    expect(classifyTrees(reviewed, new Map(reviewed), expected)).toEqual({ state: "partial" });
    const head = new Map([...reviewed, ["a.txt", entry("half\n")]]);
    expect(classifyTrees(reviewed, head, expected)).toEqual({ state: "partial" });
  });

  it.each([
    ["another file changed", [["b.txt", entry("evil\n")]], ["b.txt"]],
    ["a file was added", [["c.txt", entry("new\n")]], ["c.txt"]],
    ["the suggested file has other content", [["a.txt", entry("A\nextra\n")]], ["a.txt"]],
    ["the suggested file became executable", [["a.txt", entry("A\n", "100755")]], ["a.txt"]],
  ])("is a violation when %s", (_name, changes, paths) => {
    const head = new Map([...reviewed, ["a.txt", entry("A\n")], ...changes]);
    expect(classifyTrees(reviewed, head, expected)).toEqual({ state: "violation", paths });
  });

  it("is a violation when a file was deleted", () => {
    const head = new Map([["a.txt", entry("A\n")]]);
    expect(classifyTrees(reviewed, head, expected)).toEqual({
      state: "violation",
      paths: ["b.txt"],
    });
  });
});

describe("run", () => {
  const TITLE = "fix(core): a thing";

  /**
   * A fake repository "o/r" with pull request #7. "owner" reviewed the first commit at
   * 09:00 and added the label at 10:00.
   */
  function world({ reviewedFiles, headFiles = reviewedFiles } = {}) {
    const trees = new Map();
    const blobs = new Map();
    const commit = (files) => {
      const entries = Object.entries(files).map(([path, content]) => {
        const sha = gitBlobSha(Buffer.from(content));
        blobs.set(sha, content);
        return { path, sha, mode: "100644", type: "blob" };
      });
      const sha = createHash("sha1").update(JSON.stringify(entries)).digest("hex");
      trees.set(sha, entries);
      return sha;
    };
    const reviewed = commit(reviewedFiles ?? { "a.txt": "a\nb\nc\n", "b.txt": "b\n" });
    const head = commit(headFiles ?? { "a.txt": "a\nb\nc\n", "b.txt": "b\n" });
    const ciRun = (path, id) => ({
      id,
      path,
      event: "pull_request",
      head_sha: head,
      run_number: id,
      status: "completed",
      conclusion: "success",
    });
    const state = {
      reviewed,
      head,
      pr: {
        number: 7,
        state: "open",
        merged: false,
        draft: false,
        mergeable: true,
        title: TITLE,
        updated_at: "2026-01-01T10:00:00Z",
        labels: [{ name: LABEL }],
        base: { ref: "main" },
        head: { sha: head },
      },
      events: [
        {
          event: "labeled",
          label: { name: LABEL },
          actor: { login: "owner" },
          created_at: "2026-01-01T10:00:00Z",
        },
      ],
      reviews: [
        {
          id: 100,
          user: { login: "owner" },
          state: "APPROVED",
          body: "",
          commit_id: reviewed,
          submitted_at: "2026-01-01T09:00:00Z",
        },
      ],
      comments: [],
      reviewComments: [],
      permissions: { owner: "admin", helper: "write", contributor: "read" },
      runs: [ciRun(REQUIRED_WORKFLOWS[0], 11), ciRun(REQUIRED_WORKFLOWS[1], 12)],
      checkRuns: [],
      status: { total_count: 0, state: "pending" },
      mergeError: undefined,
      linkedIssues: [],
      linkedError: undefined,
      graphqlVariables: [],
      closedIssues: [],
      posted: [],
      merges: [],
      dispatched: [],
      removedLabel: false,
      log: [],
    };
    const fail = (status) => Object.assign(new Error(`HTTP ${status}`), { status });
    state.api = async (method, fullPath, body) => {
      const path = fullPath.split("?")[0].replace("/repos/o/r", "");
      const route = `${method} ${path}`;
      if (route === "GET /pulls/7") return state.pr;
      if (route === "GET /issues/7/events") return state.events;
      if (route === "GET /pulls/7/reviews") return state.reviews;
      if (route === "GET /pulls/7/comments") return state.reviewComments;
      if (route === "GET /issues") return [{ number: 3 }, { number: 7, pull_request: {} }];
      if (route === "GET /actions/runs") return { workflow_runs: state.runs };
      if (route === `GET /commits/${state.pr.head.sha}/check-runs`) {
        return { check_runs: state.checkRuns };
      }
      if (route === `GET /commits/${state.pr.head.sha}/status`) return state.status;
      if (route === "POST /issues/7/comments") {
        state.posted.push(body.body);
        return {};
      }
      if (route === `DELETE /issues/7/labels/${LABEL}`) {
        if (state.removedLabel) throw fail(404);
        state.removedLabel = true;
        return [];
      }
      if (route === "PUT /pulls/7/merge") {
        if (state.mergeError) throw fail(state.mergeError);
        state.merges.push(body);
        state.pr = { ...state.pr, merged: true, state: "closed" };
        return { merged: true };
      }
      if (route === "POST /graphql") {
        if (state.linkedError) throw fail(state.linkedError);
        state.graphqlVariables.push(body.variables);
        return {
          data: {
            repository: { pullRequest: { closingIssuesReferences: { nodes: state.linkedIssues } } },
          },
        };
      }
      const closed = /^PATCH \/issues\/(\d+)$/.exec(route)?.[1];
      if (closed) {
        state.closedIssues.push([Number(closed), body]);
        return {};
      }
      const permission = /^GET \/collaborators\/([^/]+)\/permission$/.exec(route)?.[1];
      if (permission) {
        if (!state.permissions[permission]) throw fail(404);
        return { permission: state.permissions[permission] };
      }
      const treeSha = /^GET \/git\/trees\/([0-9a-f]{40})$/.exec(route)?.[1];
      if (treeSha && trees.has(treeSha)) return { truncated: false, tree: trees.get(treeSha) };
      const blobSha = /^GET \/git\/blobs\/([0-9a-f]{40})$/.exec(route)?.[1];
      if (blobSha && blobs.has(blobSha)) {
        return { content: Buffer.from(blobs.get(blobSha)).toString("base64") };
      }
      const workflow = /^POST \/actions\/workflows\/([^/]+)\/dispatches$/.exec(route)?.[1];
      if (workflow) {
        state.dispatched.push([workflow, body.ref]);
        return undefined;
      }
      // Issue comments must never be read: anyone can get a bot to post one.
      throw new Error(`unexpected API call: ${route}`);
    };
    state.event = (action = "synchronize", extra = {}) => ({
      eventName: "pull_request_target",
      event: {
        action,
        repository: { full_name: "o/r", default_branch: "main" },
        pull_request: state.pr,
        ...extra,
      },
    });
    state.labeled = (sender = "owner", name = LABEL) =>
      state.event("labeled", { label: { name }, sender: { login: sender } });
    state.go = (input = state.event()) => run(input, state.api, (line) => state.log.push(line));
    return state;
  }

  const suggestion = (state, overrides = {}) => ({
    user: { login: "owner" },
    pull_request_review_id: 100,
    original_commit_id: state.reviewed,
    path: "a.txt",
    original_line: 2,
    original_start_line: null,
    side: "RIGHT",
    body: "```suggestion\nB\n```",
    ...overrides,
  });

  const expectWaiting = (state) => {
    expect(state.merges).toEqual([]);
    expect(state.removedLabel).toBe(false);
  };
  const expectLabelOff = (state, reason) => {
    expect(state.merges).toEqual([]);
    expect(state.removedLabel).toBe(true);
    expect(state.posted).toHaveLength(1);
    expect(state.posted[0]).toContain("**Automerge is off:**");
    expect(state.posted[0]).toContain(reason);
  };

  describe("when the label is added", () => {
    it("says what happens next and waits for the suggestions", async () => {
      const state = world();
      state.reviewComments = [suggestion(state)];
      state.events = []; // the events list can lag behind the event itself
      await state.go(state.labeled());
      expectWaiting(state);
      expect(state.posted).toHaveLength(1);
      expect(state.posted[0]).toContain(`for the review at \`${state.reviewed.slice(0, 7)}\``);
      expect(state.posted[0]).toContain("plus the 1 suggested change from maintainers");
    });

    it("merges at once when there is nothing to wait for", async () => {
      const state = world();
      await state.go(state.labeled());
      expect(state.merges).toHaveLength(1);
      expect(state.posted).toEqual([]);
    });

    it("takes the label off when someone who cannot merge added it", async () => {
      const state = world();
      state.events[0].actor.login = "contributor";
      await state.go(state.labeled("contributor"));
      expectLabelOff(state, "only people who can merge here may add the label");
    });

    it("takes the label off when the labeller has not reviewed before adding it", async () => {
      const none = world();
      none.reviews = [];
      await none.go(none.labeled());
      expectLabelOff(none, "Submit your review first");

      const late = world();
      late.reviews[0].submitted_at = "2026-01-01T10:05:00Z";
      await late.go();
      expectLabelOff(late, "Submit your review first");

      const someoneElse = world();
      someoneElse.reviews[0].user.login = "helper";
      await someoneElse.go();
      expectLabelOff(someoneElse, "Submit your review first");
    });

    it("takes the label off when the head moved between the review and the label", async () => {
      const state = world({
        reviewedFiles: { "a.txt": "a\nb\nc\n" },
        headFiles: { "a.txt": "a\nb\nc\n", "new.js": "x\n" },
      });
      await state.go(state.labeled());
      expectLabelOff(state, '"new.js"');
    });

    it("ignores other labels on a pull request without the automerge label", async () => {
      const state = world();
      state.pr.labels = [{ name: "bug" }];
      await state.go(state.labeled("owner", "bug"));
      expectWaiting(state);
      expect(state.posted).toEqual([]);
    });
  });

  describe("merging", () => {
    it("merges the reviewed commit itself once CI is green, with its own commit message", async () => {
      const state = world();
      await state.go();
      expect(state.merges).toEqual([
        {
          sha: state.head,
          merge_method: "squash",
          commit_title: `${TITLE} (#7)`,
          commit_message: `Merged by the automerge label: reviewed at ${state.reviewed} by owner. CI passed on ${state.head}.`,
        },
      ]);
      expect(state.dispatched).toEqual(FOLLOW_UP_WORKFLOWS.map((file) => [file, "main"]));
      expect(state.removedLabel).toBe(false);
      expect(state.posted).toEqual([]);
    });

    it("merges when the head is the reviewed commit plus every suggestion", async () => {
      const state = world({
        reviewedFiles: { "a.txt": "a\nb\nc\n", "b.txt": "b\n" },
        headFiles: { "a.txt": "a\nB\nC\nd\n", "b.txt": "b\n" },
      });
      state.reviewComments = [
        suggestion(state),
        suggestion(state, {
          user: { login: "helper" },
          original_line: 3,
          body: "Add a line.\r\n```suggestion\r\nC\r\nd\r\n```",
        }),
      ];
      await state.go();
      expect(state.merges).toHaveLength(1);
      expect(state.merges[0].commit_message).toContain("plus 2 suggested changes from the review");
    });

    it("waits while a suggestion is not committed yet", async () => {
      const state = world({
        reviewedFiles: { "a.txt": "a\nb\nc\n" },
        headFiles: { "a.txt": "a\nB\nc\n" },
      });
      state.reviewComments = [suggestion(state), suggestion(state, { original_line: 3 })];
      await state.go();
      expectWaiting(state);
      expect(state.posted).toEqual([]);
      expect(state.log.join("\n")).toContain("not every suggestion is committed yet");
    });

    it("closes the open issues of this repository that the merged pull request closes", async () => {
      const state = world();
      const linked = (number, issueState, repository = "o/r") => ({
        number,
        state: issueState,
        repository: { nameWithOwner: repository },
      });
      state.linkedIssues = [
        linked(25, "OPEN"),
        linked(26, "CLOSED"),
        linked(27, "OPEN", "someone/else"),
        linked(28, "OPEN", "O/R"),
      ];
      await state.go();
      expect(state.merges).toHaveLength(1);
      expect(state.graphqlVariables).toEqual([{ owner: "o", name: "r", number: 7 }]);
      const completed = { state: "closed", state_reason: "completed" };
      expect(state.closedIssues).toEqual([
        [25, completed],
        [28, completed],
      ]);
    });

    it("closes no issue when nothing was merged, and only logs when closing fails", async () => {
      const waiting = world();
      waiting.linkedIssues = [{ number: 25, state: "OPEN", repository: { nameWithOwner: "o/r" } }];
      waiting.runs.pop();
      await waiting.go();
      expect(waiting.merges).toEqual([]);
      expect(waiting.closedIssues).toEqual([]);

      const failing = world();
      failing.linkedError = 502;
      await failing.go();
      expect(failing.merges).toHaveLength(1);
      expect(failing.dispatched).toHaveLength(FOLLOW_UP_WORKFLOWS.length);
      expect(failing.log.join("\n")).toContain("#7: could not close its linked issues");
    });

    it("re-checks every labelled pull request when a CI run finishes", async () => {
      const state = world();
      await state.go({
        eventName: "workflow_run",
        event: { repository: { full_name: "o/r", default_branch: "main" }, workflow_run: {} },
      });
      expect(state.merges).toHaveLength(1);
    });
  });

  describe("anything else takes the label off", () => {
    it("another file changed besides the suggestion", async () => {
      const state = world({
        reviewedFiles: { "a.txt": "a\nb\nc\n", "b.txt": "b\n" },
        headFiles: { "a.txt": "a\nB\nc\n", "b.txt": "b\n", "evil`.js": "x\n" },
      });
      state.reviewComments = [suggestion(state)];
      await state.go();
      // The path is untrusted: quoted, inside a fence it cannot close.
      expectLabelOff(state, '```text\n"evil`.js"\n```');
    });

    it("the suggested lines got other content than suggested", async () => {
      const state = world({
        reviewedFiles: { "a.txt": "a\nb\nc\n" },
        headFiles: { "a.txt": "a\nB; require('child_process')\nc\n" },
      });
      state.reviewComments = [suggestion(state)];
      await state.go();
      expectLabelOff(state, '"a.txt"');
    });

    it("a suggestion from someone who cannot merge was committed", async () => {
      const state = world({
        reviewedFiles: { "a.txt": "a\nb\nc\n" },
        headFiles: { "a.txt": "a\nB\nc\n" },
      });
      state.reviewComments = [suggestion(state, { user: { login: "contributor" } })];
      await state.go();
      expectLabelOff(state, '"a.txt"');
    });

    it("a suggestion made on another commit was committed", async () => {
      const state = world({
        reviewedFiles: { "a.txt": "a\nb\nc\n" },
        headFiles: { "a.txt": "a\nB\nc\n" },
      });
      state.reviewComments = [suggestion(state, { original_commit_id: "f".repeat(40) })];
      await state.go();
      expectLabelOff(state, '"a.txt"');
    });

    it("the title was changed after the label was added", async () => {
      const state = world();
      state.pr.title = `${TITLE} [skip ci]`;
      state.events.push({ event: "renamed", created_at: "2026-01-01T10:30:00Z" });
      await state.go();
      expectLabelOff(state, "title was changed after the label was added");
    });

    it.each([
      ["the base branch changed", (state) => (state.pr.base.ref = "other"), "default branch"],
      ["there are conflicts", (state) => (state.pr.mergeable = false), "conflicts with the base"],
      [
        "the labeller lost access",
        (state) => (state.permissions.owner = "read"),
        "only people who can merge here",
      ],
    ])("%s", async (_name, change, reason) => {
      const state = world();
      change(state);
      await state.go();
      expectLabelOff(state, reason);
    });

    it("a maintainer's comment has two suggestion blocks or overlapping suggestions", async () => {
      const two = world();
      two.reviewComments = [
        suggestion(two, { body: "```suggestion\nx\n```\n```suggestion\ny\n```" }),
      ];
      await two.go();
      expectLabelOff(two, "more than one");

      const overlapping = world();
      overlapping.reviewComments = [suggestion(overlapping), suggestion(overlapping)];
      await overlapping.go();
      expectLabelOff(overlapping, "two suggestions cover the same lines");
    });

    it("says nothing twice when the label is already gone", async () => {
      const state = world();
      state.pr.base.ref = "other";
      state.removedLabel = true;
      await state.go();
      expect(state.posted).toEqual([]);
    });
  });

  describe("waiting, without merging or taking the label off", () => {
    it("a rename from before the label, a draft, or no label at all", async () => {
      const renamedBefore = world();
      renamedBefore.events.unshift({ event: "renamed", created_at: "2026-01-01T09:30:00Z" });
      await renamedBefore.go();
      expect(renamedBefore.merges).toHaveLength(1);

      const draft = world();
      draft.pr.draft = true;
      await draft.go();
      expectWaiting(draft);
      expect(draft.posted).toEqual([]);

      const unlabelled = world();
      unlabelled.pr.labels = [];
      await unlabelled.go();
      expectWaiting(unlabelled);
    });

    it.each([
      ["a required workflow has no run", (state) => state.runs.pop()],
      ["a required workflow failed", (state) => (state.runs[0].conclusion = "failure")],
      ["a required workflow is still running", (state) => (state.runs[1].status = "in_progress")],
      [
        "a required workflow awaits approval",
        (state) => (state.runs[1].conclusion = "action_required"),
      ],
      [
        "the passing run is for another commit",
        (state) => (state.runs[0].head_sha = "e".repeat(40)),
      ],
      [
        "the passing run is not a pull_request run",
        (state) => (state.runs[0].event = "workflow_dispatch"),
      ],
      [
        "an app's check failed",
        (state) =>
          state.checkRuns.push({
            app: { slug: "scanner" },
            status: "completed",
            conclusion: "failure",
          }),
      ],
      [
        "another pull_request workflow is still running",
        (state) => {
          state.runs.push({
            id: 13,
            path: ".github/workflows/pages.yml",
            event: "pull_request",
            head_sha: state.head,
            run_number: 13,
            status: "in_progress",
          });
          state.checkRuns.push({
            app: { slug: "github-actions" },
            details_url: "https://github.com/o/r/actions/runs/13/job/5",
            status: "in_progress",
            conclusion: null,
          });
        },
      ],
      ["a commit status failed", (state) => (state.status = { total_count: 1, state: "failure" })],
    ])("CI is not green: %s", async (_name, change) => {
      const state = world();
      change(state);
      await state.go();
      expectWaiting(state);
      expect(state.posted).toEqual([]);
    });
  });

  it("judges CI by the newest run of each workflow on the head commit", async () => {
    // A pull request that was closed and reopened has two runs on the same commit.
    const older = (state, overrides) => {
      state.runs.unshift({ ...state.runs[0], id: 5, run_number: 5, ...overrides });
      state.checkRuns.push({
        app: { slug: "github-actions" },
        details_url: "https://github.com/o/r/actions/runs/5/job/1",
        status: "completed",
        conclusion: overrides.conclusion,
      });
    };
    const fixed = world();
    older(fixed, { conclusion: "failure" });
    await fixed.go();
    expect(fixed.merges).toHaveLength(1);

    const broken = world();
    older(broken, { conclusion: "success" });
    broken.runs.find((candidate) => candidate.id === 11).conclusion = "failure";
    await broken.go();
    expect(broken.merges).toEqual([]);
  });

  it("ignores check runs of the repository's own automation", async () => {
    const state = world();
    state.checkRuns.push({
      app: { slug: "github-actions" },
      details_url: "https://github.com/o/r/actions/runs/999/job/1",
      status: "in_progress",
      conclusion: null,
    });
    await state.go();
    expect(state.merges).toHaveLength(1);
  });

  it("takes the label off when GitHub refuses the merge, unless it is merged already", async () => {
    const refused = world();
    refused.mergeError = 405;
    await refused.go();
    expectLabelOff(refused, "GitHub refused the merge (HTTP 405)");

    const raced = world();
    raced.mergeError = 405;
    const api = raced.api;
    let reads = 0;
    raced.api = async (method, path, body) => {
      const result = await api(method, path, body);
      if (method === "GET" && path === "/repos/o/r/pulls/7" && ++reads > 1) {
        return { ...result, merged: true };
      }
      return result;
    };
    await raced.go();
    expect(raced.removedLabel).toBe(false);
    expect(raced.posted).toEqual([]);
  });
});

describe("automerge.yml", () => {
  const dir = new URL("../workflows/", import.meta.url);
  const read = (file) => readFileSync(new URL(file, dir), "utf8");
  const workflow = read("automerge.yml");
  const hasTrigger = (source, trigger) => new RegExp(`^ {2}${trigger}:`, "m").test(source);
  /** A GitHub Actions expression, written so that it is not a JavaScript template placeholder. */
  const expression = (inner) => ["$", "{{ ", inner, " }}"].join("");

  it("is re-run by every workflow that runs on pull requests", () => {
    const listed = JSON.parse(/^ {4}workflows: (\[.*\])$/m.exec(workflow)?.[1] ?? "[]");
    const onPullRequests = readdirSync(dir)
      .map((file) => read(file))
      .filter((source) => hasTrigger(source, "pull_request"))
      .map((source) => /^name: (.+)$/m.exec(source)?.[1]);
    expect(onPullRequests.length).toBeGreaterThan(1);
    expect([...listed].sort()).toEqual([...onPullRequests].sort());
  });

  it("requires workflows that run on every pull request, and starts ones that can be started", () => {
    for (const path of REQUIRED_WORKFLOWS) {
      const source = read(path.replace(".github/workflows/", ""));
      // "pull_request:" with nothing under it: no path filter that could skip the run.
      expect(source, path).toMatch(/^ {2}pull_request:[ \t]*\n(?! {4})/m);
    }
    for (const file of FOLLOW_UP_WORKFLOWS) {
      expect(hasTrigger(read(file), "workflow_dispatch"), file).toBe(true);
    }
  });

  it("never checks out or names the pull request's code", () => {
    const code = workflow
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
    expect(code).toContain(`ref: ${expression("github.event.repository.default_branch")}`);
    expect(code).toContain("sparse-checkout: .github/scripts");
    expect(code).toContain("persist-credentials: false");
    expect(code).not.toMatch(/pull_request\.head|head_ref|head\.sha|head\.ref|refs\/pull/);
    expect(code.match(/\$\{\{[^}]*\}\}/g)).toEqual([
      expression("github.event.repository.default_branch"),
      expression("github.token"),
    ]);
  });
});
