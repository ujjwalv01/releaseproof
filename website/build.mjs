// Builds the releaseproof website into website/dist: the Markdown in docs/, the root README,
// CONTRIBUTING and SECURITY, and the CLI changelog, framed as a 1990s home page.
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
    label: "Real-world results",
  },
  { source: "docs/design-rebuild.md", output: "design-rebuild.html", label: "Design: rebuild" },
  { source: "docs/design-action.md", output: "design-action.html", label: "Design: Action" },
  { source: "docs/spike-npm.md", output: "spike-npm.html", label: "Lab notes: npm" },
  { source: "CONTRIBUTING.md", output: "contributing.html", label: "Contributing" },
  { source: "SECURITY.md", output: "security.html", label: "Security" },
  {
    source: "packages/cli/CHANGELOG.md",
    output: "changelog.html",
    label: "What's new",
    fresh: true,
  },
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
 * scrolling wrapper, and an anchor on every rule id in a rule table ("Id" in the first header
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
<source media="(min-width: 900px)" srcset="images/how-it-works-wide.svg" width="840" height="290">
<img src="images/how-it-works.svg" width="380" height="768" alt="How it works: 1. fetch the tarball and its attestations from the npm registry; 2. verify the provenance against the Sigstore trust root; 3. rebuild from the certified commit in Docker, with no network for the build step; 4. compare the release and the rebuild file by file; 5. graded rules decide: MATCHES SOURCE (exit 0), DIFFERS FROM SOURCE (exit 1) or COULD NOT VERIFY (exit 2, never safe).">
</picture>
<figcaption>How a check works, step by step</figcaption>
</figure>
`;

const TERMINAL = `<figure class="terminal">
<img src="images/terminal.svg" width="800" height="400" alt="A terminal running npx releaseproof check sigstore@5.0.0: provenance VERIFIED, rebuild OK, 9 files identical, verdict MATCHES SOURCE.">
<figcaption>What a check looks like (the sigstore@5.0.0 example below)</figcaption>
</figure>
`;

/** The home page gets the banner, the diagram and the terminal around the README. */
function decorateHome(body) {
  const welcome = `<p class="construction"><img src="images/under-construction.svg" width="468" height="60" alt="Under construction: these pages grow with the project"></p>
<p class="welcome">Welcome to the releaseproof home page! <img src="images/new.svg" width="44" height="22" alt="New!"></p>
`;
  return (
    welcome +
    afterHeading(afterHeading(body, "what-releaseproof-does", HOW_IT_WORKS), "usage", TERMINAL)
  );
}

const BADGES = [
  ["badge-any-browser.svg", "Best viewed with any browser"],
  ["badge-no-telemetry.svg", "No telemetry"],
  ["badge-zero-js.svg", "This site uses 0 KB of JavaScript"],
  ["badge-fails-closed.svg", "Fails closed"],
  ["badge-deterministic.svg", "100% deterministic"],
  ["badge-mit.svg", "MIT licensed"],
];

const WEB_LINKS = [
  [REPOSITORY, "Source code on GitHub"],
  ["https://www.npmjs.com/package/releaseproof", "releaseproof on npm"],
  ["https://github.com/marketplace/actions/releaseproof-check", "GitHub Action"],
  [`${REPOSITORY}/issues/new/choose`, "Write to the webmaster (open an issue)"],
];

const COOL_LINKS = [
  ["https://www.sigstore.dev/", "Sigstore"],
  ["https://docs.npmjs.com/generating-provenance-statements", "npm provenance"],
  ["https://slsa.dev/", "SLSA"],
  ["https://openssf.org/", "OpenSSF"],
];

function link([href, text]) {
  return `<a href="${href}">${escapeHtml(text)}</a>`;
}

/** One page of the site: the 90s frame around the rendered Markdown. */
export function renderPage({ page, body, site }) {
  const isHome = page.output === "index.html";
  const title = isHome ? "releaseproof · Home" : `${page.label} · releaseproof`;
  const description = isHome
    ? "releaseproof verifies that an npm release matches its source: it rebuilds the package from the certified commit and compares the two, file by file."
    : `releaseproof documentation: ${page.label}`;
  const menu = site.pages
    .map((item) => {
      const current = item === page ? ' aria-current="page"' : "";
      const fresh = item.fresh
        ? ' <img class="new" src="images/new.svg" width="36" height="18" alt="new">'
        : "";
      return `<li><a class="button" href="${item.output}"${current}>${escapeHtml(item.label)}${fresh}</a></li>`;
    })
    .join("\n");
  const marquee = [
    `NEW! releaseproof ${site.version} is out`,
    `${site.ruleCount} rules on duty`,
    "rebuilds in Docker, with no network for the build step",
    "no telemetry, no account, no API key",
    '"could not verify" is never "safe"',
  ].join(" ★ ");
  const drive = `C:\\RELEASEPROOF\\${page.source.replaceAll("/", "\\").toUpperCase()}`;
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
<header class="masthead">
<a href="index.html"><img class="logo" src="images/logo.svg" width="560" height="120" alt="releaseproof home"></a>
<p class="tagline">Verify that an npm release matches its source before you trust it</p>
<div class="marquee"><p>★ ${escapeHtml(marquee)} ★</p></div>
</header>
<div class="layout">
<nav class="sidebar panel" aria-label="Site">
<p class="nav-title">~*~ Pages ~*~</p>
<ul class="menu">
${menu}
</ul>
</nav>
<aside class="extras panel" aria-label="Links and sponsor">
<p class="nav-title"><img src="images/globe.svg" width="24" height="24" alt=""> On the Web</p>
<ul class="web-links">
${WEB_LINKS.map((item) => `<li>${link(item)}</li>`).join("\n")}
</ul>
<p class="sponsor"><a href="${SPONSOR_URL}"><img src="images/sponsor.svg" width="160" height="60" alt="Sponsor releaseproof on GitHub Sponsors"></a></p>
<p class="counter">Rules on duty<br><span class="digits">${String(site.ruleCount).padStart(6, "0")}</span></p>
<p class="badges">
${BADGES.map(([file, alt]) => `<img src="images/${file}" width="88" height="31" alt="${escapeHtml(alt)}">`).join("\n")}
</p>
</aside>
<main id="content" class="window" tabindex="-1">
<div class="titlebar"><span class="path">${escapeHtml(drive)}</span><span class="controls" aria-hidden="true"><span>_</span><span>□</span><span>×</span></span></div>
<article class="window-body">
${body}
<p class="edit-link"><a href="${REPOSITORY}/edit/main/${page.source}">Edit this page on GitHub</a></p>
</article>
</main>
</div>
<footer class="site-footer">
<hr>
<p class="sponsor-line">Like releaseproof? <a href="${SPONSOR_URL}">Sponsor its development</a> and keep the rebuilds coming.</p>
<p><strong>Cool links:</strong> ${COOL_LINKS.map(link).join(" · ")}</p>
<p>releaseproof ${escapeHtml(site.version)} · MIT licensed${built} · Best viewed with any browser at any resolution.<br>This site uses 0 bytes of JavaScript and loads nothing from other hosts.</p>
</footer>
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
