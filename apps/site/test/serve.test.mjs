import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";

test("the built page serves the README heading and cargo-mutants credit", async (t) => {
  const readme = await readFile(new URL("../../../README.md", import.meta.url), "utf8");
  const heading = /^# (.+)$/m.exec(readme)?.[1];
  const credit = /\[cargo-mutants\]\(([^)]+)\)/.exec(readme)?.[1];
  assert.ok(heading, "README must have a first heading");
  assert.ok(credit, "README must credit cargo-mutants");

  const page = await readFile(new URL("../dist/client/index.html", import.meta.url));
  const server = createServer((request, response) => {
    if (request.url !== "/") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(page);
  });

  t.after(() => new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const response = await fetch(`http://127.0.0.1:${address.port}/`);
  assert.equal(response.status, 200);
  const html = await response.text();
  const escapeHtml = (text) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  assert.ok(html.includes(`<h1>${escapeHtml(heading)}</h1>`));
  assert.ok(html.includes(`<a href="${escapeHtml(credit)}">cargo-mutants</a>`));
  assert.doesNotMatch(html, /<meta name="robots"[^>]*noindex/, "the launched site must be indexable");
  assert.ok(html.includes('<a href="https://ratstack.sh">rat-stack</a>'), "page must link rat-stack");
  assert.match(html, /<meta property="og:image" content="https:\/\/mutant\.cafe\/banner\.jpg">/);
  assert.match(html, /<meta name="twitter:image" content="https:\/\/mutant\.cafe\/banner\.jpg">/);
  const image = await readFile(new URL("../dist/client/banner.jpg", import.meta.url));
  const source = await readFile(new URL("../../../assets/banner.jpg", import.meta.url));
  assert.ok(image.equals(source), "social image must be the approved banner");

  const linked = [...html.matchAll(/<link rel="(?:icon|apple-touch-icon|manifest)" href="\/([^"]+)"/g)].map((match) => match[1]);
  assert.ok(linked.length >= 4, "page must link its icons and manifest");
  for (const file of linked) {
    await readFile(new URL(`../dist/client/${file}`, import.meta.url));
  }
  const manifest = JSON.parse(await readFile(new URL("../dist/client/site.webmanifest", import.meta.url), "utf8"));
  for (const icon of manifest.icons) {
    await readFile(new URL(`../dist/client${icon.src}`, import.meta.url));
  }
});
