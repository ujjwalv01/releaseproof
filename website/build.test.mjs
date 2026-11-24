import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  build,
  CONTENT_SECURITY_POLICY,
  checkLinks,
  escapeHtml,
  PAGES,
  pageUrl,
  REPOSITORY,
  ROOT,
  renderMarkdown,
  renderPage,
  rewriteHref,
  SITE_URL,
  slugify,
} from "./build.mjs";

describe("slugify", () => {
  it.each([
    ["Does `--offline` disable all network access?", "does---offline-disable-all-network-access"],
    [
      "How do I check a staged version (`--stage`, token requirements)?",
      "how-do-i-check-a-staged-version---stage-token-requirements",
    ],
    ["1. Goal", "1-goal"],
    ["0.2.2", "022"],
    ["What's new", "whats-new"],
  ])("gives %j GitHub's anchor %j", (heading, slug) => {
    expect(slugify(heading)).toBe(slug);
  });
});

describe("rewriteHref", () => {
  it("points links to Markdown that has a page at that page, keeping the anchor", () => {
    expect(
      rewriteHref("./docs/faq.md#does---offline-disable-all-network-access", "README.md"),
    ).toBe("faq.html#does---offline-disable-all-network-access");
    expect(rewriteHref("rules.md", "docs/faq.md")).toBe("rules.html");
    expect(rewriteHref("../CONTRIBUTING.md", "docs/faq.md")).toBe("contributing.html");
    expect(rewriteHref("../packages/cli/CHANGELOG.md", "docs/faq.md")).toBe("changelog.html");
  });

  it("points other repository files and folders at GitHub", () => {
    expect(rewriteHref("../packages/core/src/rules/files.ts#L10", "docs/rules.md")).toBe(
      `${REPOSITORY}/blob/main/packages/core/src/rules/files.ts#L10`,
    );
    expect(rewriteHref("./action.yml", "README.md")).toBe(`${REPOSITORY}/blob/main/action.yml`);
    expect(rewriteHref("../fixtures/", "docs/rules.md")).toBe(`${REPOSITORY}/tree/main/fixtures`);
    expect(rewriteHref("./", "README.md")).toBe(REPOSITORY);
  });

  it("keeps absolute URLs and in-page anchors", () => {
    for (const href of ["https://www.sigstore.dev/", "mailto:a@example.com", "#usage", "//cdn"]) {
      expect(rewriteHref(href, "docs/faq.md")).toBe(href);
    }
  });

  it("refuses links that leave the repository", () => {
    expect(() => rewriteHref("../../etc/passwd", "docs/faq.md")).toThrow("outside the repository");
  });
});

describe("renderMarkdown", () => {
  it("gives headings GitHub's anchors, numbering repeats", () => {
    const html = renderMarkdown("# Usage\n\n## Usage\n\n## Does `--offline` work?", "docs/x.md");
    expect(html).toContain('<h1 id="usage">Usage</h1>');
    expect(html).toContain('<h2 id="usage-1">Usage</h2>');
    expect(html).toContain('<h2 id="does---offline-work">Does <code>--offline</code> work?</h2>');
  });

  it("anchors rule ids in rule tables only, and wraps tables so they scroll", () => {
    const html = renderMarkdown(
      [
        "| Id | Severity |",
        "| --- | --- |",
        "| `file-added` / `file-missing` | high |",
        "",
        "| Verdict | Exit code |",
        "| --- | --- |",
        "| `not-a-rule-table` | 0 |",
      ].join("\n"),
      "docs/rules.md",
    );
    expect(html).toContain('<code id="file-added">file-added</code>');
    expect(html).toContain('<code id="file-missing">file-missing</code>');
    expect(html).toContain("<code>not-a-rule-table</code>");
    expect(html).toContain('<div class="table-wrap"><table>');
  });

  it("labels every table cell with its column heading, for the phone layout", () => {
    const html = renderMarkdown(
      "| Package | `Exit` code | A & B |\n| --- | --- | --- |\n| x | 0 | y |",
      "docs/x.md",
    );
    expect(html).toContain('<td data-label="Package">x</td>');
    expect(html).toContain('<td data-label="Exit code">0</td>');
    expect(html).toContain('<td data-label="A &#38; B">y</td>');
    expect(html).toContain("<th>Package</th>");
  });
});

describe("checkLinks", () => {
  const pages = new Map([
    ["a.html", '<h1 id="top">A</h1><a href="b.html#here">b</a><img src="images/x.svg">'],
    ["b.html", '<p id="here"></p><a href="#top">x</a><a href="a.html#gone">a</a><p id="here"></p>'],
  ]);

  it("reports missing files, missing anchors and repeated ids", () => {
    expect(checkLinks(pages, () => false).sort()).toEqual([
      'a.html: src="images/x.svg" points to a missing file',
      'b.html: href="#top" points to a missing anchor',
      'b.html: href="a.html#gone" points to a missing anchor',
      'b.html: the id "here" is used more than once',
    ]);
  });

  it("accepts links that resolve", () => {
    const ok = new Map([
      ["a.html", '<p id="x"></p><a href="#x">x</a><a href="https://e.com/#y">y</a>'],
    ]);
    expect(checkLinks(ok, () => false)).toEqual([]);
  });
});

describe("PAGES", () => {
  it("has a page for every Markdown file in docs/", () => {
    const docs = readdirSync(path.join(ROOT, "docs"))
      .filter((file) => file.endsWith(".md"))
      .map((file) => `docs/${file}`);
    const missing = docs.filter((file) => !PAGES.some((page) => page.source === file));
    expect(missing, "add these files to PAGES in website/build.mjs").toEqual([]);
  });

  it("uses each output name once", () => {
    const outputs = PAGES.map((page) => page.output);
    expect(new Set(outputs).size).toBe(outputs.length);
  });
});

describe("build", () => {
  let outDir;
  let result;
  beforeAll(() => {
    outDir = mkdtempSync(path.join(tmpdir(), "releaseproof-site-"));
    result = build({ outDir, commit: "a".repeat(40) });
  });
  afterAll(() => {
    rmSync(outDir, { recursive: true, force: true });
  });
  const page = (file) => readFileSync(path.join(outDir, file), "utf8");

  it("writes every page, the stylesheet and the images", () => {
    expect(result.pages).toEqual(PAGES.map((p) => p.output));
    for (const file of [...result.pages, "style.css", "images/favicon.svg"]) {
      expect(existsSync(path.join(outDir, file)), file).toBe(true);
    }
  });

  it("ships no JavaScript and loads nothing from other hosts", () => {
    for (const file of result.pages) {
      const html = page(file);
      expect(html).not.toMatch(/<script/i);
      expect(html).toContain(CONTENT_SECURITY_POLICY);
      expect(html).not.toMatch(/\s(?:src|srcset)="(?:https?:)?\/\//);
      expect(html).not.toMatch(/<link(?![^>]*\brel="canonical")[^>]+href="(?:https?:)?\/\//);
    }
  });

  it("writes sitemap.xml and robots.txt for the public site URL", () => {
    const sitemap = page("sitemap.xml");
    expect(sitemap).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>\n<urlset xmlns="/);
    expect(sitemap.trimEnd().endsWith("</urlset>")).toBe(true);
    const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
    expect(locs).toEqual(PAGES.map((p) => pageUrl(p)));
    expect(locs[0]).toBe(SITE_URL);
    expect(locs).not.toContain(`${SITE_URL}index.html`);

    const robots = page("robots.txt");
    expect(robots).toContain("User-agent: *\nAllow: /");
    expect(robots).toContain(`Sitemap: ${SITE_URL}sitemap.xml`);
  });

  it("includes canonical link and Open Graph metadata on every page", () => {
    for (const entry of PAGES) {
      const html = page(entry.output);
      const isHome = entry.output === "index.html";
      const expectedTitle = isHome ? "releaseproof · Home" : `${entry.label} · releaseproof`;
      const expectedDescription = isHome
        ? "releaseproof verifies that an npm release matches its source: it rebuilds the package from the certified commit and compares the two, file by file."
        : `releaseproof documentation: ${entry.label}`;
      const expectedUrl = pageUrl(entry);

      expect(html.match(/<link rel="canonical" href="[^"]+">/g)).toEqual([
        `<link rel="canonical" href="${escapeHtml(expectedUrl)}">`,
      ]);
      expect(html).toContain(`<meta property="og:title" content="${escapeHtml(expectedTitle)}">`);
      expect(html).toContain(
        `<meta property="og:description" content="${escapeHtml(expectedDescription)}">`,
      );
      expect(html).toContain(`<meta property="og:url" content="${escapeHtml(expectedUrl)}">`);
      expect(html).toContain('<meta property="og:type" content="website">');
      expect(html).toContain('<meta property="og:site_name" content="releaseproof">');
    }
  });

  it("gives every rule its own anchor on the rules page", () => {
    const rules = page("rules.html");
    const doc = readFileSync(path.join(ROOT, "docs/rules.md"), "utf8");
    const ids = [];
    let inRuleTable = false;
    for (const line of doc.split("\n")) {
      if (!line.startsWith("|")) {
        inRuleTable = false;
        continue;
      }
      const first = line.split("|")[1]?.trim() ?? "";
      if (first === "Id") {
        inRuleTable = true;
        continue;
      }
      if (!inRuleTable || /^-+$/.test(first)) {
        continue;
      }
      for (const match of first.matchAll(/`([^`]+)`/g)) {
        ids.push(match[1]);
      }
    }
    expect(ids.length).toBeGreaterThan(30);
    for (const id of ids) {
      expect(rules).toContain(`<code id="${id}">`);
    }
  });

  it("puts the diagram and the terminal picture into the home page only", () => {
    const home = page("index.html");
    expect(home.indexOf('id="what-releaseproof-does"')).toBeLessThan(home.indexOf("how-it-works"));
    expect(home.indexOf('id="usage"')).toBeLessThan(home.indexOf("images/terminal.svg"));
    expect(page("faq.html")).not.toContain("images/terminal.svg");
  });

  it("links the sponsor page, the version and the rule count from every page", () => {
    for (const file of result.pages) {
      const html = page(file);
      expect(html).toContain('href="https://github.com/sponsors/ujjwalv01"');
      expect(html).toMatch(/Version <a href="changelog\.html">\d+\.\d+\.\d+/);
      expect(html).toMatch(/<a href="rules\.html">\d+ rules<\/a>/);
    }
  });

  it("marks the current page in the menu and names the commit it was built from", () => {
    expect(page("faq.html")).toContain('<a href="faq.html" aria-current="page">');
    expect(page("faq.html")).toContain(`${REPOSITORY}/commit/${"a".repeat(40)}`);
  });

  it("includes an On this page section list on pages with 3+ h2 sections and omits it on short pages", () => {
    for (const longPage of [
      "faq.html",
      "rules.html",
      "design-rebuild.html",
      "design-action.html",
    ]) {
      const html = page(longPage);
      expect(html, longPage).toContain('<details class="toc-mobile">');
      expect(html, longPage).toContain('<section class="box toc-sidebar">');
      expect(html, longPage).not.toMatch(/<details class="toc-mobile"\s+open\b/);
    }
    expect(page("faq.html")).toContain(
      '<a href="#does---offline-disable-all-network-access">Does --offline disable all network access?</a>',
    );

    const shortSite = {
      pages: PAGES,
      version: "0.2.2",
      ruleCount: 42,
      commit: undefined,
    };
    const twoHeadings = [];
    const shortBody = renderMarkdown("# Title\n\n## First\n\n## Second\n", "docs/x.md", {
      headings: twoHeadings,
    });
    const shortHtml = renderPage({
      page: PAGES[1],
      body: shortBody,
      site: shortSite,
      headings: twoHeadings,
    });
    expect(twoHeadings).toHaveLength(2);
    expect(shortHtml).not.toContain("On this page");
    expect(shortHtml).not.toContain("toc-mobile");
    expect(shortHtml).not.toContain("toc-sidebar");

    const escapedHeadings = [];
    const escapedBody = renderMarkdown(
      '# Title\n\n## A & B <script>\n\n## `code` and [link](rules.md)\n\n## Third "quote"\n',
      "docs/x.md",
      { headings: escapedHeadings },
    );
    const escapedHtml = renderPage({
      page: PAGES[1],
      body: escapedBody,
      site: shortSite,
      headings: escapedHeadings,
    });
    expect(escapedHtml).toContain('<a href="#a--b-">A &#38; B </a>');
    expect(escapedHtml).toContain('<a href="#code-and-link">code and link</a>');
    expect(escapedHtml).toContain('<a href="#third-quote">Third &#34;quote&#34;</a>');
  });
});
