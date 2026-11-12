// Relative to this script, so the worker finds its bundle whether the site is
// served from the origin root or from a subpath.
importScripts("vendor/scramjet/scramjet.all.js");

const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker();

// A fresh worker should take over immediately, otherwise the first proxied
// navigation races the activation and hits surge.sh instead of Scramjet.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// Scramjet's transport is not always ready on the very first request after a
// cold start. The app re-navigates the frame when it sees this page.
function retryPage(error) {
  const detail = error?.message ? `${error.message}` : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Starting the proxy…</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0e10;color:#9aa39c;
font:14px/1.6 ui-sans-serif,system-ui,sans-serif}pre{white-space:pre-wrap;max-width:80ch;color:#c9f75b;font-size:12px}</style></head>
<body><div><p>Starting the proxy…</p><pre>${String(detail).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</pre></div>
<script>try{parent.postMessage({type:"paxton:proxy-retry"},location.origin)}catch(e){}</script>
</body></html>`;
}

async function handleRequest(event) {
  try {
    await scramjet.loadConfig();

    // Config only exists once the page has booted the controller. Without it,
    // normal navigations must fall through to the network untouched.
    if (scramjet.config && scramjet.route(event)) {
      try {
        return await scramjet.fetch(event);
      } catch (error) {
        console.error("paxton: proxy fetch failed", error);
        return new Response(retryPage(error), {
          status: 503,
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        });
      }
    }
  } catch (error) {
    // Fail open: a broken proxy config should never take the site down.
    console.error("paxton: proxy config failed", error);
  }

  return fetch(event.request);
}

self.addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event));
});
