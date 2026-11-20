// Builds the releaseproof website into website/dist: the Markdown in docs/, the root README,
// CONTRIBUTING and SECURITY, and the CLI changelog, styled like an old printed manual.
//
// The Markdown stays the single source. Nothing here repeats what the docs say, so the tests
// that keep docs/ in sync with the code keep the site in sync too. Pages ship no JavaScript
// and load nothing from other hosts (see CONTENT_SECURITY_POLICY), and the build fails on a
// link or anchor that points nowhere.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Marked } from "marked";

export const REPOSITORY = "https://github.com/ujjwalv01/releaseproof";
export const SPONSOR_URL = "https://github.com/sponsors/ujjwalv01";
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "..");

/**
 * Every page of the site, in menu order. `source` is relative to the repository root. A new
 * Markdown file in docs/ must be added here; a test fails until it is.
 */
export const PAGES = [
  { source: "README.md", output: "index.html", label: "Home" },
  { source: "docs/faq.md", output: "faq.html", label: "FAQ" },
  { source: "docs/rules.md", output: "rules.html", label: "Rules" },
  { source: "docs/json-report.md", output: "json-report.html", label: "JSON report" },
  {
    source: "docs/real-world-results.md",
    output: "real-world-results.html",
    label: "Results",
  },
  { source: "docs/design-rebuild.md", output: "design-rebuild.html", label: "Design: rebuild" },
  { source: "docs/design-action.md", output: "design-action.html", label: "Design: Action" },
  { source: "docs/spike-npm.md", output: "spike-npm.html", label: "npm notes" },
  { source: "CONTRIBUTING.md", output: "contributing.html", label: "Contributing" },
  { source: "SECURITY.md", output: "security.html", label: "Security" },
  { source: "packages/cli/CHANGELOG.md", output: "changelog.html", label: "What's new" },
];

/** No scripts, no other hosts, no forms: the pages are documents and nothing else. */
export const CONTENT_SECURITY_POLICY =
  "default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'";

const ABSOLUTE_URL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;
const RULE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * The anchor GitHub gives a heading, so links written for GitHub work on the site as well.
 * Same rule as headingSlugs() in packages/core/src/docs-links.test.ts.
 */
export function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

function uniqueSlugger() {
  const seen = new Set();
  return (text) => {
    const base = slugify(text);
    let slug = base;
    for (let suffix = 1; seen.has(slug); suffix++) {
      slug = `${base}-${suffix}`;
    }
    seen.add(slug);
    return slug;
  };
}

const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };

/** The text a reader sees in inline tokens: code spans and link texts included, HTML dropped. */
function plainText(tokens) {
  return tokens
    .map((token) => {
      if (token.type === "html") {
        return "";
      }
      if (Array.isArray(token.tokens)) {
        return plainText(token.tokens);
      }
      return typeof token.text === "string" ? token.text : "";
    })
    .join("")
    .replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity]);
}

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function isDirectoryIn(root) {
  return (file) => {
    try {
      return statSync(path.join(root, file)).isDirectory();
    } catch {
      return false;
    }
  };
}

/**
 * Where a relative link in `source` (a repository-relative path) points on the site: the page
 * made from the target, or the file on GitHub when the site has no page for it. Absolute URLs
 * and in-page anchors are kept as they are.
 */
export function rewriteHref(href, source, { pages = PAGES, root = ROOT } = {}) {
  if (href === "" || href.startsWith("#") || ABSOLUTE_URL.test(href)) {
    return href;
  }
  const hashAt = href.indexOf("#");
  const rawPath = hashAt === -1 ? href : href.slice(0, hashAt);
  const hash = hashAt === -1 ? "" : href.slice(hashAt);
  const target = path.posix
    .normalize(
      path.posix.join(path.posix.dirname(source), decodeURIComponent(rawPath.split("?")[0])),
    )
    .replace(/\/+$/, "");
  if (target === ".." || target.startsWith("../")) {
    throw new Error(`${source}: the link ${href} points outside the repository`);
  }
  if (target === "." || target === "") {
    return `${REPOSITORY}${hash}`;
  }
  const page = pages.find((candidate) => candidate.source === target);
  if (page) {
    return `${page.output}${hash}`;
  }
  const kind = isDirectoryIn(root)(target) ? "tree" : "blob";
  return `${REPOSITORY}/${kind}/main/${target.split("/").map(encodeURIComponent).join("/")}${hash}`;
}

/**
 * Markdown to HTML with GitHub's heading anchors, links rewritten for the site, tables in a
 * scrolling wrapper with each cell labelled by its column, and an anchor on every rule id in a rule table ("Id" in the first header
 * cell), so `rules.html#dependency-added` points at its row.
 */
export function renderMarkdown(markdown, source, options = {}) {
  const slug = uniqueSlugger();
  const marked = new Marked({
    gfm: true,
    walkTokens(token) {
      if (token.type === "link") {
        token.href = rewriteHref(token.href, source, options);
      }
      if (token.type === "table") {
        // Each cell carries its column's heading: on phones a row is shown as a card, with
        // the heading in front of every value (see style.css).
        const labels = token.header.map((cell) => plainText(cell.tokens));
        for (const row of token.rows) {
          row.forEach((cell, column) => {
            cell.label = labels[column] ?? "";
          });
        }
      }
      if (token.type === "table" && plainText(token.header[0]?.tokens ?? []) === "Id") {
        for (const row of token.rows) {
          for (const cell of row[0]?.tokens ?? []) {
            if (cell.type === "codespan" && RULE_ID.test(cell.text)) {
              cell.ruleId = true;
            }
          }
        }
      }
    },
    renderer: {
      heading({ tokens, depth }) {
        const id = escapeHtml(slug(plainText(tokens)));
        return `<h${depth} id="${id}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
      },
      tablecell(token) {
        const tag = token.header ? "th" : "td";
        const align = token.align ? ` align="${token.align}"` : "";
        const label = token.header ? "" : ` data-label="${escapeHtml(token.label ?? "")}"`;
        return `<${tag}${align}${label}>${this.parser.parseInline(token.tokens)}</${tag}>\n`;
      },
      codespan(token) {
        // Rule ids match RULE_ID, so they need no escaping.
        return token.ruleId ? `<code id="${token.text}">${token.text}</code>` : false;
      },
    },
  });
  return marked
    .parse(markdown)
    .replaceAll("<table>", '<div class="table-wrap"><table>')
    .replaceAll("</table>", "</table></div>");
}

/** Puts `snippet` after the `<h2>` with this id, or at the top when the heading is gone. */
function afterHeading(html, id, snippet) {
  const heading = new RegExp(`<h2 id="${id}">[\\s\\S]*?</h2>\\n?`);
  return heading.test(html)
    ? html.replace(heading, (match) => `${match}${snippet}`)
    : `${snippet}${html}`;
}

const HOW_IT_WORKS = `<figure class="diagram">
<picture>
<source media="(min-width: 700px)" srcset="images/how-it-works-wide.svg" width="900" height="242">
<img src="images/how-it-works.svg" width="360" height="742" alt="How it works: 1. fetch the tarball and its attestations from the npm registry; 2. verify the provenance against the Sigstore trust root; 3. rebuild from the certified commit in Docker, with no network for the build step; 4. compare the release and the rebuild file by file; 5. graded rules decide: MATCHES SOURCE (exit code 0), DIFFERS FROM SOURCE (exit code 1) or COULD NOT VERIFY (exit code 2, never safe).">
</picture>
<figcaption>How a check works, step by step</figcaption>
</figure>
`;

// Hidden on narrow screens by the stylesheet: the text would be too small to read there,
// and the README shows the same report as text right below.
const TERMINAL = `<figure class="terminal">
<img src="images/terminal.svg" width="800" height="346" alt="A terminal running npx releaseproof check sigstore@5.0.0: provenance VERIFIED, rebuild OK, 9 files identical, verdict MATCHES SOURCE.">
<figcaption>A check of sigstore@5.0.0, with its progress lines</figcaption>
</figure>
`;

/** The home page gets the diagram and the terminal picture inside the README. */
function decorateHome(body) {
  return afterHeading(
    afterHeading(body, "what-releaseproof-does", HOW_IT_WORKS),
    "usage",
    TERMINAL,
  );
}

const PROJECT_LINKS = [
  [REPOSITORY, "Source code on GitHub"],
  ["https://www.npmjs.com/package/releaseproof", "releaseproof on npm"],
  ["https://github.com/marketplace/actions/releaseproof-check", "GitHub Action"],
  [`${REPOSITORY}/issues`, "Report a problem"],
];

const RELATED_LINKS = [
  ["https://www.sigstore.dev/", "Sigstore"],
  ["https://docs.npmjs.com/generating-provenance-statements", "npm provenance"],
  ["https://slsa.dev/", "SLSA"],
  ["https://openssf.org/", "OpenSSF"],
];

function link([href, text]) {
  return `<a href="${href}">${escapeHtml(text)}</a>`;
}

/** One page of the site: header, menu, the rendered Markdown and a sidebar of boxes. */
export function renderPage({ page, body, site }) {
  const isHome = page.output === "index.html";
  const title = isHome ? "releaseproof · Home" : `${page.label} · releaseproof`;
  const description = isHome
    ? "releaseproof verifies that an npm release matches its source: it rebuilds the package from the certified commit and compares the two, file by file."
    : `releaseproof documentation: ${page.label}`;
  const menu = site.pages
    .map((item) => {
      const current = item === page ? ' aria-current="page"' : "";
      return `<li><a href="${item.output}"${current}>${escapeHtml(item.label)}</a></li>`;
    })
    .join("\n");
  const built = site.commit
    ? ` · built from <a href="${REPOSITORY}/commit/${site.commit}">${site.commit.slice(0, 7)}</a>`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}">
<meta name="description" content="${escapeHtml(description)}">
<title>${escapeHtml(title)}</title>
<link rel="icon" href="images/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="style.css">
</head>
<body>
<a class="skip" href="#content">Skip to the content</a>
<div class="page">
<header class="masthead">
<a class="brand" href="index.html"><img src="images/favicon.svg" width="44" height="44" alt=""><span class="brand-name">releaseproof</span></a>
<p class="tagline">Verify that an npm release matches its source before you trust it</p>
</header>
<nav class="menu" aria-label="Site">
<ul>
${menu}
</ul>
</nav>
<div class="layout">
<main id="content" class="box content" tabindex="-1">
${body}
<p class="edit-link"><a href="${REPOSITORY}/edit/main/${page.source}">Edit this page on GitHub</a></p>
</main>
<aside class="sidebar" aria-label="About the project">
<section class="box">
<h2 class="caption">About</h2>
<ul>
<li>Version <a href="changelog.html">${escapeHtml(site.version)}</a></li>
<li><a href="rules.html">${site.ruleCount} rules</a> with graded severity</li>
<li>MIT licensed, no telemetry</li>
</ul>
</section>
<section class="box">
<h2 class="caption">Links</h2>
<ul>
${PROJECT_LINKS.map((item) => `<li>${link(item)}</li>`).join("\n")}
</ul>
</section>
<section class="box">
<h2 class="caption">Support the project</h2>
<p>releaseproof is free and open source. Sponsoring pays for the time spent on it.</p>
<p><a class="sponsor-button" href="${SPONSOR_URL}"><span aria-hidden="true">♥</span> Sponsor on GitHub</a></p>
</section>
</aside>
</div>
<footer class="site-footer">
<p>Related: ${RELATED_LINKS.map(link).join(" · ")}</p>
<p>releaseproof ${escapeHtml(site.version)} · MIT licensed${built}</p>
</footer>
</div>
</body>
</html>
`;
}

/**
 * Problems with the links of the built pages: a relative `href` or `src` whose file does not
 * exist, an anchor that no element on the target page has, or an id used twice on a page.
 * `pages` maps file names to HTML; `exists` says whether another file (CSS, images) exists.
 */
export function checkLinks(pages, exists) {
  const problems = [];
  const ids = new Map();
  for (const [file, html] of pages) {
    const found = [...html.matchAll(/\sid="([^"]*)"/g)].map((match) => match[1]);
    for (const id of new Set(found.filter((id, index) => found.indexOf(id) !== index))) {
      problems.push(`${file}: the id "${id}" is used more than once`);
    }
    ids.set(file, new Set(found));
  }
  for (const [file, html] of pages) {
    for (const [, attribute, value] of html.matchAll(/\s(href|src|srcset)="([^"]*)"/g)) {
      const url = value.replaceAll("&amp;", "&");
      if (ABSOLUTE_URL.test(url)) {
        continue;
      }
      const hashAt = url.indexOf("#");
      const target = (hashAt === -1 ? url : url.slice(0, hashAt)) || file;
      const anchor = hashAt === -1 ? "" : decodeURIComponent(url.slice(hashAt + 1));
      if (!pages.has(target) && !exists(target)) {
        problems.push(`${file}: ${attribute}="${value}" points to a missing file`);
      } else if (anchor && !ids.get(target)?.has(anchor)) {
        problems.push(`${file}: ${attribute}="${value}" points to a missing anchor`);
      }
    }
  }
  return problems;
}

function readVersion(root) {
  return JSON.parse(readFileSync(path.join(root, "packages/cli/package.json"), "utf8")).version;
}

/** The README states the rule count, and a core test keeps it equal to the rule sources. */
function readRuleCount(root) {
  const count = /^- (\d+) rules with graded severity/m.exec(
    readFileSync(path.join(root, "README.md"), "utf8"),
  )?.[1];
  if (!count) {
    throw new Error('README.md no longer says "- <n> rules with graded severity"');
  }
  return Number(count);
}

/** Builds every page into `outDir`. Throws, writing nothing more, when a link is broken. */
export function build({
  root = ROOT,
  outDir = path.join(HERE, "dist"),
  commit = process.env.GITHUB_SHA,
} = {}) {
  const site = {
    pages: PAGES,
    version: readVersion(root),
    ruleCount: readRuleCount(root),
    commit: /^[0-9a-f]{40}$/.test(commit ?? "") ? commit : undefined,
  };
  const html = new Map();
  for (const page of PAGES) {
    const markdown = readFileSync(path.join(root, page.source), "utf8");
    const rendered = renderMarkdown(markdown, page.source, { root });
    const body = page.output === "index.html" ? decorateHome(rendered) : rendered;
    html.set(page.output, renderPage({ page, body, site }));
  }
  const assets = ["style.css", ...readdirSync(path.join(HERE, "images")).map((f) => `images/${f}`)];
  const problems = checkLinks(html, (file) => assets.includes(file));
  if (problems.length > 0) {
    throw new Error(`The website has broken links:\n${problems.join("\n")}`);
  }

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(path.join(outDir, "images"), { recursive: true });
  for (const [file, contents] of html) {
    writeFileSync(path.join(outDir, file), contents);
  }
  for (const asset of assets) {
    copyFileSync(path.join(HERE, asset), path.join(outDir, asset));
  }
  return { outDir, pages: [...html.keys()] };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { outDir, pages } = build();
  if (!existsSync(path.join(outDir, "index.html"))) {
    throw new Error("index.html was not written");
  }
  console.log(`website: ${pages.length} pages in ${path.relative(process.cwd(), outDir) || "."}`);
}
