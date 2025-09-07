
renderNetworkSelector("network-select", () => location.reload());
const cfg = getNetConfig();
const explorerBase = cfg.explorer;

const CONTRACTS = [
  {
    key: "POOL",
    label: "StakePoolCore (Proxy)",
    addr: cfg.pool,
    github: "https://rebel-pool.github.io/contracts/StakePoolCore.sol",
    compiler: "Solidity 0.8.24<br>Optimizer: 200",
    test: "https://rebel-pool.github.io/contracts/tests/StakePoolCore.t.sol",
    testResults: "/contracts/tests/StakePoolCore_test_results.txt"
  },
  {
    key: "AQUA",
    label: "AquaMON (Proxy)",
    addr: cfg.aquamon,
    github: "https://rebel-pool.github.io/contracts/AquaMON.sol",
    compiler: "Solidity 0.8.24<br>Optimizer: 200",
    test: "https://rebel-pool.github.io/contracts/tests/AquaMON.t.sol",
    testResults: "/contracts/tests/AquaMON_test_results.txt"
  },
  {
    key: "ARC",
    label: "ArcMON (Proxy)",
    addr: cfg.arcmon,
    github: "https://rebel-pool.github.io/contracts/ArcMON.sol",
    compiler: "Solidity 0.8.24<br>Optimizer: 200",
    test: "https://rebel-pool.github.io/contracts/tests/ArcMON.t.sol",
    testResults: "/contracts/tests/ArcMON_test_results.txt"
  }
];

(function buildTable() {
  const tbody = document.querySelector("#truth-table tbody");
  tbody.innerHTML = CONTRACTS.map((c, i) => `
<tr>
  <td><b>${c.label}</b></td>
  <td>
    <a id="addr-${c.key.toLowerCase()}" href="${explorerBase}/address/${c.addr}" target="_blank" style="color:#00308f;">
      ${c.addr}
    </a>
  </td>
  <td><a href="${c.github}" target="_blank" style="color:#007642;">View on GitHub</a></td>
  <td>${c.compiler}</td>
  <td><a href="${c.test}" target="_blank">View test</a></td>
  <td>
    <a href="${c.testResults}" target="_blank">Open</a>
    &nbsp;|&nbsp;
    <button class="stake-btn" style="padding:2px 8px;font-size:12px;" onclick="loadResult('${c.key}')">Show inline</button>
    <div id="res-${c.key.toLowerCase()}" class="report muted"></div>
  </td>
  <td>
    <button class="stake-btn" onclick="verifyContract('${c.key}','verify-result-${i+1}')">Verify Now</button>
    <div class="verify-result" id="verify-result-${i+1}"></div>
  </td>
</tr>
`).join("");
})();

const CHAIN_ID = cfg.chainId || 10143;
const RPCS = [cfg.rpc]; // Add fallback RPCs whan there are some !!

const SLOT_IMPLEMENTATION = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const SLOT_ADMIN          = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";

//============ UTILS ============
function esc(s){ return (s||"").toString().replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;', '>':'&gt;'}[c])); }
function byId(id){ return document.getElementById(id); }
function fmtAddr(raw32) { return ethers.getAddress("0x" + raw32.slice(26)); }

//============ EIP-1967 / PROXY VERIFIER ============
async function getProvider() {
  if (window.ethereum) {
    try {
      const p = new ethers.BrowserProvider(window.ethereum);
      const net = await p.getNetwork();
      if (Number(net.chainId) === CHAIN_ID) return p;
    } catch {}
  }
  for (const url of RPCS) {
    try {
      const p = new ethers.JsonRpcProvider(url, CHAIN_ID, { staticNetwork:true });
      await p.getBlockNumber();
      return p;
    } catch {}
  }
  throw new Error("No RPC available");
}

async function checkAddress(provider, proxyAddr) {
  const res = { proxy: proxyAddr, hasCode:false, impl:null, implHasCode:false, admin:null, errors:[] };
  try {
    const code = await provider.getCode(proxyAddr);
    res.hasCode = (code && code !== "0x");
  } catch (e) {
    res.errors.push("code(proxy) error: " + e.message);
  }
  try {
    const rawImpl = await provider.getStorage(proxyAddr, SLOT_IMPLEMENTATION);
    if (rawImpl && rawImpl !== ethers.ZeroHash) {
      res.impl = fmtAddr(rawImpl);
      try {
        const codeImpl = await provider.getCode(res.impl);
        res.implHasCode = (codeImpl && codeImpl !== "0x");
      } catch (e) {
        res.errors.push("code(impl) error: " + e.message);
      }
    }
  } catch (e) {
    res.errors.push("impl slot read error: " + e.message);
  }
  try {
    const rawAdmin = await provider.getStorage(proxyAddr, SLOT_ADMIN);
    if (rawAdmin && rawAdmin !== ethers.ZeroHash) res.admin = fmtAddr(rawAdmin);
  } catch (e) {
    // //ignore
  }
  return res;
}
function renderResult(containerId, label, r) {
  const parts = [];
  parts.push(`<b>${label}</b> — ${esc(r.proxy)}`);
  if (!r.hasCode) {
    parts.push(`<div class="err">No code at proxy address</div>`);
  } else {
    parts.push(`<div class="ok">Proxy code OK</div>`);
  }
  if (r.impl) {
    parts.push(`<div>Implementation: ${esc(r.impl)}</div>`);
    parts.push(r.implHasCode ? `<div class="ok">Implementation code OK</div>` : `<div class="err">No code at implementation</div>`);
  } else {
    parts.push(`<div class="warn">Implementation slot not readable or empty</div>`);
  }
  if (r.admin) {
    parts.push(`<div class="muted">Admin: ${esc(r.admin)}</div>`);
  }
  if (r.errors.length) {
    parts.push(`<div class="err">${esc(r.errors.join(" | "))}</div>`);
  }
  byId(containerId).innerHTML = parts.join("\n");
}


async function verifyContract(key, containerId) {
  byId(containerId).innerHTML = `<span class="muted">Verifying on-chain…</span>`;
  try {
    const contract = CONTRACTS.find(x => x.key === key);
    if (!contract) throw new Error("Unknown contract");
    const provider = await getProvider();
    const r = await checkAddress(provider, contract.addr);
    renderResult(containerId, contract.label, r);
  } catch (e) {
    byId(containerId).innerHTML = `<span class="err">Error: ${esc(e.message)}</span>`;
  }
}
async function verifyAll() {
  const container = byId("verify-all-result");
  container.innerHTML = `<span class="muted">Verifying all…</span>`;
  try {
    const provider = await getProvider();
    const outs = await Promise.all(CONTRACTS.map(async c => {
      const r = await checkAddress(provider, c.addr);
      return `<div class="ok"><b>${esc(c.label)}</b> — ${esc(r.proxy)} ${r.hasCode ? "✓ proxy" : "✗ proxy"} ${r.implHasCode ? "✓ impl" : "✗ impl"}</div>`
        + (r.errors.length ? `<div class="err">${esc(r.errors.join(" | "))}</div>` : "");
    }));
    container.innerHTML = outs.join("\n");
  } catch (e) {
    container.innerHTML = `<span class="err">Error: ${esc(e.message)}</span>`;
  }
}
byId("verify-all").addEventListener("click", verifyAll);

//============ TEST RESULT LOADER ============
const TEST_FILES = Object.fromEntries(CONTRACTS.map(c => [c.key, c.testResults]));
function summarizeForge(txt){
  // Strip ANSI color codes just in case
  txt = txt.replace(/\x1B\[[0-9;]*m/g, '');
  const lines = txt.split(/\r?\n/);

  let passed = 0, failed = 0, warnings = 0;

  for (const ln of lines) {
    // Count only bracketed tags at start of the line
    if (/^\s*\[(?:PASS|OK)\]/i.test(ln))  passed++;
    if (/^\s*\[(?:FAIL|ERROR)\]/i.test(ln)) failed++;
    if (/warning:/i.test(ln)) warnings++;
  }

  // Fallback: if no bracket tags were found, look for summary lines
  if (passed === 0 && failed === 0) {
    const mFail = txt.match(/Failing tests:\s*(\d+)/i);
    if (mFail) failed += Number(mFail[1]);
    const mPass = txt.match(/Passing:\s*(\d+)/i);
    if (mPass) passed += Number(mPass[1]);
  }

  return { passed, failed, warnings };
}


async function loadResult(key){
  const url = TEST_FILES[key];
  const contract = CONTRACTS.find(c => c.key === key);
  if (!url || !contract) return;

  try {
    const resp = await fetch(url, { cache: "no-store" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const txt = await resp.text();
    const s = summarizeForge(txt);

    let summary =
      (s.failed>0) ? `<span class="err">FAILED: ${s.failed}</span>` :
      (s.passed>0) ? `<span class="ok">All tests passed ✓ (${s.passed})</span>` :
      `<span class="warn">No tests detected</span>`;

    // Instead of injecting into table cell, open modal
    showTestResultsModal(contract.label, txt, summary);

  } catch (e) {
    showTestResultsModal(contract.label, `Could not load results: ${e.message || e}`, "");
  }
}

const verifyAllBtn = byId("verify-all");
if (verifyAllBtn) {
  const btn = document.createElement("button");
  btn.id = "load-all-results";
  btn.className = "stake-btn";
  btn.style.marginLeft = "8px";
  btn.textContent = "Load All Results";
  btn.addEventListener("click", () => {
    CONTRACTS.forEach(c => loadResult(c.key));
  });
  verifyAllBtn.after(btn);
}

byId("tech-notes").textContent =
  "Checks performed:\n" +
  "• Code at proxy address (non-zero bytecode)\n" +
  "• EIP-1967 implementation slot → implementation address\n" +
  "• Code at implementation address\n" +
  "• Admin slot (informational)\n" +
  "Notes: Runs only on click; no wallet needed; uses config-based RPC fallback.";

window.verifyContract = verifyContract;
window.loadResult = loadResult;

function showTestResultsModal(contractLabel, testText, summary) {
  let modal = document.createElement("div");
  modal.className = "modal";
  modal.innerHTML = `
    <div class="modal-content" style="text-align:left; max-width:900px; width:95%; max-height:85vh; overflow:auto;">
      <h2 style="margin-top:0;">${contractLabel} — Test Results</h2>
      <div style="margin: 10px 0; font-weight:bold;">
        ${summary}
      </div>
      <pre style="background:#f7f7f7; padding:10px; border:1px solid #ccc; white-space:pre-wrap; font-size:12px; line-height:1.45;">${esc(testText)}</pre>
      <div style="text-align:right; margin-top:12px;">
        <button onclick="navigator.clipboard.writeText(\`${esc(testText)}\`)">Copy Log</button>
        <button onclick="this.closest('.modal').remove()">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
}