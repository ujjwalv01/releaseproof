import { describe, expect, it, vi } from "vitest";
import {
  decideLabels,
  FIRST_TIME_CONTRIBUTOR,
  GOOD_FIRST_PR,
  OWN_LABELS,
  run,
} from "./label-pr.mjs";

describe("decideLabels", () => {
  const base = { issueLabels: [], currentLabels: [], mergedCount: 3, isBot: false };

  it("copies the linked issue's labels and turns good first issue into good first pr", () => {
    expect(
      decideLabels({ ...base, issueLabels: ["good first issue", "bug", "cli", "test"] }),
    ).toEqual(["bug", "cli", GOOD_FIRST_PR, "test"]);
  });

  it("does not copy labels that only make sense on an issue", () => {
    expect(
      decideLabels({
        ...base,
        issueLabels: ["help wanted", "question", "duplicate", "invalid", "wontfix", "docs"],
      }),
    ).toEqual(["docs"]);
  });

  it("merges the labels of several issues without duplicates", () => {
    expect(
      decideLabels({ ...base, issueLabels: ["bug", "cli", "bug", "good first issue", "cli"] }),
    ).toEqual(["bug", "cli", GOOD_FIRST_PR]);
  });

  it("marks an author with no merged pull request as a first-time contributor", () => {
    expect(decideLabels({ ...base, mergedCount: 0 })).toEqual([FIRST_TIME_CONTRIBUTOR]);
    expect(decideLabels({ ...base, mergedCount: 1 })).toEqual([]);
  });

  it("never guesses when the merged count is unknown, and never labels bots", () => {
    expect(decideLabels({ ...base, mergedCount: undefined })).toEqual([]);
    expect(decideLabels({ ...base, mergedCount: 0, isBot: true })).toEqual([]);
  });

  it("skips labels the pull request already has", () => {
    expect(
      decideLabels({
        ...base,
        issueLabels: ["bug", "good first issue"],
        currentLabels: ["bug", GOOD_FIRST_PR],
        mergedCount: 0,
      }),
    ).toEqual([FIRST_TIME_CONTRIBUTOR]);
  });
});

describe("run", () => {
  const event = (pr = {}) => ({
    repository: { full_name: "o/r" },
    pull_request: {
      number: 9,
      user: { login: "alice", type: "User" },
      labels: [],
      title: "ignored",
      body: "Closes #999 — the body is never read by the script",
      ...pr,
    },
  });
  const issue = (number, labels, repo = "o/r") => ({
    number,
    repository: { nameWithOwner: repo },
    labels: { nodes: labels.map((name) => ({ name })) },
  });

  function fakeApi({ issues = [], merged = 2, searchFails = false, labelExists = true } = {}) {
    const graphql = vi.fn(async () => ({
      repository: { pullRequest: { closingIssuesReferences: { nodes: issues } } },
    }));
    const rest = vi.fn(async (method, path) => {
      if (method === "GET" && path.startsWith("/search/issues")) {
        if (searchFails) {
          throw Object.assign(new Error("HTTP 403"), { status: 403 });
        }
        return { total_count: merged };
      }
      if (method === "POST" && path === "/repos/o/r/labels" && labelExists) {
        throw Object.assign(new Error("HTTP 422"), { status: 422 });
      }
      return {};
    });
    return { graphql, rest };
  }
  const quiet = () => {};
  const added = (api) =>
    api.rest.mock.calls.find(([, path]) => path === "/repos/o/r/issues/9/labels")?.[2];

  it("labels a pull request from the issue it closes", async () => {
    const api = fakeApi({ issues: [issue(144, ["good first issue", "test", "rebuild"])] });
    await run(event(), api, quiet);
    expect(api.graphql).toHaveBeenCalledWith(expect.stringContaining("closingIssuesReferences"), {
      owner: "o",
      name: "r",
      number: 9,
    });
    expect(added(api)).toEqual({ labels: [GOOD_FIRST_PR, "rebuild", "test"] });
  });

  it("adds first-time contributor when the author has no merged pull request", async () => {
    const api = fakeApi({ merged: 0 });
    await run(event(), api, quiet);
    expect(api.rest).toHaveBeenCalledWith(
      "GET",
      `/search/issues?q=${encodeURIComponent("repo:o/r is:pr is:merged author:alice")}&per_page=1`,
    );
    expect(added(api)).toEqual({ labels: [FIRST_TIME_CONTRIBUTOR] });
  });

  it("creates its own labels when they are missing, with their colour and description", async () => {
    const api = fakeApi({
      issues: [issue(1, ["good first issue"])],
      merged: 0,
      labelExists: false,
    });
    await run(event(), api, quiet);
    expect(api.rest).toHaveBeenCalledWith("POST", "/repos/o/r/labels", {
      name: GOOD_FIRST_PR,
      ...OWN_LABELS[GOOD_FIRST_PR],
    });
    expect(api.rest).toHaveBeenCalledWith("POST", "/repos/o/r/labels", {
      name: FIRST_TIME_CONTRIBUTOR,
      ...OWN_LABELS[FIRST_TIME_CONTRIBUTOR],
    });
    expect(added(api)).toEqual({ labels: [FIRST_TIME_CONTRIBUTOR, GOOD_FIRST_PR] });
  });

  it("still adds the labels when it may not create them", async () => {
    const api = fakeApi({ issues: [issue(1, ["good first issue"])], labelExists: false });
    api.rest.mockImplementation(async (method, path) => {
      if (path === "/repos/o/r/labels") {
        throw Object.assign(new Error("HTTP 403"), { status: 403 });
      }
      return method === "GET" ? { total_count: 2 } : {};
    });
    const log = vi.fn();
    await run(event(), api, log);
    expect(added(api)).toEqual({ labels: [GOOD_FIRST_PR] });
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('could not create label "good first pr"'),
    );
  });

  it("ignores issues from other repositories", async () => {
    const api = fakeApi({ issues: [issue(5, ["bug"], "someone/else"), issue(6, ["docs"])] });
    await run(event(), api, quiet);
    expect(added(api)).toEqual({ labels: ["docs"] });
  });

  it("adds no first-time label when the search fails, but still copies issue labels", async () => {
    const api = fakeApi({ issues: [issue(3, ["bug"])], searchFails: true });
    await run(event(), api, quiet);
    expect(added(api)).toEqual({ labels: ["bug"] });
  });

  it("does not look up bots and makes no change when there is nothing to add", async () => {
    const api = fakeApi();
    await run(event({ user: { login: "dependabot[bot]", type: "Bot" } }), api, quiet);
    expect(api.rest).not.toHaveBeenCalled();
  });

  it("never removes labels and skips ones already present", async () => {
    const api = fakeApi({ issues: [issue(3, ["bug", "cli"])] });
    await run(event({ labels: [{ name: "bug" }, { name: "maintainer-added" }] }), api, quiet);
    expect(added(api)).toEqual({ labels: ["cli"] });
    expect(api.rest.mock.calls.some(([method]) => method === "DELETE")).toBe(false);
  });

  it("never reads the pull request's title or body", async () => {
    const api = fakeApi();
    const input = event();
    const pr = new Proxy(input.pull_request, {
      get(target, key) {
        if (key === "title" || key === "body") {
          throw new Error(`read ${String(key)}`);
        }
        return target[key];
      },
    });
    await expect(run({ ...input, pull_request: pr }, api, quiet)).resolves.toBeUndefined();
  });
});
