// Labels a pull request from the issues it closes, and marks first-time contributors.
// Run by .github/workflows/label-pr.yml on pull_request_target events.
//
// That event has a write token even for pull requests from forks, so this script must never
// read or run anything from the pull request itself: it uses the event's numbers and logins
// and the GitHub API only. Linked issues come from GitHub's own closingIssuesReferences
// (closing keywords such as "Closes #12" and issues linked in the sidebar), so the title and
// body are never parsed here.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const GOOD_FIRST_ISSUE = "good first issue";
export const GOOD_FIRST_PR = "good first pr";
export const FIRST_TIME_CONTRIBUTOR = "first-time contributor";

/** Labels this script may have to create, with how they look. */
export const OWN_LABELS = {
  [GOOD_FIRST_PR]: { color: "7057ff", description: "Pull request for a good first issue" },
  [FIRST_TIME_CONTRIBUTOR]: {
    color: "0e8a16",
    description: "The author has no merged pull request in this repository yet",
  },
};

/** Labels that describe an issue's state or audience, not the change; they stay on the issue. */
const NOT_COPIED = new Set([
  GOOD_FIRST_ISSUE,
  // A maintainer's decision about one pull request (see automerge.mjs); never inherited.
  "automerge",
  "help wanted",
  "question",
  "duplicate",
  "invalid",
  "wontfix",
]);

/**
 * The labels to add, from the facts only: the labels of the issues the pull request closes,
 * the labels it already has, and how many pull requests of its author were merged before
 * (undefined when that could not be determined, in which case no guess is made).
 */
export function decideLabels({ issueLabels, currentLabels, mergedCount, isBot }) {
  const wanted = new Set();
  for (const label of issueLabels) {
    if (label === GOOD_FIRST_ISSUE) {
      wanted.add(GOOD_FIRST_PR);
    } else if (!NOT_COPIED.has(label)) {
      wanted.add(label);
    }
  }
  if (!isBot && mergedCount === 0) {
    wanted.add(FIRST_TIME_CONTRIBUTOR);
  }
  const current = new Set(currentLabels);
  return [...wanted].filter((label) => !current.has(label)).sort();
}

const LINKED_ISSUES = `
query ($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      closingIssuesReferences(first: 20) {
        nodes {
          number
          repository { nameWithOwner }
          labels(first: 50) { nodes { name } }
        }
      }
    }
  }
}`;

function githubApi(token) {
  const root = process.env.GITHUB_API_URL ?? "https://api.github.com";
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "user-agent": "releaseproof-label-pr",
    "x-github-api-version": "2022-11-28",
  };
  const call = async (method, path, body) => {
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
  return {
    rest: call,
    async graphql(query, variables) {
      const result = await call("POST", "/graphql", { query, variables });
      if (result.errors?.length) {
        throw new Error(`GitHub GraphQL error: ${result.errors.map((e) => e.message).join("; ")}`);
      }
      return result.data;
    },
  };
}

/** Handles one pull_request_target event. `api` has `rest(method, path, body)` and `graphql`. */
export async function run(event, api, log = console.log) {
  const pr = event.pull_request;
  const repository = event.repository?.full_name ?? "";
  const [owner, name] = repository.split("/");
  if (!pr || !owner || !name) {
    return log("not a pull request event; nothing to do");
  }
  const login = pr.user?.login ?? "";
  const isBot = pr.user?.type === "Bot";

  const data = await api.graphql(LINKED_ISSUES, { owner, name, number: pr.number });
  const linked = (data?.repository?.pullRequest?.closingIssuesReferences?.nodes ?? []).filter(
    // Only this repository's issues: labels from elsewhere mean nothing here.
    (issue) => issue?.repository?.nameWithOwner?.toLowerCase() === repository.toLowerCase(),
  );
  const issueLabels = linked.flatMap((issue) => (issue.labels?.nodes ?? []).map((l) => l.name));

  let mergedCount;
  if (!isBot && login) {
    const query = `repo:${repository} is:pr is:merged author:${login}`;
    try {
      const result = await api.rest(
        "GET",
        `/search/issues?q=${encodeURIComponent(query)}&per_page=1`,
      );
      mergedCount = result?.total_count;
    } catch (error) {
      log(`could not count merged pull requests of ${login}: ${error.message}`);
    }
  }

  const currentLabels = (pr.labels ?? []).map((label) => label.name);
  const toAdd = decideLabels({ issueLabels, currentLabels, mergedCount, isBot });
  log(
    `#${pr.number} by ${login}: closes ${linked.map((i) => `#${i.number}`).join(", ") || "no issue"}; adding ${toAdd.join(", ") || "nothing"}`,
  );
  if (toAdd.length === 0) {
    return;
  }

  for (const label of toAdd) {
    const style = OWN_LABELS[label];
    if (!style) {
      continue;
    }
    try {
      await api.rest("POST", `/repos/${repository}/labels`, { name: label, ...style });
    } catch (error) {
      // 422: the label exists already, which is the usual case. Anything else only costs the
      // colour: adding a missing label to the pull request below creates it anyway.
      if (error.status !== 422) {
        log(`could not create label "${label}": ${error.message}`);
      }
    }
  }
  await api.rest("POST", `/repos/${repository}/issues/${pr.number}/labels`, { labels: toAdd });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  await run(event, githubApi(process.env.GITHUB_TOKEN));
}
