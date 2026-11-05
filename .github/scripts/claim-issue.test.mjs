import { describe, expect, it, vi } from "vitest";
import { decide, parseIntent, run } from "./claim-issue.mjs";

describe("parseIntent", () => {
  it.each([
    "/assign",
    "/take",
    ".take",
    "/assign me",
    "Hi! I'd like to work on this.",
    "I would like to work on this issue",
    "Can I work on this?",
    "could i pick this up",
    "I want to fix this, is that ok?",
    "I'm happy to take this one",
    "Please assign this to me.",
    "assign me please",
    "Let me tackle this",
  ])("reads %j as a claim", (body) => {
    expect(parseIntent(body)).toBe("claim");
  });

  it.each(["/unassign", "Please unassign me, I'm busy", "I'm no longer working on this"])(
    "reads %j as a release",
    (body) => {
      expect(parseIntent(body)).toBe("release");
    },
  );

  it.each([
    "",
    "Thanks, nice issue!",
    "I'll take a look at the logs later",
    "Can I do this with npm 10?",
    "I don't want to work on this one",
    "I can't fix this, sorry",
    "Is anyone working on this?",
    "> /assign\nquoting the bot above",
    "```\n/assign\n```",
    "Someone said they want to work on it",
  ])("ignores %j", (body) => {
    expect(parseIntent(body)).toBeUndefined();
  });
});

describe("decide", () => {
  const base = { login: "alice", assignees: [], repository: "o/r" };

  it("assigns an unassigned issue and explains what happens next", () => {
    const result = decide({ ...base, intent: "claim" });
    expect(result.action).toBe("assign");
    expect(result.reply).toContain("Assigned to @alice");
    expect(result.reply).toContain("https://github.com/o/r/blob/main/CONTRIBUTING.md");
  });

  it("does not take an issue away from its assignee", () => {
    const result = decide({ ...base, intent: "claim", assignees: ["bob"] });
    expect(result.action).toBe("none");
    expect(result.reply).toContain("already assigned to @bob");
  });

  it("says nothing when the commenter already has the issue", () => {
    expect(decide({ ...base, intent: "claim", assignees: ["alice"] })).toEqual({
      action: "none",
    });
  });

  it("releases only the commenter's own assignment", () => {
    expect(decide({ ...base, intent: "release", assignees: ["alice"] }).action).toBe("unassign");
    expect(decide({ ...base, intent: "release", assignees: ["bob"] })).toEqual({
      action: "none",
    });
  });
});

describe("run", () => {
  const event = (overrides = {}, issue = {}) => ({
    repository: { full_name: "o/r" },
    issue: { number: 7, state: "open", assignees: [], ...issue },
    comment: {
      body: "Can I work on this?",
      user: { login: "alice", type: "User" },
      author_association: "NONE",
      ...overrides,
    },
  });

  function fakeApi({ accepted = true } = {}) {
    return vi.fn(async (method, path, body) => {
      if (method === "POST" && path.endsWith("/assignees")) {
        return { assignees: accepted ? body.assignees.map((login) => ({ login })) : [] };
      }
      return {};
    });
  }
  const quiet = () => {};

  it("assigns and comments on a claim", async () => {
    const api = fakeApi();
    await run(event(), api, quiet);
    expect(api).toHaveBeenCalledWith("POST", "/issues/7/assignees", { assignees: ["alice"] });
    expect(api).toHaveBeenLastCalledWith("POST", "/issues/7/comments", {
      body: expect.stringContaining("Assigned to @alice"),
    });
  });

  it("says so when GitHub silently refuses the assignment", async () => {
    const api = fakeApi({ accepted: false });
    await run(event(), api, quiet);
    expect(api).toHaveBeenLastCalledWith("POST", "/issues/7/comments", {
      body: expect.stringContaining("did not accept the assignment"),
    });
  });

  it("unassigns on /unassign", async () => {
    const api = fakeApi();
    await run(event({ body: "/unassign" }, { assignees: [{ login: "alice" }] }), api, quiet);
    expect(api).toHaveBeenCalledWith("DELETE", "/issues/7/assignees", { assignees: ["alice"] });
  });

  it.each([
    ["a pull request", event({}, { pull_request: {} })],
    ["a closed issue", event({}, { state: "closed" })],
    ["a bot", event({ user: { login: "x[bot]", type: "Bot" } })],
    ["the owner", event({ author_association: "OWNER" })],
    ["an unrelated comment", event({ body: "Thanks!" })],
  ])("does nothing for %s", async (_label, input) => {
    const api = fakeApi();
    await run(input, api, quiet);
    expect(api).not.toHaveBeenCalled();
  });

  it("never quotes the comment back", async () => {
    const api = fakeApi();
    await run(
      event({ body: "Can I work on this? <img src=x onerror=alert(1)> @everyone" }),
      api,
      quiet,
    );
    const replies = api.mock.calls.filter(([, path]) => path.endsWith("/comments"));
    expect(JSON.stringify(replies)).not.toContain("onerror");
    expect(JSON.stringify(replies)).not.toContain("@everyone");
  });
});
