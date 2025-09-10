// js/validators.js

// ============ tiny utils ============
const $ = (id) => document.getElementById(id);
const log = (...a) => console.log("[validators]", ...a);
const err = (...a) => console.error("[validators]", ...a);

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
function nowISO(){ return new Date().toISOString().replace('T',' ').split('.')[0]; }

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))
  ]);
}

function isRateLimit(e) {
  const s = String(e && (e.message || e)).toLowerCase();
  const code = e && e.code;
  return code === -32005 || code === -32080 || s.includes("too many") || s.includes("429") || s.includes("rate");
}
function withRetry(fn, { tries = 5, base = 250, cap = 4000 } = {}) {
  let last;
  return (async () => {
    for (let i = 0; i < tries; i++) {
      try { return await fn(); }
      catch (e) {
        last = e;
        if (!isRateLimit(e)) throw e;
        const delay = Math.min(cap, base * (2 ** i)) + Math.floor(Math.random() * 150);
        log("rate-limited; retrying in", delay, "ms");
        await sleep(delay);
      }
    }
    throw last;
  })();
}

// serialize JSON-RPC calls so we never burst
function createLimiter(minDelayMs = 300) {
  let last = 0;
  return async (fn) => {
    const now = Date.now();
    const wait = Math.max(0, last + minDelayMs - now);
    if (wait) await sleep(wait);
    try { return await fn(); }
    finally { last = Date.now(); }
  };
}
const rpcLimiter = createLimiter(300);
async function limitedRpc(callFn) {
  return withRetry(() => rpcLimiter(callFn));
}

// ============ chain config ============
async function getCfg() {
  if (!window.getNetConfig) throw new Error("chain.js not loaded");
  const maybe = window.getNetConfig();
  return (maybe && typeof maybe.then === "function") ? await maybe : maybe;
}

// ============ constants / state (init at runtime) ============
let CHAIN_ID_DEC = 10143;
let EXPLORER_ADDR = "https://testnet.monadscan.com/address/";
let POOL_ADDRESS  = "0x0000000000000000000000000000000000000000";
const POOL_ABI    = ["function paused() view returns (bool)"];

let REFERENCE_RPC = "";
let endpoints = []; // [{ name, rpc }...]

// tuning
const QUERY_TIMEOUT_MS = 2500;
const AUTO_REFRESH_MS  = 0; // disabled by default

// wallet (optional)
let walletProvider, signer, userAddr, pool;

// dom
let rowsEl;

// ============ wallet header (optional) ============
async function bootWalletHeader() {
  const connectBtn = $("connect-btn");
  const walletAddr = $("wallet-address");
  if (!connectBtn || !walletAddr) return;

  connectBtn.style.display = "block";
  walletAddr.style.display = "none";

  if (!window.ethereum) {
    connectBtn.onclick = () => alert("No wallet found (install MetaMask)");
    return;
  }

  const accts = await window.ethereum.request({ method: "eth_accounts" }).catch(()=>[]);
  if (accts && accts.length > 0) await connectWallet();

  connectBtn.onclick = connectWallet;
  window.ethereum.on?.("accountsChanged", () => location.reload());
  window.ethereum.on?.("chainChanged",   () => location.reload());
}

async function connectWallet() {
  if (!window.ethereum) { alert("No wallet found (install MetaMask)"); return; }
  await ethereum.request({ method: "eth_requestAccounts" });

  // ethers v5
  walletProvider = new ethers.providers.Web3Provider(window.ethereum);
  signer = walletProvider.getSigner();
  userAddr = await signer.getAddress();

  $("connect-btn").style.display = "none";
  $("wallet-address").style.display = "block";
  $("wallet-address").innerHTML =
    `Connected: <a href="${EXPLORER_ADDR}${userAddr}" target="_blank" rel="noopener">` +
    `${userAddr.slice(0,6)}…${userAddr.slice(-4)}</a>`;

  pool = new ethers.Contract(POOL_ADDRESS, POOL_ABI, signer);
}

// ============ probing ============
async function jsonRpcBlockNumber(rpcUrl) {
  // ethers v5 JsonRpcProvider
  const prov = new ethers.providers.JsonRpcProvider(rpcUrl, { name: "monad-testnet", chainId: CHAIN_ID_DEC });
  try {
    const n = await withTimeout(limitedRpc(() => prov.getBlockNumber()), QUERY_TIMEOUT_MS);
    return { ok: true, block: n };
  } catch (e) {
    const msg = (e?.message || "").toLowerCase();
    if (isRateLimit(e)) {
      // one extra try after a short pause
      await sleep(200);
      try {
        const n2 = await withTimeout(limitedRpc(() => prov.getBlockNumber()), QUERY_TIMEOUT_MS);
        return { ok: true, block: n2, rate: true };
      } catch (_e2) {
        return { ok: false, err: "rate-limited" };
      }
    }
    if (msg.includes("timeout") || msg.includes("failed to fetch")) {
      return { ok: false, err: "timeout" };
    }
    return { ok: false, err: msg || "error" };
  }
}

async function measureLatency(rpcUrl) {
  const t0 = performance.now();
  const res = await jsonRpcBlockNumber(rpcUrl);
  const t1 = performance.now();
  if (res.ok) res.latency = Math.round(t1 - t0);
  return res;
}

function renderRows(data, refBlock) {
  rowsEl.innerHTML = "";
  data.forEach((row, idx) => {
    const tr = document.createElement("div");
    tr.className = "trow";

    let statusBadge = `<span class="badge">—</span>`;
    let lagStr = "—";
    let blockStr = "—";
    let latencyStr = row.latency != null ? `${row.latency} ms` : "—";

    if (row.ok) {
      blockStr = `#${row.block}`;
      const lag = Math.max(0, refBlock - row.block);
      lagStr = String(lag);

      let cls = "ok";
      let label = "OK";
      if (row.rate) { cls = "warn"; label = "Rate-limited"; }
      if (lag > 3)  { cls = "warn"; label = "Lagging"; }
      if (lag > 15) { cls = "err";  label = "Stale"; }

      statusBadge = `<span class="badge ${cls}">${label}</span>`;
    } else if (row.err) {
      const cls = row.err === "rate-limited" ? "warn" : "err";
      const label = row.err === "rate-limited" ? "Rate-limited" : "Down";
      statusBadge = `<span class="badge ${cls}">${label}</span>`;
    }

    tr.innerHTML = `
      <div class="tcell">${row.name}</div>
      <div class="tcell"><span class="muted">${row.rpc}</span></div>
      <div class="tcell">${blockStr}</div>
      <div class="tcell">${lagStr}</div>
      <div class="tcell">${latencyStr}</div>
      <div class="tcell">${statusBadge}</div>
      <div class="tcell right">
        <button data-idx="${idx}" class="probe-once">Probe</button>
        <button data-idx="${idx}" class="remove-endpoint">Remove</button>
      </div>
    `;
    rowsEl.appendChild(tr);
  });

  rowsEl.querySelectorAll(".probe-once").forEach(btn => {
    btn.onclick = async () => {
      const i = +btn.getAttribute("data-idx");
      await probeOne(i);
    };
  });
  rowsEl.querySelectorAll(".remove-endpoint").forEach(btn => {
    btn.onclick = () => {
      const i = +btn.getAttribute("data-idx");
      endpoints.splice(i,1);
      renderRows(endpoints.map(e => ({...e})), Number($("ref-block").textContent?.replace("#","")) || 0);
    };
  });
}

async function probeAll() {
  const refreshBtn = $("btn-refresh");
  if (refreshBtn) refreshBtn.disabled = true;

  $("ref-rpc").textContent = REFERENCE_RPC || "—";
  $("ref-updated").textContent = "Updating…";

  const refRes = REFERENCE_RPC ? await measureLatency(REFERENCE_RPC) : { ok:false };
  const refBlock = refRes.ok ? refRes.block : 0;
  $("ref-block").textContent = refBlock ? `#${refBlock}` : "—";
  $("ref-updated").textContent = nowISO();

  const display = endpoints.map(ep => ({ name: ep.name, rpc: ep.rpc, ok: false }));
  renderRows(display, refBlock);

  // sequential probing; tiny gap to be gentle
  for (let i = 0; i < endpoints.length; i++) {
    const ep = endpoints[i];
    const res = await measureLatency(ep.rpc);
    display[i] = { name: ep.name, rpc: ep.rpc, ...res };
    renderRows(display, refBlock);
    await sleep(80);
  }

  // wiring: pool.paused?
  try {
    const roProv = new ethers.providers.JsonRpcProvider(REFERENCE_RPC, { name: "monad-testnet", chainId: CHAIN_ID_DEC });
    const poolRO = new ethers.Contract(POOL_ADDRESS, POOL_ABI, roProv);
    const paused = await withTimeout(limitedRpc(() => poolRO.paused()), QUERY_TIMEOUT_MS).catch(() => null);
    $("wiring-paused").textContent = paused === null ? "—" : (paused ? "Yes" : "No");
  } catch (_) {
    $("wiring-paused").textContent = "—";
  }

  if (refreshBtn) refreshBtn.disabled = false;
}

async function probeOne(idx) {
  $("ref-updated").textContent = "Updating…";
  const refRes = REFERENCE_RPC ? await measureLatency(REFERENCE_RPC) : { ok:false };
  const refBlock = refRes.ok ? refRes.block : 0;
  $("ref-block").textContent = refBlock ? `#${refBlock}` : "—";
  $("ref-updated").textContent = nowISO();

  const ep = endpoints[idx];
  const res = await measureLatency(ep.rpc);

  const display = endpoints.map(ep => ({ name: ep.name, rpc: ep.rpc, ok: false }));
  display[idx] = { name: ep.name, rpc: ep.rpc, ...res };
  renderRows(display, refBlock);
}

function wireAddEndpoint() {
  const addBtn = $("btn-add-endpoint");
  if (!addBtn) return;
  addBtn.onclick = () => {
    const name = $("inp-new-name")?.value.trim() || "Custom RPC";
    const rpc  = $("inp-new-rpc")?.value.trim();
    if (!rpc || !/^https?:\/\//i.test(rpc)) {
      alert("Enter a valid RPC URL (https://...)");
      return;
    }
    endpoints.push({ name, rpc });
    if ($("inp-new-name")) $("inp-new-name").value = "";
    if ($("inp-new-rpc")) $("inp-new-rpc").value = "";
    renderRows(endpoints.map(e => ({...e})), Number($("ref-block").textContent?.replace("#","")) || 0);
  };
}

function startAuto() {
  if (AUTO_REFRESH_MS > 0) {
    stopAuto();
    window.__VAL_AUTO__ = setInterval(probeAll, AUTO_REFRESH_MS);
  }
}
function stopAuto() {
  if (window.__VAL_AUTO__) clearInterval(window.__VAL_AUTO__);
  window.__VAL_AUTO__ = null;
}

// ============ init ============
async function init() {
  rowsEl = $("probe-rows");
  if (!rowsEl) { err("No #probe-rows element; aborting."); return; }

  // chain config
  const cfg = await getCfg();
  CHAIN_ID_DEC = cfg?.chainId || 10143;
  EXPLORER_ADDR = (cfg?.explorer ? `${cfg.explorer}/address/` : "https://testnet.monadscan.com/address/");
  POOL_ADDRESS  = cfg?.pool || "0x0000000000000000000000000000000000000000";

  // reference RPC (single chosen by chain.js)
  REFERENCE_RPC = cfg?.rpc || (Array.isArray(cfg?.rpcs) && cfg.rpcs[0]) || "";
  const titleEl = $("network-overview-title");
  if (titleEl) titleEl.textContent = `Network Overview (${cfg?.label || "Unknown Network"})`;
  $("ref-rpc").textContent = REFERENCE_RPC || "—";

  // seed endpoint list from cfg.rpcs; label them
  endpoints = Array.isArray(cfg?.rpcs) && cfg.rpcs.length
    ? cfg.rpcs.filter(Boolean).map((url, i) => ({ name: i === 0 ? "RPC #1" : `RPC #${i+1}`, rpc: url }))
    : (REFERENCE_RPC ? [{ name: "Monad Public RPC", rpc: REFERENCE_RPC }] : []);

  // wire UI
  if ($("btn-refresh")) $("btn-refresh").onclick = probeAll;
  wireAddEndpoint();

  // optional wallet
  await bootWalletHeader();

  // first run
  await probeAll();
  startAuto();
}

window.addEventListener("DOMContentLoaded", init);
