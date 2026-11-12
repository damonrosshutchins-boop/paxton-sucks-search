"use strict";

/**
 * Paxton Sucks Search — frontend.
 *
 * Search queries and proxied page loads both go to the Cloudflare Worker:
 *   /api/search  -> server-side DuckDuckGo search, returned as JSON
 *   /bare/       -> TompHTTP Bare v3 transport used by Scramjet
 *
 * The site itself is static (surge.sh). Scramjet runs in the service worker.
 */

const CONFIG = window.PAXTON_CONFIG || {};
const MIRRORS = Array.isArray(window.PAXTON_MIRRORS) ? window.PAXTON_MIRRORS.filter(Boolean) : [];
const WORKER_BASE = String(CONFIG.workerUrl || "").replace(/\/+$/, "");
const endpoint = (path) => `${WORKER_BASE}${path}`;
const BARE_ORIGIN = endpoint("/bare/");
// The app loads its assets next to the page rather than from the origin root,
// so one build works at "/" (surge, Cloudflare Pages) and under a subpath such
// as GitHub Pages' /<repo>/. Everything below derives from these two.
const BASE_PATH = new URL(".", document.baseURI).pathname;
const local = (path) => `${BASE_PATH}${path}`;
const SCRAMJET_PREFIX = local("p/");

const els = {
  body: document.body,
  homeForm: document.getElementById("search-form"),
  resultsForm: document.getElementById("results-form"),
  homeInput: document.getElementById("q"),
  resultsInput: document.getElementById("q-compact"),
  chips: document.getElementById("chips"),
  resultsMeta: document.getElementById("results-meta"),
  resultsList: document.getElementById("results-list"),
  views: {
    home: document.getElementById("view-home"),
    results: document.getElementById("view-results"),
    proxy: document.getElementById("view-proxy"),
  },
  backendPill: document.getElementById("backend-pill"),
  backendLabel: document.getElementById("backend-label"),
  banner: document.getElementById("backend-banner"),
  address: document.getElementById("address"),
  rawLink: document.getElementById("btn-raw"),
  frameSlot: document.getElementById("frame-slot"),
  proxyError: document.getElementById("proxy-error"),
  back: document.getElementById("btn-back"),
  forward: document.getElementById("btn-forward"),
  reload: document.getElementById("btn-reload"),
  copy: document.getElementById("btn-copy"),
  exit: document.getElementById("btn-exit"),
  linkgenGo: document.getElementById("linkgen-go"),
  linkgenOut: document.getElementById("linkgen-out"),
  linkgenCopy: document.getElementById("linkgen-copy"),
  proofGo: document.getElementById("proof-go"),
  proofOut: document.getElementById("proof-out"),
};

let lastMirror = "";

let frame = null;
let framePromise = null;
let bareConnection = null;
let searchToken = 0;
let proxyRetries = 0;
const PROXY_RETRY_DELAYS = [250, 700, 1500, 2500];

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

bindEvents();
pingBackend();
handleDeepLink();
els.homeInput.focus({ preventScroll: true });

function bindEvents() {
  els.homeForm.addEventListener("submit", (event) => {
    event.preventDefault();
    submit(els.homeInput.value);
  });

  els.resultsForm.addEventListener("submit", (event) => {
    event.preventDefault();
    submit(els.resultsInput.value);
  });

  els.chips.addEventListener("click", (event) => {
    const chip = event.target.closest("[data-query]");
    if (!chip) return;
    runSearch(chip.dataset.query);
  });

  document.querySelectorAll("[data-home]").forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      exitToHome();
    });
  });

  els.back.addEventListener("click", () => frame?.back());
  els.forward.addEventListener("click", () => frame?.forward());
  els.reload.addEventListener("click", () => frame?.reload());
  els.exit.addEventListener("click", exitToHome);

  els.copy.addEventListener("click", async () => {
    const value = els.address.textContent || "";
    try {
      await navigator.clipboard.writeText(value);
      flash(els.copy, "copied");
    } catch {
      flash(els.copy, "nope");
    }
  });

  els.linkgenGo.addEventListener("click", generateMirrorLink);
  els.proofGo.addEventListener("click", checkEgress);

  els.linkgenCopy.addEventListener("click", async () => {
    const url = els.linkgenOut.dataset.url;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      flash(els.linkgenCopy, "copied");
    } catch {
      flash(els.linkgenCopy, "nope");
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !els.views.proxy.hidden) exitToHome();
  });

  // Two recovery signals, both about the cold-start race: surge's 200.html
  // fires when a proxy navigation slipped past the worker entirely, and the
  // worker's retry page fires when Scramjet's transport was not ready yet.
  window.addEventListener("message", (event) => {
    if (event.origin !== window.location.origin) return;
    const type = event.data?.type;
    if (type !== "paxton:proxy-miss" && type !== "paxton:proxy-retry") return;
    if (!frame) return;

    if (proxyRetries >= PROXY_RETRY_DELAYS.length) {
      showProxyError(
        new Error("The proxy engine is not starting. Reload the page to try again."),
        els.address.textContent,
      );
      return;
    }

    const delay = PROXY_RETRY_DELAYS[proxyRetries];
    proxyRetries += 1;
    const target = els.address.textContent;
    setTimeout(async () => {
      try {
        // A cold worker can cache a missing transport; re-applying it hands the
        // worker a fresh port before the next attempt.
        await bareConnection?.setTransport(local("vendor/baremod/index.mjs"), [BARE_ORIGIN]);
      } catch {
        /* the navigation below is still worth a try */
      }
      frame?.go(target);
    }, delay);
  });
}

/* ------------------------------------------------------------------ *
 * Link gen
 * ------------------------------------------------------------------ */

function generateMirrorLink() {
  // Entries are host[:path]; skip whichever one we are already on.
  const here = (entry) => entry === window.location.host || entry.startsWith(`${window.location.host}/`);
  const candidates = MIRRORS.filter((entry) => !here(entry));

  if (candidates.length === 0) {
    els.linkgenOut.textContent = "no backups published yet — run: npm run mirrors -- boost 3";
    els.linkgenCopy.hidden = true;
    delete els.linkgenOut.dataset.url;
    return;
  }

  // Avoid handing out the same mirror twice in a row when there is a choice.
  const pool = candidates.length > 1 ? candidates.filter((entry) => entry !== lastMirror) : candidates;
  const host = pool[Math.floor(Math.random() * pool.length)];
  lastMirror = host;

  const url = `https://${host}`.replace(/\/+$/, "/");
  const link = document.createElement("a");
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = url;

  els.linkgenOut.dataset.url = url;
  els.linkgenOut.replaceChildren(link);
  els.linkgenCopy.hidden = false;
}

/* ------------------------------------------------------------------ *
 * Proof panel
 * ------------------------------------------------------------------ */

function proofRow(label, value) {
  const row = document.createElement("span");
  row.className = "proof-row";
  const key = document.createElement("b");
  key.textContent = label;
  row.append(key, document.createTextNode(value));
  return row;
}

async function checkEgress() {
  els.proofOut.textContent = "asking Cloudflare…";
  try {
    const response = await fetch(endpoint("/api/whoami"), { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();

    const rows = [];
    if (data.you?.ip) {
      rows.push(proofRow("you", ` ${data.you.ip}${data.you.colo ? ` · ${data.you.colo}` : ""}`));
    }
    if (data.egress?.ip) {
      const cached = data.egress.cached ? ` · cached ${data.egress.age}s` : "";
      rows.push(proofRow("site sees", ` ${data.egress.ip} · cloudflare${cached}`));
    }
    if (rows.length === 0) throw new Error("no address returned");
    els.proofOut.replaceChildren(...rows);
  } catch (error) {
    els.proofOut.textContent = `check failed: ${error.message}`;
  }
}

function handleDeepLink() {
  const params = new URLSearchParams(window.location.search);
  const query = params.get("q");
  const url = params.get("url");

  if (query) runSearch(query);
  else if (url) openProxy(url);
}

/* ------------------------------------------------------------------ *
 * Search
 * ------------------------------------------------------------------ */

function submit(rawValue) {
  const value = String(rawValue || "").trim();
  if (!value) return;

  const target = parseTarget(value);
  if (target) openProxy(target);
  else runSearch(value);
}

function parseTarget(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  try {
    const url = new URL(raw);
    if (url.protocol === "http:" || url.protocol === "https:") return url.toString();
  } catch {
    /* not an absolute URL, keep trying */
  }

  // Bare domains without a scheme: "example.com/path".
  if (/^[\w-]+(\.[\w-]+)+([/?#].*)?$/.test(raw)) {
    try {
      return new URL(`https://${raw}`).toString();
    } catch {
      /* fall through to search */
    }
  }

  return null;
}

async function runSearch(rawQuery) {
  const query = String(rawQuery || "").trim();
  if (!query) return;

  const token = ++searchToken;
  setInputs(query);
  showView("results");
  els.resultsMeta.textContent = "Routing through Cloudflare…";
  els.resultsList.replaceChildren(skeleton(4));
  window.history.replaceState(null, "", `${BASE_PATH}?q=${encodeURIComponent(query)}`);

  try {
    const response = await fetch(endpoint(`/api/search?q=${encodeURIComponent(query)}&limit=12`), {
      headers: { accept: "application/json" },
    });
    const data = await response.json().catch(() => null);

    if (token !== searchToken) return;
    if (!response.ok) throw new Error(data?.message || `Search failed (HTTP ${response.status}).`);

    renderResults(query, data);
  } catch (error) {
    if (token !== searchToken) return;
    renderSearchError(query, error);
  }
}

function renderResults(query, data) {
  const results = Array.isArray(data?.results) ? data.results : [];
  const provider = data?.provider || "upstream";

  if (results.length === 0) {
    els.resultsMeta.textContent = `No results for “${query}” · ${provider} · via Cloudflare`;
    els.resultsList.replaceChildren(
      stateBlock("Nothing came back.", "Try different wording, or paste a URL to open it through the proxy."),
    );
    return;
  }

  els.resultsMeta.textContent = `${results.length} results · ${provider} · ${data.tookMs ?? "?"}ms · via Cloudflare`;

  const fragment = document.createDocumentFragment();
  for (const result of results) fragment.append(resultCard(result));
  els.resultsList.replaceChildren(fragment);
}

function resultCard(result) {
  const article = document.createElement("article");
  article.className = "result";

  const meta = document.createElement("div");
  meta.className = "result-site";
  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = (result.site || "?").charAt(0).toUpperCase();
  const site = document.createElement("span");
  site.textContent = result.site || "";
  meta.append(badge, site);

  const title = document.createElement("button");
  title.type = "button";
  title.className = "result-title";
  title.textContent = result.title || result.url;
  title.title = result.url;
  title.addEventListener("click", () => openProxy(result.url));

  const snippet = document.createElement("p");
  snippet.className = "result-snippet";
  snippet.textContent = result.snippet || "No snippet provided.";

  const actions = document.createElement("div");
  actions.className = "result-actions";

  const open = document.createElement("button");
  open.type = "button";
  open.className = "ghost";
  open.textContent = "Open through proxy";
  open.addEventListener("click", () => openProxy(result.url));

  const direct = document.createElement("a");
  direct.className = "raw-link";
  direct.href = result.url;
  direct.target = "_blank";
  direct.rel = "noopener noreferrer nofollow";
  direct.textContent = "direct ↗";

  actions.append(open, direct);
  article.append(meta, title, snippet, actions);
  return article;
}

function renderSearchError(query, error) {
  els.resultsMeta.textContent = "Search failed.";
  const block = stateBlock("The Worker didn’t answer.", String(error?.message || error));
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "ghost";
  retry.textContent = "Try again";
  retry.addEventListener("click", () => runSearch(query));
  block.append(retry);
  els.resultsList.replaceChildren(block);
  showBackend(false);
}

function stateBlock(title, detail) {
  const box = document.createElement("div");
  box.className = "state";

  const heading = document.createElement("strong");
  heading.textContent = title;

  const copy = document.createElement("p");
  copy.textContent = detail;

  box.append(heading, copy);
  return box;
}

function skeleton(count) {
  const fragment = document.createDocumentFragment();
  for (let index = 0; index < count; index += 1) {
    const card = document.createElement("div");
    card.className = "skeleton";
    card.innerHTML =
      '<span class="sk sk-site"></span><span class="sk sk-title"></span><span class="sk sk-line"></span>';
    fragment.append(card);
  }
  return fragment;
}

/* ------------------------------------------------------------------ *
 * Proxy
 * ------------------------------------------------------------------ */

async function openProxy(rawUrl) {
  const target = parseTarget(rawUrl) || (String(rawUrl || "").trim() ? null : null);
  if (!target) return;

  showView("proxy");
  els.body.classList.add("in-proxy");
  els.proxyError.hidden = true;
  proxyRetries = 0;
  setAddress(target);
  window.history.replaceState(null, "", `${BASE_PATH}?url=${encodeURIComponent(target)}`);

  try {
    if (!framePromise) framePromise = bootScramjet().catch((error) => {
      framePromise = null;
      frame = null;
      throw error;
    });

    frame = await framePromise;
    frame.go(target);
  } catch (error) {
    showProxyError(error, target);
  }
}

async function bootScramjet() {
  if (typeof window.$scramjetLoadController !== "function") {
    throw new Error("The Scramjet bundle is missing. Run `npm run build` and reload.");
  }
  if (!window.BareMux) {
    throw new Error("The bare-mux bundle is missing. Run `npm run build` and reload.");
  }

  await repairProxyDatabase();

  const { ScramjetController } = window.$scramjetLoadController();
  const controller = new ScramjetController({
    prefix: SCRAMJET_PREFIX,
    files: {
      wasm: local("vendor/scramjet/scramjet.wasm.wasm"),
      all: local("vendor/scramjet/scramjet.all.js"),
      sync: local("vendor/scramjet/scramjet.sync.js"),
    },
  });

  // Create the config database *before* the service worker exists. The worker's
  // loadConfig() opens the same database without an upgrade, and if it wins the
  // race the object stores are never created and every boot fails.
  await controller.init();

  // Point every request at the Worker's Bare v3 endpoint *before* the service
  // worker exists. If the worker activates first it caches a missing transport
  // and every proxied navigation fails until the page is reloaded.
  bareConnection = new window.BareMux.BareMuxConnection(local("vendor/baremux/worker.js"));
  await bareConnection.setTransport(local("vendor/baremod/index.mjs"), [BARE_ORIGIN]);

  await ensureServiceWorker();

  // Deliberately no controller.modifyConfig() here: it posts a "loadConfig"
  // message that sets the worker's config object without initialising the
  // library's global config, so every later request dies on `prefix`. The
  // worker reads the config from IndexedDB, where init() already stored it.

  const created = controller.createFrame();
  created.frame.id = "pax-frame";
  created.frame.title = "Proxied page";
  created.addEventListener("urlchange", (event) => {
    const current = String(event?.url || "");
    if (current) setAddress(current);
  });

  els.frameSlot.replaceChildren(created.frame);
  return created;
}

const PROXY_DB = "$scramjet";
const PROXY_STORES = ["config", "cookies", "redirectTrackers", "referrerPolicies", "publicSuffixList"];

/**
 * Self-heal a proxy database that was created without Scramjet's object stores
 * (older builds, or a service worker that beat the page to IndexedDB).
 */
async function repairProxyDatabase() {
  if (!("databases" in indexedDB)) return;

  const databases = await indexedDB.databases();
  if (!databases.some((entry) => entry.name === PROXY_DB)) return;

  const stores = await new Promise((resolve) => {
    const request = indexedDB.open(PROXY_DB);
    request.onsuccess = () => {
      const db = request.result;
      const names = [...db.objectStoreNames];
      db.close();
      resolve(names);
    };
    request.onerror = () => resolve([]);
  });

  if (PROXY_STORES.every((store) => stores.includes(store))) return;

  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(PROXY_DB);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(new Error("Could not rebuild the proxy database."));
    request.onblocked = () =>
      reject(new Error("Close other tabs of this site and reload — the proxy database is still open."));
  });
}

async function ensureServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    throw new Error("This browser has no service workers, so Scramjet cannot run.");
  }
  if (!window.isSecureContext) {
    throw new Error("Service workers need HTTPS (or localhost). Open the site over HTTPS.");
  }

  await navigator.serviceWorker.register(local("sw.js"), { scope: BASE_PATH });
  await navigator.serviceWorker.ready;

  if (!navigator.serviceWorker.controller) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3000);
      navigator.serviceWorker.addEventListener(
        "controllerchange",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }

  if (!navigator.serviceWorker.controller) {
    throw new Error("The proxy service worker is not controlling this page yet. Reload and try again.");
  }
}

function setAddress(url) {
  els.address.textContent = url;
  els.address.title = url;
  els.rawLink.href = url;
}

function showProxyError(error, target) {
  els.proxyError.hidden = false;

  const heading = document.createElement("strong");
  heading.textContent = "The proxy could not start.";

  const detail = document.createElement("p");
  detail.textContent = String(error?.message || error);

  const direct = document.createElement("a");
  direct.href = target || els.address.textContent || "#";
  direct.target = "_blank";
  direct.rel = "noopener noreferrer nofollow";
  direct.textContent = "Open it directly instead ↗";

  els.proxyError.replaceChildren(heading, detail, direct);
}

function exitToHome() {
  showView("home");
  els.body.classList.remove("in-proxy");
  window.history.replaceState(null, "", BASE_PATH);
  els.homeInput.focus({ preventScroll: true });
}

/* ------------------------------------------------------------------ *
 * Chrome
 * ------------------------------------------------------------------ */

function showView(name) {
  for (const [key, element] of Object.entries(els.views)) element.hidden = key !== name;
  if (name !== "proxy") els.body.classList.remove("in-proxy");
  window.scrollTo(0, 0);
}

function setInputs(value) {
  els.homeInput.value = value;
  els.resultsInput.value = value;
}

function flash(element, text) {
  const original = element.textContent;
  element.textContent = text;
  setTimeout(() => {
    element.textContent = original;
  }, 1200);
}

async function pingBackend() {
  setBackend("checking", "checking Cloudflare…");

  try {
    const started = performance.now();
    const response = await fetch(endpoint("/api/health"), { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const latency = Math.round(performance.now() - started);

    setBackend("online", `cloudflare · ${latency}ms`);
    els.backendPill.title = `Worker ${data.version || "?"} · ${data.search || "search"} · colo ${data.colo || "?"}`;
    els.banner.hidden = true;
  } catch {
    setBackend("offline", "backend offline");
    els.backendPill.title = "The Cloudflare Worker could not be reached.";
    els.banner.hidden = false;
  }
}

function setBackend(state, label) {
  if (els.backendPill.dataset.state !== state) els.backendPill.dataset.state = state;
  els.backendLabel.textContent = label;
}

function showBackend(online) {
  setBackend(online ? "online" : "offline", online ? "cloudflare" : "backend offline");
  els.banner.hidden = online;
}
