// js/wrap.js — ethers v5.7.x (UMD) – Rebel Pool
// RO offload + wallet single-flight + rate-limit backoff + fee-bump retries

const AUTO_CLOSE_MS = 1600;
const STEP_DELAY    = 350;

// ===== ABIs =====
const AQUAMON_ABI = [
  "function approve(address spender, uint256 amount) public returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function allowance(address owner, address spender) view returns (uint256)"
];
const ARCMON_ABI = [
  "function wrap(uint256 aquaAmount, address to) public returns (uint256)",
  "function unwrap(uint256 arcAmount, address to) public returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function exchangeRate() view returns (uint256)"
];

// ===== State =====
let provider, signer, injected, userAddr;
let roProvider = null; // read-only RPC
let stmon, arcmon;     // wallet write contracts
let stmonRO, arcmonRO; // read-only contracts
let stmonDecimals = 18, arcmonDecimals = 18;
let CHAIN_ID_DEC = 10143;

// ===== DOM/helpers =====
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function escapeHtml(s){ return String(s).replace(/[&<>"']/g, m=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[m])); }

async function getExplorer(type) {
  const cfg = await getNetConfig();
  if (!cfg.explorer) return "#";
  if (type === "tx")   return `${cfg.explorer}/tx/`;
  if (type === "addr") return `${cfg.explorer}/address/`;
  if (type === "tok")  return `${cfg.explorer}/token/`;
  return "#";
}
async function linkTx(hash, text) { return `<a href="${await getExplorer("tx")}${hash}" target="_blank" rel="noopener">${text}</a>`; }
async function linkAddr(addr, text){ return `<a href="${await getExplorer("addr")}${addr}" target="_blank" rel="noopener">${text}</a>`; }

// ===== Rate-limit UI (informational only) =====
const RateLimitUI = (() => {
  let modal, msgEl;
  function ensure() {
    if (modal) return;
    modal = document.createElement('div');
    modal.className = 'modal';
    modal.style.display = 'none';
    modal.innerHTML = `
      <div class="modal-content" style="max-width:520px">
        <h3 style="margin:0 0 8px">Network is busy</h3>
        <div id="rl-msg" class="muted" style="line-height:1.5"></div>
        <div class="muted" style="margin-top:10px; font-size:.9em">
          MetaMask controls submission. If no popup is visible, click the MetaMask icon to open it.
        </div>
      </div>`;
    document.body.appendChild(modal);
    msgEl = modal.querySelector('#rl-msg');
  }
  async function onBackoff({ method, attempt, maxTries, delayMs }) {
    ensure();
    modal.style.display = 'flex';
    const secs = Math.ceil(delayMs/1000);
    msgEl.innerHTML = `RPC rate-limit on <code>${escapeHtml(method)}</code>. Retrying in <b>${secs}s</b> (attempt ${attempt+1}/${maxTries}).`;
    await sleep(delayMs);
  }
  function hide(){ if (modal) modal.style.display = 'none'; }
  return { onBackoff, hide };
})();

// ===== Wallet RPC wrapper (single-flight + cooldown + RO offload) =====
const MM_THROTTLE_DEFAULTS = { pre: 600, post: 600, base: 3000, maxTries: 4, jitter: 500, debug: true };
const OFFLOAD_TO_RO = new Set([
  "eth_blockNumber","eth_getBlockByNumber","eth_getBlockByHash",
  "eth_gasPrice","eth_maxPriorityFeePerGas","eth_feeHistory",
  "eth_getTransactionByHash","eth_getTransactionReceipt",
  "eth_call","eth_estimateGas","eth_getBalance","eth_getCode",
  "eth_getTransactionCount" // important
]);
let __walletQueue = Promise.resolve();
let __walletCooldownUntil = 0;
const nowMs = () => Date.now();

function wrapInjectedRequest(inj, opts = {}) {
  if (!inj || typeof inj.request !== "function") return inj;
  if (inj.__rp_wrapped_request) return inj;
  const o = { ...MM_THROTTLE_DEFAULTS, ...opts };
  const original = inj.request.bind(inj);
  inj.__rp_wrapped_request = true;

  inj.request = (args) => {
    __walletQueue = __walletQueue.then(async () => {
      const method = args?.method || "unknown";
      const params = args?.params || [];

      // global cooldown
      const waitMs = Math.max(0, __walletCooldownUntil - nowMs());
      if (waitMs > 0 && o.debug) console.debug("[mmwrap] global-cooldown", waitMs, "ms");
      if (waitMs > 0) await sleep(waitMs);

      // RO offload
      if (OFFLOAD_TO_RO.has(method) && roProvider) {
        try {
          if (o.debug) console.debug("[mmwrap→ro]", method, params);
          const res = await roProvider.send(method, params);
          if (o.debug) console.debug("[mmwrap←ro]", method, "ok");
          RateLimitUI.hide();
          await sleep(o.post);
          return res;
        } catch (e) { if (o.debug) console.debug("[mmwrap ro-fallback]", method, e); }
      }

      const pre = o.pre + Math.random() * o.jitter;
      if (o.debug) console.debug("[mmwrap] →", method, params);
      await sleep(pre);

      let attempt = 0;
      while (true) {
        try {
          const res = await original(args);
          if (o.debug) console.debug("[mmwrap] ←", method, "ok");
          RateLimitUI.hide();
          await sleep(o.post);
          return res;
        } catch (e) {
          const msg = (e?.message || "") + " " + JSON.stringify(e?.data || {});
          const isRL = /429|rate limit|-32005|-32603/i.test(msg) || e?.code === -32005 || e?.code === -32603;
          if (isRL && attempt + 1 < o.maxTries) {
            const delay = o.base * Math.pow(2, attempt) + Math.random() * o.jitter; // 3s,6s,12s
            console.debug("[mmwrap] rate-limited → backoff", Math.round(delay), "ms");
            __walletCooldownUntil = nowMs() + Math.min(delay, 12000);
            await RateLimitUI.onBackoff({ method, attempt, maxTries: o.maxTries, delayMs: delay });
            attempt++;
            continue;
          }
          RateLimitUI.hide();
          throw e;
        }
      }
    });
    return __walletQueue;
  };
  return inj;
}

// ===== Config & RO provider =====
async function getNetConfig() {
  // Provided by chain.js
  if (!window.getNetConfig) return {};
  const out = window.getNetConfig();
  return (out && typeof out.then === "function") ? await out : out;
}
function pickRpc(cfg) {
  const list = [];
  if (Array.isArray(cfg?.rpcs)) list.push(...cfg.rpcs);
  if (cfg?.rpc) list.push(cfg.rpc);
  return (list.find(u => typeof u === "string" && u.trim().length) || "").trim();
}
function makeReadProvider(cfg) {
  const url = pickRpc(cfg);
  if (!url) return null;
  const chainId = cfg?.chainId || CHAIN_ID_DEC;
  return new ethers.providers.JsonRpcProvider(url, { name: "monad-testnet", chainId });
}

// ===== Fee helpers =====
const FEE_HINT_HTML = `<br><small class="muted">
Fees look low/volatile. If the wallet declines as “fee too low”, wait ~30–60s and try again.
</small>`;

function isFeeTooLow(err) {
  const s = String(err?.reason || err?.error?.message || err?.message || err || "").toLowerCase();
  return /fee too low|maxfeepergas|max priority fee|underpriced|replacement/i.test(s);
}
async function getNetworkFeeGuessSafe() {
  let base = null, tip = null;

  try {
    const latest = await roProvider.send("eth_getBlockByNumber", ["latest", false]);
    if (latest?.baseFeePerGas) base = ethers.BigNumber.from(latest.baseFeePerGas);
  } catch {}
  try {
    const tipHex = await roProvider.send("eth_maxPriorityFeePerGas", []);
    if (tipHex) tip = ethers.BigNumber.from(tipHex);
  } catch {
    tip = ethers.utils.parseUnits("1.5", "gwei");
  }
  if (!tip || tip.isZero()) tip = ethers.utils.parseUnits("1.5", "gwei");

  if (base) {
    const maxFeePerGas = base.mul(12).div(10).add(tip); // +20%
    return { eip1559: true, maxFeePerGas, maxPriorityFeePerGas: tip };
  }
  const gpHex = await roProvider.send("eth_gasPrice", []);
  const gasPrice = ethers.BigNumber.from(gpHex).mul(5).div(4); // +25%
  return { eip1559: false, gasPrice };
}
function bumpFeeOverrides(fee, factor = 1.25, tipBumpGwei = 1) {
  if (fee.eip1559) {
    const maxFeePerGas = fee.maxFeePerGas.mul(Math.round(factor*100)).div(100);
    const maxPriorityFeePerGas = fee.maxPriorityFeePerGas.add(ethers.utils.parseUnits(String(tipBumpGwei), 'gwei'));
    return { type: 2, maxFeePerGas, maxPriorityFeePerGas };
  } else {
    const gasPrice = fee.gasPrice.mul(Math.round(factor*100)).div(100);
    return { gasPrice };
  }
}
// tries once, then up to 2 fee-bumped retries—counter shown only on retries
async function sendTxWithRetry(fnSend, baseFee, gasLimit, label) {
  let overrides = baseFee.eip1559
    ? { type: 2, maxFeePerGas: baseFee.maxFeePerGas, maxPriorityFeePerGas: baseFee.maxPriorityFeePerGas }
    : { gasPrice: baseFee.gasPrice };
  if (gasLimit && !overrides.gasLimit) overrides.gasLimit = gasLimit;

  const MAX_RETRIES = 2;
  let attempt = 0;

  while (true) {
    try {
      if (label && attempt === 0) {
        openStatus(label, `Submitting…${FEE_HINT_HTML}`);
      }
      const tx = await fnSend(overrides);
      return tx;
    } catch (e) {
      if (!isFeeTooLow(e) || attempt >= MAX_RETRIES) throw e;
      attempt++;
      const factor  = attempt === 1 ? 1.35 : 1.6;
      const tipBump = attempt === 1 ? 1    : 2;
      overrides = { ...bumpFeeOverrides(baseFee, factor, tipBump), gasLimit };
      openStatus(label, `Fee too low — retrying with a higher tip (attempt ${attempt+1}/${MAX_RETRIES+1})…${FEE_HINT_HTML}`);
      // loop
    }
  }
}

// ===== Modal helpers =====
function openStatus(title, body) {
  const modal = $("wrap-modal");
  const msg   = $("wrap-modal-msg");
  msg.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
      <div style="width:10px;height:10px;border-radius:50%;background:#1a73e8;animation:pulse 1.2s infinite;"></div>
      <b>${escapeHtml(title)}</b>
    </div>
    <div>${body || ""}</div>
    <style>@keyframes pulse{0%{opacity:.3}50%{opacity:1}100%{opacity:.3}}</style>
  `;
  modal.style.display = "flex";
}
async function updateStatus(body) {
  const msg = $("wrap-modal-msg");
  if (!msg) return;
  const container = msg.querySelector("div:nth-child(2)");
  if (container) container.innerHTML = body;
}
function closeWrapModal(){ const modal = $("wrap-modal"); if (modal) modal.style.display = "none"; }
function autoCloseModal(){ setTimeout(closeWrapModal, AUTO_CLOSE_MS); }
window.closeWrapModal = closeWrapModal;

// ===== Wallet connect (hardened) =====
function getInjectedProviders() {
  const eth = window.ethereum;
  if (!eth) return [];
  if (Array.isArray(eth.providers)) return eth.providers;
  return [eth];
}
function pickInjectedProvider() {
  const list = getInjectedProviders();
  const mew = list.find(p => p && (p.isMEW || p?.providerInfo?.name === "MEW"));
  if (mew) return { provider: mew, name: "MEW" };
  const mm = list.find(p => p && p.isMetaMask) || (window.ethereum?.isMetaMask ? window.ethereum : null);
  if (mm) return { provider: mm, name: "MetaMask" };
  return list[0] ? { provider: list[0], name: "Injected" } : null;
}
async function ensureMonadNetwork(inj, cfg) {
  const wantHex = "0x" + (cfg.chainId || CHAIN_ID_DEC).toString(16);
  const local = inj && typeof inj.chainId === "string" ? inj.chainId : null;
  if (local && local.toLowerCase() === wantHex.toLowerCase()) return wantHex;
  try {
    const current = await inj.request({ method: "eth_chainId" });
    if (String(current).toLowerCase() === wantHex.toLowerCase()) return wantHex;
  } catch {}
  try {
    await inj.request({ method: "wallet_switchEthereumChain", params: [{ chainId: wantHex }] });
    return wantHex;
  } catch (e) {
    if (e && (e.code === 4902 || /unrecognized chain/i.test(e.message || ""))) {
      const urls = (Array.isArray(cfg.rpcs) ? cfg.rpcs : []).concat(cfg.rpc ? [cfg.rpc] : []).filter(Boolean);
      await inj.request({
        method: "wallet_addEthereumChain",
        params: [{ chainId: wantHex, chainName: cfg.label || "Monad Testnet",
          nativeCurrency: { name: cfg?.coin?.native?.name || "Monad", symbol: cfg?.coin?.native?.symbol || "MON", decimals: 18 },
          rpcUrls: urls, blockExplorerUrls: cfg.explorer ? [cfg.explorer] : [] }]
      });
      await inj.request({ method: "wallet_switchEthereumChain", params: [{ chainId: wantHex }] });
      return wantHex;
    }
    if (e && e.code === 4001) throw new Error("User rejected the network switch.");
    throw e;
  }
}

async function connectWallet() {
  const cfg = await getNetConfig();
  CHAIN_ID_DEC = cfg?.chainId || CHAIN_ID_DEC;

  // RO provider first
  roProvider = makeReadProvider(cfg);

  const pick = pickInjectedProvider();
  if (!pick) { alert("No wallet found. Please install MEW or MetaMask."); return; }
  injected = wrapInjectedRequest(pick.provider);

  try { await ensureMonadNetwork(injected, cfg); }
  catch (e) { console.error("[wrap] ensureMonadNetwork:", e); alert("Could not switch/add Monad Testnet in your wallet."); return; }

  try { await injected.request({ method: "eth_requestAccounts" }); }
  catch (e) {
    if (e?.code === -32002) alert("Wallet is already processing a request. Open your wallet and finish the pending prompt.");
    else if (e?.code === 4001) alert("You rejected the connection request.");
    else alert("Wallet connection failed.");
    return;
  }

  provider = new ethers.providers.Web3Provider(injected, "any");
  signer   = provider.getSigner();
  userAddr = await signer.getAddress();

  stmon  = new ethers.Contract(cfg.aquamon, AQUAMON_ABI, signer);
  arcmon = new ethers.Contract(cfg.arcmon,  ARCMON_ABI,  signer);

  // read-side contracts
  if (roProvider) {
    stmonRO = new ethers.Contract(cfg.aquamon, AQUAMON_ABI, roProvider);
    arcmonRO = new ethers.Contract(cfg.arcmon,  ARCMON_ABI,  roProvider);
  } else {
    stmonRO = stmon; arcmonRO = arcmon;
  }

  try {
    const [d1,d2] = await Promise.all([
      stmonRO.decimals().catch(()=>18),
      arcmonRO.decimals().catch(()=>18),
    ]);
    stmonDecimals = d1; arcmonDecimals = d2;
  } catch {}

  $("connect-btn").style.display = "none";
  $("wallet-address").style.display = "block";
  $("wallet-address").innerHTML = `Connected: ${await linkAddr(userAddr, userAddr.slice(0,6)+"…"+userAddr.slice(-4))}`;

  if (injected?.on) {
    injected.on('accountsChanged', () => location.reload());
    injected.on('chainChanged',   () => location.reload());
  }
  await refreshAll();
}

// ===== Balances / rate =====
async function refreshAll() {
  if (!stmonRO || !arcmonRO || !userAddr) return;
  try {
    const [stBal, wstBal, exch] = await Promise.all([
      stmonRO.balanceOf(userAddr),
      arcmonRO.balanceOf(userAddr),
      arcmonRO.exchangeRate()
    ]);
    $("balance-stmon").textContent  = parseFloat(ethers.utils.formatUnits(stBal,  stmonDecimals)).toFixed(4);
    $("balance-wstmon").textContent = parseFloat(ethers.utils.formatUnits(wstBal, arcmonDecimals)).toFixed(4);
    $("exchange-rate").textContent  = (Number(exch) / 1e18).toFixed(6);
  } catch (e) { console.warn("[wrap] refreshAll:", e); }
}

// ===== Allowance (with fee + retry) =====
async function ensureAllowance(token, owner, spender, amountBN) {
  const current = await token.callStatic.allowance(owner, spender).catch(()=>ethers.constants.Zero);
  if (current.gte(amountBN)) return;

  const fee = await getNetworkFeeGuessSafe();
  // reset to 0 first if needed (some ERC20s require)
  if (!current.isZero()) {
    const est0 = await stmonRO.estimateGas.approve(spender, ethers.constants.Zero, { from: owner }).catch(()=>ethers.BigNumber.from(45000));
    const tx0  = await sendTxWithRetry(
      (ov) => token.approve(spender, ethers.constants.Zero, { gasLimit: est0.mul(118).div(100), ...ov }),
      fee,
      est0.mul(118).div(100),
      "Resetting allowance to 0…"
    );
    await tx0.wait();
    await sleep(STEP_DELAY);
  }

  const est = await stmonRO.estimateGas.approve(spender, amountBN, { from: owner }).catch(()=>ethers.BigNumber.from(65000));
  const tx  = await sendTxWithRetry(
    (ov) => token.approve(spender, amountBN, { gasLimit: est.mul(118).div(100), ...ov }),
    fee,
    est.mul(118).div(100),
    "Approving stMON for wrapping…"
  );
  await tx.wait();
}

// ===== Actions =====
async function wrapWstmon() {
  const cfg = await getNetConfig();
  const ui  = $("wrap-wstmon-status");
  try {
    const amountStr = $("wrap-wstmon-amount").value;
    if (!amountStr || isNaN(amountStr) || Number(amountStr) <= 0) { ui.textContent = "Enter amount"; return; }
    const parsed = ethers.utils.parseUnits(amountStr, stmonDecimals);

    openStatus("Wrapping stMON → wstMON", "Checking balance & allowance…");
    await ensureAllowance(stmon, userAddr, cfg.arcmon, parsed);
    await sleep(STEP_DELAY);

    const fee = await getNetworkFeeGuessSafe();
    const est = await arcmonRO.estimateGas.wrap(parsed, userAddr, { from: userAddr }).catch(()=>ethers.BigNumber.from(140000));
    const gas = est.mul(118).div(100);

    const tx = await sendTxWithRetry(
      (ov) => arcmon.wrap(parsed, userAddr, { gasLimit: gas, ...ov }),
      fee,
      gas,
      "Wrapping stMON → wstMON"
    );

    updateStatus("Transaction sent. Waiting for confirmation…");
    await tx.wait();
    ui.innerHTML = `Wrapped! ${await linkTx(tx.hash, "view tx")}`;
    $("wrap-wstmon-amount").value = "";
    await refreshAll();
    autoCloseModal();
  } catch (err) {
    console.error("[wrap] wrap error:", err);
    ui.textContent = "Error: " + readableError(err);
    updateStatus(`<span style="color:#b00">${escapeHtml(readableError(err))}</span>`);
    autoCloseModal();
  }
}

async function unwrapWstmon() {
  const ui = $("unwrap-wstmon-status");
  try {
    const amountStr = $("unwrap-wstmon-amount").value;
    if (!amountStr || isNaN(amountStr) || Number(amountStr) <= 0) { ui.textContent = "Enter amount"; return; }
    const parsed = ethers.utils.parseUnits(amountStr, arcmonDecimals);

    openStatus("Unwrapping wstMON → stMON", "Submitting…"+FEE_HINT_HTML);

    const fee = await getNetworkFeeGuessSafe();
    const est = await arcmonRO.estimateGas.unwrap(parsed, userAddr, { from: userAddr }).catch(()=>ethers.BigNumber.from(140000));
    const gas = est.mul(118).div(100);

    const tx  = await sendTxWithRetry(
      (ov) => arcmon.unwrap(parsed, userAddr, { gasLimit: gas, ...ov }),
      fee,
      gas,
      "Unwrapping wstMON → stMON"
    );

    updateStatus("Transaction sent. Waiting for confirmation…");
    await tx.wait();
    ui.innerHTML = `Unwrapped! ${await linkTx(tx.hash, "view tx")}`;
    $("unwrap-wstmon-amount").value = "";
    await refreshAll();
    autoCloseModal();
  } catch (err) {
    console.error("[wrap] unwrap error:", err);
    ui.textContent = "Error: " + readableError(err);
    updateStatus(`<span style="color:#b00">${escapeHtml(readableError(err))}</span>`);
    autoCloseModal();
  }
}

// ===== Max fill =====
async function fillMaxWrap() {
  if (!stmonRO || !userAddr) return;
  const bal = await stmonRO.balanceOf(userAddr);
  $("wrap-wstmon-amount").value = ethers.utils.formatUnits(bal, stmonDecimals);
}
async function fillMaxUnwrap() {
  if (!arcmonRO || !userAddr) return;
  const bal = await arcmonRO.balanceOf(userAddr);
  $("unwrap-wstmon-amount").value = ethers.utils.formatUnits(bal, arcmonDecimals);
}

// ===== UX / Errors =====
function friendlyRateLimit(err) {
  const s = (err?.message || "") + " " + JSON.stringify(err?.data || {});
  return /429|rate limit|-32005|-32603/i.test(s) || err?.code === -32005 || err?.code === -32603;
}
function readableError(err) {
  if (friendlyRateLimit(err)) return "The RPC is rate-limiting requests. We backoff and retry automatically. If it keeps failing, try again later.";
  if (isFeeTooLow(err)) return "Network rejected the fee as too low. We retried with a higher tip. If it still fails, wait ~30–60s and try again.";
  const raw = err?.error?.data ?? err?.data ?? err?.error?.message ?? err?.reason ?? err?.message ?? err;
  let s = typeof raw === "object" ? JSON.stringify(raw) : String(raw || "");
  s = s.replace(/^execution reverted:?/i, "").trim();
  return s || "Execution reverted.";
}

// ===== INIT =====
async function init() {
  if (window.renderNetworkSelector) renderNetworkSelector("network-select", () => location.reload());
  $("connect-btn").style.display = "block";
  $("wallet-address").style.display = "none";
  if (window.ethereum) {
    const accounts = await window.ethereum.request({ method: 'eth_accounts' }).catch(()=>[]);
    if (accounts.length > 0) await connectWallet();
  }
  $("connect-btn").onclick       = connectWallet;
  $("wrap-wstmon-btn").onclick   = wrapWstmon;
  $("unwrap-wstmon-btn").onclick = unwrapWstmon;
  $("wrap-max").onclick          = fillMaxWrap;
  $("unwrap-max").onclick        = fillMaxUnwrap;
}
window.addEventListener('DOMContentLoaded', init);
