import { createHash } from "node:crypto";

/*
 * The page a pairing link opens: https://<server>/pair#<code>. The code is in the fragment,
 * which the browser keeps to itself, so this page reads it and offers to open Polso with it.
 * Each build of Polso has its own link scheme, so the page offers each one.
 */

const SCRIPT = `
const code = location.hash.slice(1);
const ok = /^[A-Za-z0-9_-]{43}$/.test(code);
document.getElementById(ok ? "ready" : "broken").hidden = false;
if (ok) {
  history.replaceState(null, "", location.pathname);
  const query = "?server=" + encodeURIComponent(location.origin) + "&code=" + code;
  for (const a of document.querySelectorAll("a[data-scheme]")) {
    a.href = a.dataset.scheme + "://pair" + query;
  }
  document.getElementById("code").textContent = code;
}
`;

const scriptHash = createHash("sha256").update(SCRIPT).digest("base64");

/** Allows only the inline script above; nothing loads from anywhere. */
export const PAIR_PAGE_CSP = `default-src 'none'; script-src 'sha256-${scriptHash}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

export const PAIR_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Pair with Polso</title>
<style>
  body { font: 17px/1.5 -apple-system, system-ui, sans-serif; max-width: 30rem; margin: 3rem auto; padding: 0 1rem; }
  a.open { display: block; margin: .75rem 0; padding: .8rem 1rem; border-radius: .6rem; background: #D33A2C; color: #fff; text-align: center; text-decoration: none; }
  code { word-break: break-all; }
</style>
</head>
<body>
<h1>Pair with Polso</h1>
<div id="ready" hidden>
  <p>Open this link on the iPhone that has Polso. It lets that phone copy your Health data to this server. The link works once, within 15 minutes.</p>
  <a class="open" data-scheme="polso" href="#">Open in Polso</a>
  <a class="open" data-scheme="polso-preview" href="#">Open in Polso Preview</a>
  <a class="open" data-scheme="polso-dev" href="#">Open in Polso Dev</a>
  <p>Or paste this code into Polso, with this server's address:</p>
  <p><code id="code"></code></p>
</div>
<div id="broken" hidden>
  <p>This link has no pairing code. Make a new one with <code>polso-server admin pair</code>.</p>
</div>
<script>${SCRIPT}</script>
</body>
</html>
`;
