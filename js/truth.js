// js/truth.js

// ---------- tiny utils ----------
function esc(s){ return (s||"").toString().replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
function byId(id){ return document.getElementById(id); }
function toGithubBlob(path){
  const clean = String(path||"").replace(/^https?:\/\/[^/]+\/+/, "").replace(/^\/+/, "");
  return `https://github.com/rebel-pool/rebel-pool.github.io/blob/main/${clean}`;
}
const log = (...a)=>console.log("[truth]", ...a);
const err = (...a)=>console.error("[truth]", ...a);

// ---------- clock ----------
function startClock(){
  const d = new Date();
  const fmt = { weekday:'long', year:'numeric', month:'long', day:'numeric' };
  const hh = String(d.getHours()).padStart(2,'0'), mm = String(d.getMinutes()).padStart(2,'0'), ss = String(d.getSeconds()).padStart(2,'0');
  byId('masthead-date').textContent = d.toLocaleDateString('en-US', fmt).toUpperCase();
  byId('masthead-clock').textContent = `${hh}:${mm}:${ss}`;
}
function initClock(){ startClock(); setInterval(startClock, 1000); }

// ---------- forge test summary ----------
function summarizeForge(txt){
  txt = txt.replace(/\x1B\[[0-9;]*m/g, '');
  const lines = txt.split(/\r?\n/);
  let passed=0, failed=0, warnings=0;
  for (const ln of lines) {
    if (/^\s*\[(?:PASS|OK)\]/i.test(ln))  passed++;
    if (/^\s*\[(?:FAIL|ERROR)\]/i.test(ln)) failed++;
    if (/warning:/i.test(ln)) warnings++;
  }
  if (passed===0 && failed===0) {
    const mFail = txt.match(/Failing tests:\s*(\d+)/i); if (mFail) failed += Number(mFail[1]||0);
    const mPass = txt.match(/Passing:\s*(\d+)/i);       if (mPass) passed += Number(mPass[1]||0);
  }
  return { passed, failed, warnings };
}

function showTestResultsModal(contractLabel, testText, summaryHTML){
  const wrap = document.createElement('div');
  wrap.className = 'modal open';
  wrap.innerHTML = `
    <div class="modal-content" role="dialog" aria-modal="true" aria-labelledby="test-modal-title" style="text-align:left; max-width:900px; width:95%; max-height:85vh; overflow:auto;">
      <h2 id="test-modal-title">${esc(contractLabel)} — Test Results</h2>
      <div style="margin:10px 0; font-weight:bold;">${summaryHTML||''}</div>
      <pre style="background:#f7f7f7; padding:10px; border:1px solid #ccc; white-space:pre-wrap; font-size:12px; line-height:1.45;">${esc(testText)}</pre>
      <div style="text-align:right; margin-top:12px;">
        <button class="stake-btn" id="copy-log">Copy Log</button>
        <button class="stake-btn" id="close-modal">Close</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  const close = () => { wrap.classList.remove('open'); setTimeout(()=>wrap.remove(), 120); };
  wrap.addEventListener('click', e => { if (e.target === wrap) close(); });
  wrap.querySelector('#close-modal').addEventListener('click', close);
  wrap.querySelector('#copy-log').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(testText); } catch {}
  });
}

// ---------- rate-limit & backoff ----------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function isRateLimit(e) {
  const s = String(e && (e.message || e)).toLowerCase();
  return e?.code === -32005 || s.includes("too many") || s.includes("429") || s.includes("rate");
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

// serialize all JSON-RPC calls to avoid bursts
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

// ---------- provider (RPC-only; no injected wallet) ----------
async function getProvider(CHAIN_ID, rpcUrl) {
  const { ethers } = window;
  if (!rpcUrl) throw new Error("No RPC configured");
  const p = new ethers.JsonRpcProvider(rpcUrl, CHAIN_ID, { staticNetwork: true });
  try { p.pollingInterval = 12000; } catch {}
  await limitedRpc(() => p.getBlockNumber()); // smoke test
  log("using RPC:", rpcUrl);
  return p;
}

// ---------- EIP-1967 checks ----------
function fmtAddr(raw32){ return window.ethers.getAddress("0x" + raw32.slice(26)); }

async function checkAddress(provider, proxyAddr){
  const { ethers } = window;
  const SLOT_IMPLEMENTATION = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
  const SLOT_ADMIN          = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
  const res = { proxy: proxyAddr, hasCode:false, impl:null, implHasCode:false, admin:null, errors:[] };

  try {
    const code = await limitedRpc(() => provider.getCode(proxyAddr));
    res.hasCode = (code && code !== "0x");
  } catch (e) { res.errors.push("code(proxy) error: " + (e.message||e)); }
  await sleep(120);

  try {
    const rawImpl = await limitedRpc(() => provider.getStorage(proxyAddr, SLOT_IMPLEMENTATION));
    if (rawImpl && rawImpl !== ethers.ZeroHash) {
      res.impl = fmtAddr(rawImpl);
      await sleep(120);
      try {
        const codeImpl = await limitedRpc(() => provider.getCode(res.impl));
        res.implHasCode = (codeImpl && codeImpl !== "0x");
      } catch (e) { res.errors.push("code(impl) error: " + (e.message||e)); }
    }
  } catch (e) { res.errors.push("impl slot read error: " + (e.message||e)); }
  await sleep(120);

  try {
    const rawAdmin = await limitedRpc(() => provider.getStorage(proxyAddr, SLOT_ADMIN));
    if (rawAdmin && rawAdmin !== ethers.ZeroHash) res.admin = fmtAddr(rawAdmin);
  } catch {}

  return res;
}

function renderResult(containerId, label, r){
  const parts = [];
  parts.push(`<b>${esc(label)}</b> — ${esc(r.proxy)}`);
  parts.push(r.hasCode ? `<div class="ok">Proxy code OK</div>` : `<div class="err">No code at proxy address</div>`);
  if (r.impl) {
    parts.push(`<div>Implementation: ${esc(r.impl)}</div>`);
    parts.push(r.implHasCode ? `<div class="ok">Implementation code OK</div>` : `<div class="err">No code at implementation</div>`);
  } else {
    parts.push(`<div class="warn">Implementation slot not readable or empty</div>`);
  }
  if (r.admin) parts.push(`<div class="muted">Admin: ${esc(r.admin)}</div>`);
  if (r.errors.length) parts.push(`<div class="err">${esc(r.errors.join(" | "))}</div>`);
  byId(containerId).innerHTML = parts.join("\n");
}

// ---------- config helpers ----------
async function getConfigAwaited(){
  if (!window.getNetConfig) return null;
  const maybe = window.getNetConfig(); // chain.js
  const cfg = (maybe && typeof maybe.then === "function") ? await maybe : maybe;
  log("cfg from chain.js:", cfg);
  return cfg;
}

// ---------- boot ----------
window.addEventListener("DOMContentLoaded", async () => {
  // network selector + clock
  if (window.renderNetworkSelector) {
    window.renderNetworkSelector("network-select", () => location.reload());
  }
  initClock();

  const cfg = await getConfigAwaited();
  const rpc = (cfg && (cfg.rpc || (Array.isArray(cfg.rpcs) && cfg.rpcs[0]))) || "";
  log("resolved RPC:", rpc);

  const explorerBase = (cfg && cfg.explorer) ? cfg.explorer : "https://testnet.monadscan.com";
  const CHAIN_ID = cfg?.chainId || 10143;

  const CONTRACTS = [
    { key:"POOL", label:"Pool Core",       address: cfg?.pool,    codePath:"contracts/StakePoolCore.sol", compiler:"Solidity 0.8.24<br>Optimizer: 200", testPath:"contracts/tests/StakePoolCore.t.sol",       resultsPath:"contracts/tests/StakePoolCore_test_results.txt",       verifyId:"verify-result-1" },
    { key:"AQUA", label:"AquaMON (stMON)", address: cfg?.aquamon, codePath:"contracts/AquaMON.sol",       compiler:"Solidity 0.8.24<br>Optimizer: 200", testPath:"contracts/tests/AquaMON.t.sol",             resultsPath:"contracts/tests/AquaMON_test_results.txt",             verifyId:"verify-result-2" },
    { key:"ARC",  label:"ArcMON (wstMON)", address: cfg?.arcmon,  codePath:"contracts/ArcMON.sol",        compiler:"Solidity 0.8.24<br>Optimizer: 200", testPath:"contracts/tests/ArcMON.t.sol",              resultsPath:"contracts/tests/ArcMON_test_results.txt",              verifyId:"verify-result-3" }
  ];

  // table rows
  const tb = document.querySelector("#truth-table tbody");
  tb.innerHTML = CONTRACTS.map(c => `
    <tr>
      <td><b>${c.label}</b></td>
      <td><a href="${explorerBase}/address/${c.address}" target="_blank" rel="noopener" style="color:#00308f;">${c.address}</a></td>
      <td><a href="${toGithubBlob(c.codePath)}" target="_blank" rel="noopener" style="color:#007642;">View on GitHub</a></td>
      <td>${c.compiler}</td>
      <td><a href="${toGithubBlob(c.testPath)}" target="_blank" rel="noopener">View test</a></td>
      <td>
        <a href="${toGithubBlob(c.resultsPath)}" target="_blank" rel="noopener">Open</a>
        &nbsp;|&nbsp;
        <button class="stake-btn" style="padding:2px 8px;font-size:12px;" data-key="${c.key}">Show Results</button>
      </td>
      <td>
        <button class="stake-btn" data-verify="${c.key}" data-target="${c.verifyId}">Verify Now</button>
        <div class="verify-result" id="${c.verifyId}"></div>
      </td>
    </tr>
  `).join("");

  // Show Results modal handlers
  tb.querySelectorAll('button[data-key]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const key = btn.getAttribute('data-key');
      const c = CONTRACTS.find(x => x.key === key);
      log("load results for", key, "from", c.resultsPath);
      try {
        const resp = await fetch(c.resultsPath, { cache: 'no-store' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const txt = await resp.text();
        const s = summarizeForge(txt);
        const summary = (s.failed>0) ? `<span class="err">FAILED: ${s.failed}</span>` :
                         (s.passed>0) ? `<span class="ok">All tests passed ✓ (${s.passed})</span>` :
                                        `<span class="warn">No tests detected</span>`;
        showTestResultsModal(c.label, txt, summary);
      } catch (e) {
        err("load results failed", e);
        showTestResultsModal(c.label, `Could not load results: ${e.message||e}`, "");
      }
    });
  });

  // Per-row Verify (RPC-only; throttled; debounced)
  tb.querySelectorAll('button[data-verify]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      const key = btn.getAttribute('data-verify');
      const target = btn.getAttribute('data-target');
      const c = CONTRACTS.find(x => x.key === key);
      byId(target).innerHTML = `<span class="muted">Verifying on-chain…</span>`;
      try {
        const provider = await getProvider(CHAIN_ID, rpc);
        const r = await checkAddress(provider, c.address);
        renderResult(target, c.label, r);
      } catch (e) {
        err("verify failed", e);
        byId(target).innerHTML = `<span class="err">Error: ${esc(e.message)}</span>`;
      } finally {
        btn.disabled = false;
      }
    });
  });

  // Verify All (sequential; throttled)
  const verifyAllBtn = byId("verify-all");
  if (verifyAllBtn) {
    verifyAllBtn.addEventListener('click', async () => {
      if (verifyAllBtn.disabled) return;
      verifyAllBtn.disabled = true;
      const container = byId("verify-all-result");
      container.innerHTML = `<span class="muted">Verifying all…</span>`;
      try {
        const provider = await getProvider(CHAIN_ID, rpc);
        const outs = [];
        for (const c of CONTRACTS) {
          const r = await checkAddress(provider, c.address);
          outs.push(
            `<div class="${(r.hasCode && (r.impl ? r.implHasCode : true)) ? 'ok':'warn'}">
              <b>${esc(c.label)}</b> — ${esc(r.proxy)}
              ${r.hasCode ? "✓ proxy" : "✗ proxy"}
              ${r.impl ? (r.implHasCode ? " ✓ impl" : " ✗ impl") : " (no impl slot)"}
            </div>` +
            (r.errors.length ? `<div class="err">${esc(r.errors.join(" | "))}</div>` : "")
          );
          await sleep(120); // small gap between contracts
        }
        container.innerHTML = outs.join("\n");
      } catch (e) {
        err("verify all failed", e);
        container.innerHTML = `<span class="err">Error: ${esc(e.message)}</span>`;
      } finally {
        verifyAllBtn.disabled = false;
      }
    });

    // Optional bulk "Load All Results" helper
    const loadAllBtn = document.createElement('button');
    loadAllBtn.className = 'stake-btn';
    loadAllBtn.style.marginLeft = '8px';
    loadAllBtn.textContent = 'Load All Results';
    loadAllBtn.addEventListener('click', () => {
      const tasks = CONTRACTS.map(async c => {
        try {
          const r = await fetch(c.resultsPath, { cache: 'no-store' });
          const txt = r.ok ? await r.text() : `HTTP ${r.status}`;
          const s = summarizeForge(txt);
          const summary = (s.failed>0) ? `<span class="err">FAILED: ${s.failed}</span>` :
                           (s.passed>0) ? `<span class="ok">All tests passed ✓ (${s.passed})</span>` :
                                          `<span class="warn">No tests detected</span>`;
          showTestResultsModal(c.label, txt, summary);
        } catch (e) {
          err("bulk load failed", e);
          showTestResultsModal(c.label, `Could not load results: ${e.message||e}`, "");
        }
      });
      // fire & forget; UI is modal-based
      Promise.allSettled(tasks);
    });
    verifyAllBtn.after(loadAllBtn);
  }

  const notes = "Checks performed:\n" +
    "• Code at proxy address (non-zero bytecode)\n" +
    "• EIP-1967 implementation slot → implementation address\n" +
    "• Code at implementation address\n" +
    "• Admin slot (informational)\n" +
    "Notes: RPC-only; global limiter; exponential backoff; sequential verify-all; no wallet required.";
  const tn = byId("tech-notes"); if (tn) tn.textContent = notes;
});
