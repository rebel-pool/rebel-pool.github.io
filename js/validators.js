// For the Future (Hopefully a working Plkaceholde)

const NETWORK = "testnet";
const CHAIN_ID_DEC = 10143;
const EXPLORER_ADDR = "https://testnet.monadscan.com/address/";

const POOL_ADDRESS    = "0x25E24c54e65a51aa74087B8EE44398Bb4AB231Dd";
const POOL_ABI = ["function paused() view returns (bool)"];

const REFERENCE_RPC = "https://testnet-rpc.monad.xyz/";

const NODES = [
  { name: "Monad Public RPC", rpc: "https://testnet-rpc.monad.xyz/" }
  // here add nodes as comes on line !! 
];

// RPC guards -> gentle
const QUERY_TIMEOUT_MS = 2500;
const SLEEP_MS_ON_429  = 200;
const AUTO_REFRESH_MS  = 0; 

let providerRef;
let walletProvider, signer, userAddr, pool;
let endpoints = [...NODES];
let autoTimer = null;

const $ = (id) => document.getElementById(id);
const rowsEl = $("probe-rows");

// Not sure if needed lets see
async function bootWalletHeader() {
  $("connect-btn").style.display = "block";
  $("wallet-address").style.display = "none";

  if (!window.ethereum) return;

  const accts = await window.ethereum.request({ method: "eth_accounts" });
  if (accts.length > 0) await connectWallet();

  $("connect-btn").onclick = connectWallet;
  window.ethereum.on?.("accountsChanged", () => location.reload());
  window.ethereum.on?.("chainChanged",   () => location.reload());
}

async function connectWallet() {
  if (!window.ethereum) { alert("No wallet found (install MetaMask)"); return; }
  await ethereum.request({ method: "eth_requestAccounts" });

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

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
function nowISO(){ return new Date().toISOString().replace('T',' ').split('.')[0]; }

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))
  ]);
}

async function jsonRpcBlockNumber(rpcUrl) {
  const prov = new ethers.providers.JsonRpcProvider(rpcUrl, { name: "monad-testnet", chainId: 10143 });
  try {
    const n = await withTimeout(prov.getBlockNumber(), QUERY_TIMEOUT_MS);
    return { ok: true, block: n };
  } catch (e) {
    const msg = (e?.message || "").toLowerCase();
    if (msg.includes("too many requests") || e?.code === -32080) {
      await sleep(SLEEP_MS_ON_429);
      try {
        const n2 = await withTimeout(prov.getBlockNumber(), QUERY_TIMEOUT_MS);
        return { ok: true, block: n2, rate: true };
      } catch (e2) {
        return { ok: false, err: "rate-limited" };
      }
    }
    if (msg.includes("timeout") || msg.includes("failed to fetch")) {
      return { ok: false, err: "timeout" };
    }
    return { ok: false, err: msg || "error" };
  }
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
      lagStr = lag.toString();

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
      renderRows(endpoints.map(e => ({...e})), refBlock);
    };
  });
}

async function measureLatency(rpcUrl) {
  const t0 = performance.now();
  const res = await jsonRpcBlockNumber(rpcUrl);
  const t1 = performance.now();
  if (res.ok) res.latency = Math.round(t1 - t0);
  return res;
}

async function probeAll() {
  $("btn-refresh").disabled = true;
  $("ref-rpc").textContent = REFERENCE_RPC;
  $("ref-updated").textContent = "Updating…";

  const refRes = await measureLatency(REFERENCE_RPC);
  const refBlock = refRes.ok ? refRes.block : 0;
  $("ref-block").textContent = refBlock ? `#${refBlock}` : "—";
  $("ref-updated").textContent = nowISO();

  const display = endpoints.map(ep => ({ name: ep.name, rpc: ep.rpc, ok: false }));
  renderRows(display, refBlock);

  for (let i = 0; i < endpoints.length; i++) {
    const ep = endpoints[i];
    const res = await measureLatency(ep.rpc);
    display[i] = { name: ep.name, rpc: ep.rpc, ...res };
    renderRows(display, refBlock);
  }

try {
    const prov = walletProvider || new ethers.providers.JsonRpcProvider(REFERENCE_RPC, { staticNetwork: true });
    const poolRO = new ethers.Contract(POOL_ADDRESS, POOL_ABI, prov);
    const paused = await withTimeout(poolRO.paused(), QUERY_TIMEOUT_MS).catch(() => null);
    $("wiring-paused").textContent = paused === null ? "—" : (paused ? "Yes" : "No");
  } catch (_) {
    $("wiring-paused").textContent = "—";
  }

  $("btn-refresh").disabled = false;
}

async function probeOne(idx) {
  $("ref-updated").textContent = "Updating…";
  const refRes = await measureLatency(REFERENCE_RPC);
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
  $("btn-add-endpoint").onclick = () => {
    const name = $("inp-new-name").value.trim() || "Custom RPC";
    const rpc  = $("inp-new-rpc").value.trim();
    if (!rpc || !/^https?:\/\//i.test(rpc)) {
      alert("Enter a valid RPC URL (https://...)");
      return;
    }
    endpoints.push({ name, rpc });
    $("inp-new-name").value = "";
    $("inp-new-rpc").value = "";
    // show immediately
    renderRows(endpoints.map(e => ({...e})), 0);
  };
}

function startAuto() {
  if (AUTO_REFRESH_MS > 0) {
    stopAuto();
    autoTimer = setInterval(probeAll, AUTO_REFRESH_MS);
  }
}
function stopAuto() {
  if (autoTimer) clearInterval(autoTimer);
  autoTimer = null;
}

async function init() {
  $("ref-rpc").textContent = REFERENCE_RPC;
  $("btn-refresh").onclick = probeAll;
  wireAddEndpoint();
  await bootWalletHeader();
  await probeAll();
  startAuto();
}

window.addEventListener("DOMContentLoaded", init);
