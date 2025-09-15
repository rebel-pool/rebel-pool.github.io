// js/withdraw.js — ethers v5.7.x (UMD)
// Rate-limit hardened (RO reads), fee bump, clear low-fee guidance, and wiring checks
// Aligns with stake.js patterns

// ===== ABIs =====
const WMON_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function withdraw(uint256) public"
];
const POOL_ABI = [
  "function withdraw(uint256 assets, address to, address owner) public returns (uint256 shares)",
  "function convertToShares(uint256 assets) view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function maxWithdraw(address owner) view returns (uint256)",
  "function index() view returns (uint256)",
  "function underlying() view returns (address)",
  "function aquaToken() view returns (address)",
  "function paused() view returns (bool)"
];
const AQUAMON_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)"
];

// ===== State =====
let CFG = null;
let CHAIN_ID_DEC = 10143;

let provider = null;     // wallet-backed provider (MetaMask/MEW)
let signer   = null;
let injected = null;

let wmon = null, pool = null, aqua = null;         // write-side (wallet)
let roProvider = null;                              // read-only (public RPC)
let wmonRO = null, poolRO = null, aquaRO = null;    // read-side contracts

let user = null;
let wmonDec = 18, stDec = 18;
let busyWithdraw = false;

let EXPLORER_TX = "#";
let EXPLORER_ADDR = "#";
let EXPLORER_TOK = "#";

let WALLET_CHAIN_ID_HEX = null;

const ZERO = ethers.constants.Zero;
const MaxUint256 = ethers.constants.MaxUint256;
const STEP_DELAY = 400;
const FUNDS_DEBUG = true;

// ===== DOM/utils =====
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const esc = (s) => (s||"").toString().replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const fmtAddr = (a) => a ? `${a.slice(0,6)}…${a.slice(-4)}` : "";
function linkTx(hash, text){ return `<a href="${EXPLORER_TX}${hash}" target="_blank" rel="noopener">${esc(text)}</a>`; }
function linkAddr(addr, text){ return `<a href="${EXPLORER_ADDR}${addr}" target="_blank" rel="noopener">${esc(text)}</a>`; }

// Fee guidance hint (same text we use in stake.js)
const FEE_HINT_HTML = `<br><small class="muted">

</small>`;

// --- Rate-limit UX (informational) ---
const RateLimitUI = (() => {
  let modal, msgEl, timerId, stop = false;
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
          MetaMask controls the submission window. If no popup is visible,
          click the MetaMask browser icon to open it.
        </div>
      </div>`;
    document.body.appendChild(modal);
    msgEl = modal.querySelector('#rl-msg');
  }
  async function onBackoff({ method, attempt, maxTries, delayMs }) {
    ensure();
    modal.style.display = 'flex';
    const secs = Math.max(0, Math.ceil(delayMs/1000));
    msgEl.innerHTML =
      `RPC rate limit on <code>${esc(method)}</code> — waiting <b>${secs}s</b> before retry ${attempt+1} of ${maxTries}.`;
    await new Promise(r => setTimeout(r, delayMs));
  }
  function hide(){ if (modal) modal.style.display = 'none'; }
  return { onBackoff, hide };
})();

// --- MM request wrapper + RO offload ---
const MM_THROTTLE_DEFAULTS = { pre: 600, post: 600, base: 3000, maxTries: 4, jitter: 500, debug: true };

function getLocalChainIdHex(inj) {
  const hex = inj && typeof inj.chainId === "string" ? inj.chainId : null;
  return hex && /^0x[0-9a-f]+$/i.test(hex) ? hex : null;
}

const OFFLOAD_TO_RO = new Set([
  "eth_blockNumber",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_call",
  "eth_estimateGas",
  "eth_getBalance",
  "eth_getCode",
  "eth_getTransactionCount"  // << important
]);

let __walletQueue = Promise.resolve();
let __walletCooldownUntil = 0;

const nowMs = () => Date.now();



async function roSend(method, params = []) {
  if (!roProvider) throw new Error("RO provider not initialized");
  return await roProvider.send(method, params);
}


function wrapInjectedRequest(inj, opts = {}) {
  if (!inj || typeof inj.request !== "function") return inj;
  if (inj.__rp_wrapped_request) return inj;

  const o = { ...MM_THROTTLE_DEFAULTS, ...opts };
  const original = inj.request.bind(inj);
  inj.__rp_wrapped_request = true;
  inj.requestOriginal = original;

  inj.request = (args) => {
    __walletQueue = __walletQueue.then(async () => {
      const method = args?.method || "unknown";
      const params = args?.params || [];

      // If a global cooldown is active, wait
      const waitMs = Math.max(0, __walletCooldownUntil - nowMs());
      if (waitMs > 0 && o.debug) console.debug("[mmwrap] global-cooldown", waitMs, "ms");
      if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs));

      // RO offload for pure reads
      if (OFFLOAD_TO_RO.has(method) && roProvider) {
        try {
          if (o.debug) console.debug("[mmwrap→ro]", method, params);
          const res = await roProvider.send(method, params);
          if (o.debug) console.debug("[mmwrap←ro]", method, "ok");
          RateLimitUI.hide();
          await new Promise(r => setTimeout(r, o.post));
          return res;
        } catch (e) {
          if (o.debug) console.debug("[mmwrap ro-fallback]", method, e);
          // fall back to wallet
        }
      }

      const pre = o.pre + Math.random() * o.jitter;
      if (o.debug) console.debug("[mmwrap] →", method, params);
      await new Promise(r => setTimeout(r, pre));

      let attempt = 0;
      while (true) {
        try {
          const res = await original(args);
          if (o.debug) console.debug("[mmwrap] ←", method, "ok");
          RateLimitUI.hide();
          await new Promise(r => setTimeout(r, o.post));
          return res;
        } catch (e) {
          // MetaMask commonly wraps rate limit as -32603 with message “Request is being rate limited.”
          const msg = (e?.message || "") + " " + JSON.stringify(e?.data || {});
          const isRateLimited = /429|rate limit|-32005|-32603/i.test(msg) || e?.code === -32005 || e?.code === -32603;

          // Don’t hammer: long backoff and a short global cooldown for *next* call too
          if (isRateLimited && attempt + 1 < o.maxTries) {
            const delay = o.base * Math.pow(2, attempt) + Math.random() * o.jitter; // 3s, 6s, 12s...
            if (o.debug) console.debug("[mmwrap] rate-limited → backoff", Math.round(delay), "ms (attempt", attempt+2, "/", o.maxTries, ")");
            __walletCooldownUntil = nowMs() + Math.min(delay, 12000); // keep next call spaced-out
            await RateLimitUI.onBackoff({ method, attempt, maxTries: o.maxTries, delayMs: delay });
            attempt++;
            continue;
          }

          // Any other error or out of retries → surface
          if (o.debug) console.debug("[mmwrap] ✖", method, "error", e);
          RateLimitUI.hide();
          throw e;
        }
      }
    });
    return __walletQueue;
  };

  return inj;
}

// ===== Config / RPC helpers =====
async function resolveNetConfig() {
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

// ===== Wallet detection + network ensure =====
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
  const local = getLocalChainIdHex(inj);
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
      await inj.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: wantHex,
          chainName: cfg.label || "Monad Testnet",
          nativeCurrency: { name: cfg?.coin?.native?.name || "Monad", symbol: cfg?.coin?.native?.symbol || "MON", decimals: 18 },
          rpcUrls: (Array.isArray(cfg.rpcs) ? cfg.rpcs : []).concat(cfg.rpc ? [cfg.rpc] : []).filter(Boolean),
          blockExplorerUrls: cfg.explorer ? [cfg.explorer] : []
        }]
      });
      await inj.request({ method: "wallet_switchEthereumChain", params: [{ chainId: wantHex }] });
      return wantHex;
    }
    if (e && e.code === 4001) throw new Error("User rejected the network switch.");
    throw e;
  }
}

// ===== Error helpers =====
function isFeeTooLow(err) {
  const s = String(err?.reason || err?.error?.message || err?.message || err || "").toLowerCase();
  return /fee too low|maxfeepergas|max priority fee|underpriced|replacement/i.test(s);
}
function friendlyError(err) {
  const raw = err?.error?.data ?? err?.data ?? err?.error?.message ?? err?.reason ?? err?.message ?? err;
  let s = typeof raw === "object" ? JSON.stringify(raw) : String(raw || "");
  if (err?.code === "USER_ABORT_RATE_LIMIT") return "Stopped while the network was overloaded. Try again later from your wallet.";
  if (/(-32005|-32603)/.test(String(err?.code)) || /rate limit|429|too many requests/i.test(s)) {
    return "Request is being rate-limited by the RPC node.<br>Wait a minute and try again. Avoid double-clicking.";
  }
  if (err?.code === -32002 || /already processing/i.test(s)) return "Your wallet is already handling a request.<br>Open your wallet and complete/close the pending prompt.";
  if (err?.code === 4001 || /user rejected/i.test(s)) return "You rejected the request in your wallet.";
  if (/insufficient funds/i.test(s)) return "Insufficient MON for gas.";
  if (/nonce too low/i.test(s))     return "Wallet nonce is out of sync. Wait a moment or reset nonce, then retry.";
  if (/wrong network|chain id/i.test(s)) return "Wrong network selected in wallet. Please switch to Monad Testnet (10143).";
  if (isFeeTooLow(err)) {
    return "Network rejected the fee as too low. We retried with a higher tip automatically. " +
           "If it still fails, wait ~30–60s for fees to stabilize and try again.";
  }
  return esc(s || "Unknown error");
}
function showErrorModal(err) {
  const msg = friendlyError(err);
  updateModal(`Error: ${msg}<br><button onclick="closeModal()">Close</button>`);
  $("withdraw-status").textContent = `Error: ${msg.replace(/<br>/g, " ")}`;
}

// ===== Read-side init =====
function initReadSide() {
  roProvider = makeReadProvider(CFG);
  if (roProvider) {
    roProvider.pollingInterval = 10000;
    wmonRO = new ethers.Contract(CFG.wmon,  WMON_ABI,  roProvider);
    poolRO = new ethers.Contract(CFG.pool,  POOL_ABI,  roProvider);
    aquaRO = new ethers.Contract(CFG.aquamon, AQUAMON_ABI, roProvider);
  } else {
    wmonRO = poolRO = aquaRO = roProvider = null;
  }
}

// ===== Wiring sanity (RO only) =====
async function assertWiring() {
  if (!poolRO || !CFG) return;
  try {
    const [u, a] = await Promise.all([ poolRO.underlying(), poolRO.aquaToken() ]);
    const mismatch = u.toLowerCase() !== CFG.wmon.toLowerCase() || a.toLowerCase() !== CFG.aquamon.toLowerCase();
    if (mismatch) {
      showModal(
        "=> Address config mismatch. <=<br>" +
        `Pool.underlying(): ${linkAddr(u,u)}<br>` +
        `Pool.aquaToken(): ${linkAddr(a,a)}<br>` +
        "Update chain.js addresses and reload."
      );
      throw new Error("Address config mismatch");
    }
  } catch (e) { console.error("[withdraw] wiring check failed:", e); throw e; }
}

// ===== Modals =====
function showModal(msg) {
  const m = $("withdraw-modal");
  if (m) m.style.display = "flex";
  $("withdraw-modal-msg").innerHTML = msg;
}
function updateModal(msg, txHash) {
  $("withdraw-modal-msg").innerHTML = msg + (txHash ? `<br><a href="${EXPLORER_TX}${txHash}" target="_blank" rel="noopener">View on MonadScan</a>` : "");
}
function closeModal() { $("withdraw-modal").style.display = "none"; }

// ===== Wallet connect (hardened) =====
async function connectWallet() {
  if (!CFG) return;
  const pick = pickInjectedProvider();
  if (!pick) { alert("No wallet found (install MEW or MetaMask)"); return; }
  injected = wrapInjectedRequest(pick.provider);
  try { await ensureMonadNetwork(injected, CFG); }
  catch (e) { console.error("[withdraw] ensureMonadNetwork:", e); alert("Could not switch/add Monad Testnet in your wallet."); return; }

  try { await injected.request({ method: "eth_requestAccounts" }); }
  catch (e) {
    if (e?.code === -32002) alert("Wallet is already processing a request. Open your wallet and finish the pending prompt.");
    else if (e?.code === 4001) alert("You rejected the connection request.");
    else alert("Wallet connection failed.");
    return;
  }

  WALLET_CHAIN_ID_HEX = getLocalChainIdHex(injected) || WALLET_CHAIN_ID_HEX;

  provider = new ethers.providers.Web3Provider(injected, "any");
  provider.pollingInterval = 20000;
  provider.polling = false;

  let accounts = [];
  try { accounts = await injected.request({ method: "eth_accounts" }); } catch {}
  user = Array.isArray(accounts) && accounts[0] ? accounts[0] : null;
  if (!user) { alert("No account found in wallet."); return; }

  signer = provider.getSigner(user);

  wmon = new ethers.Contract(CFG.wmon,  WMON_ABI,  signer);
  pool = new ethers.Contract(CFG.pool,  POOL_ABI,  signer);
  aqua = new ethers.Contract(CFG.aquamon, AQUAMON_ABI, signer);

  try {
    const [d1, d2] = await Promise.all([ wmonRO.decimals(), aquaRO.decimals() ]);
    wmonDec = d1 || 18; stDec = d2 || 18;
  } catch {}

  await assertWiring();

  $("connect-btn").style.display    = "none";
  $("wallet-address").style.display = "block";
  $("wallet-address").innerHTML = `Connected: ${linkAddr(user, fmtAddr(user))}`;

  if (injected && injected.on) {
    injected.on("accountsChanged", () => location.reload());
    injected.on("chainChanged",    () => location.reload());
    injected.on("disconnect",      () => location.reload());
  }
  await refreshBalancesThrottled();
}

// ===== APR/Yield preview helpers (RO) =====
async function getMonBalance(addr) {
  if (!roProvider) return "0.0";
  const bal = await roProvider.getBalance(addr);
  return ethers.utils.formatUnits(bal, 18);
}
async function refreshBalancesAndPreviews() {
  if (!user || !aquaRO || !poolRO) return;
  try {
    const [monBal, stBal] = await Promise.all([
      getMonBalance(user),
      aquaRO.balanceOf(user)
    ]);
    $("balance-mon").textContent   = (+monBal).toFixed(4);
    $("balance-stmon").textContent = parseFloat(ethers.utils.formatUnits(stBal, stDec)).toFixed(4);

    const val = $("withdraw-assets").value;
    if (val && !isNaN(val) && Number(val) > 0) {
      const assetsWei = ethers.utils.parseUnits(val, 18);
      const shares = await poolRO.convertToShares(assetsWei);
      $("preview-line").textContent = `Will burn ~${ethers.utils.formatUnits(shares,18)} shares for ${val} MON.`;
    } else {
      $("preview-line").textContent = "";
    }
  } catch (e) { console.error("[withdraw] refresh error:", e); }
}
let _lastRefresh = 0, _inFlight = null;
async function refreshBalancesThrottled() {
  const now = Date.now();
  if (_inFlight) return _inFlight;
  if (now - _lastRefresh < 5000) return;
  _lastRefresh = now;
  _inFlight = refreshBalancesAndPreviews().finally(()=>{ _inFlight = null; });
  return _inFlight;
}
function debounce(fn, ms) { let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); }; }

// ===== Fees (RO only) =====
async function getNetworkFeeGuessSafe() {
  let base = null, tip = null;
  try {
    const latest = await roSend("eth_getBlockByNumber", ["latest", false]);
    if (latest && latest.baseFeePerGas) base = ethers.BigNumber.from(latest.baseFeePerGas);
  } catch {}
  try {
    const tipHex = await roSend("eth_maxPriorityFeePerGas", []);
    if (tipHex) tip = ethers.BigNumber.from(tipHex);
  } catch {
    tip = ethers.utils.parseUnits("1.5", "gwei");
  }
  if (!tip || tip.isZero()) tip = ethers.utils.parseUnits("1.5", "gwei");

  if (base) {
    const maxFeePerGas = base.mul(12).div(10).add(tip); // +20% headroom
    return { eip1559: true, maxFeePerGas, maxPriorityFeePerGas: tip };
  }
  const gpHex = await roSend("eth_gasPrice", []);
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
async function sendTxWithRetry(fnSend, baseFee, gasLimit, modalLabel) {
  let overrides = baseFee.eip1559
    ? { type: 2, maxFeePerGas: baseFee.maxFeePerGas, maxPriorityFeePerGas: baseFee.maxPriorityFeePerGas }
    : { gasPrice: baseFee.gasPrice };
  if (gasLimit && !overrides.gasLimit) overrides.gasLimit = gasLimit;

  const MAX_RETRIES = 2; // total attempts = 3 (1 + 2)
  let attempt = 0;

  while (true) {
    try {
      if (modalLabel && attempt === 0) {
        updateModal(`${modalLabel}<br><small>Submitting…</small>${FEE_HINT_HTML}`);
      }
      const tx = await fnSend(overrides);
      return tx;
    } catch (e) {
      if (!isFeeTooLow(e) || attempt >= MAX_RETRIES) throw e;
      attempt++;
      const factor   = attempt === 1 ? 1.35 : 1.6;
      const tipBump  = attempt === 1 ? 1    : 2;
      overrides = { ...bumpFeeOverrides(baseFee, factor, tipBump), gasLimit };

      const nextAttemptNum = attempt + 1;
      const totalAttempts  = MAX_RETRIES + 1;
      updateModal(
        `${modalLabel}<br><small>Fee too low — retrying with a higher tip (attempt ${nextAttemptNum} of ${totalAttempts})…</small>${FEE_HINT_HTML}`
      );
    }
  }
}

// ===== Withdraw helpers =====
async function setMaxWithdraw() {
  if (!poolRO || !user) return;
  const maxW = await poolRO.maxWithdraw(user); // assets in wei
  if (maxW.isZero()) { $("withdraw-assets").value = ""; $("preview-line").textContent = ""; return; }
  const safe = maxW.sub(1);
  $("withdraw-assets").value = ethers.utils.formatUnits(safe, 18);
  await refreshBalancesAndPreviews();
}

// ===== Flow: withdraw (wallet writes; RO reads/waits) =====
async function withdrawNow() {
  if (busyWithdraw) return;
  busyWithdraw = true;
  try {
    if (!provider || !signer || !pool || !aqua || !wmon) {
      showModal("Connect your wallet first.");
      return;
    }

    const wantHex = "0x" + (CFG.chainId || CHAIN_ID_DEC).toString(16);
    if (WALLET_CHAIN_ID_HEX && WALLET_CHAIN_ID_HEX.toLowerCase() !== wantHex.toLowerCase()) {
      showModal(`Wrong network (chainId=${parseInt(WALLET_CHAIN_ID_HEX,16)}). Switch to Monad Testnet (${parseInt(wantHex,16)}).`);
      return;
    }

    const amountStr = $("withdraw-assets").value;
    if (!amountStr || isNaN(amountStr) || Number(amountStr) <= 0) {
      $("withdraw-status").textContent = "Enter a withdraw amount.";
      return;
    }

    // RO checks
    const paused = await poolRO.paused().catch(()=>false);
    if (paused) { showModal("Pool is paused. Try again later."); return; }

    let assetsWei = ethers.utils.parseUnits(amountStr, 18);
    const maxW = await poolRO.maxWithdraw(user);
    if (maxW.isZero()) { $("withdraw-status").textContent = "Nothing available to withdraw."; return; }
    if (assetsWei.gt(maxW)) assetsWei = maxW.sub(1);
    if (assetsWei.lte(0))   { $("withdraw-status").textContent = "Amount too small."; return; }

    const sharesNeeded = await poolRO.convertToShares(assetsWei);
    if (sharesNeeded.isZero()) { $("withdraw-status").textContent = "Amount too small (rounds to 0 shares)."; return; }

    // Fees + gas (RO)
    const fee = await getNetworkFeeGuessSafe();
    const feeOverrides = fee.eip1559
      ? { type: 2, maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas }
      : { gasPrice: fee.gasPrice };

    const bump = (g) => g.mul(118).div(100);
    let gasApprove = ZERO, gasWithdraw = ZERO, gasUnwrap = ZERO;

    // Approve if needed
    const currentAllow = await aquaRO.allowance(user, CFG.pool).catch(() => ZERO);
    if (currentAllow.lt(sharesNeeded)) {
      gasApprove = await aquaRO.estimateGas.approve(CFG.pool, MaxUint256, { from: user }).catch(() => ethers.BigNumber.from(65000));
      gasApprove = bump(gasApprove);
    }
    // Withdraw gas
    gasWithdraw = await poolRO.estimateGas.withdraw(assetsWei, user, user, { from: user }).catch(() => ethers.BigNumber.from(200000));
    gasWithdraw = bump(gasWithdraw);

    // We’ll compute unwrap gas only if needed after withdrawal (we can re-estimate then if desired)
    // But give a default headroom for previewing funds
    gasUnwrap = ethers.BigNumber.from(70000);

    const perGas = fee.eip1559 ? fee.maxFeePerGas : fee.gasPrice;
    const cost = (g) => g.mul(perGas);

    if (FUNDS_DEBUG) {
      console.debug("[withdraw] assetsWei:", assetsWei.toString());
      console.debug("[withdraw] sharesNeeded:", sharesNeeded.toString());
      console.debug("[withdraw/gas] approve:", gasApprove.toString(), "withdraw:", gasWithdraw.toString());
      if (fee.eip1559) {
        console.debug("[withdraw/fee]", { maxFeePerGas: perGas.toString(), maxPriorityFeePerGas: fee.maxPriorityFeePerGas.toString() });
      } else {
        console.debug("[withdraw/fee]", { gasPrice: perGas.toString() });
      }
    }

    // 1) Approve (if needed)
    if (currentAllow.lt(sharesNeeded)) {
      showModal("Approving stMON for Pool…<br><small>Network busy? We’ll auto-retry with backoff.</small>" + FEE_HINT_HTML);
      const approveTx = await sendTxWithRetry(
        (overrides) => aqua.approve(CFG.pool, MaxUint256, { gasLimit: gasApprove, ...overrides }),
        fee,
        gasApprove,
        "Approving stMON for Pool…"
      );
      updateModal("Waiting for approval confirmation…", approveTx.hash);
      await roProvider.waitForTransaction(approveTx.hash, 1);
      await sleep(STEP_DELAY);
    }

    // 2) Withdraw assets (WMON will be received by the pool and then unwrapped)
    updateModal("Withdrawing… Please confirm in MetaMask.<br><small>Network busy? We’ll auto-retry with backoff.</small>" + FEE_HINT_HTML);
    const withdrawTx = await sendTxWithRetry(
      (overrides) => pool.withdraw(assetsWei, user, user, { gasLimit: gasWithdraw, ...overrides }),
      fee,
      gasWithdraw,
      "Withdrawing…"
    );
    updateModal("Waiting for withdrawal confirmation…", withdrawTx.hash);
    await roProvider.waitForTransaction(withdrawTx.hash, 1);
    await sleep(STEP_DELAY);

    // 3) If WMON landed in wallet, unwrap to MON
    const wBal = await wmonRO.balanceOf(user);
    if (wBal.gt(0)) {
      // estimate (RO) with margin
      let gasW = await wmonRO.estimateGas.withdraw(wBal, { from: user }).catch(()=>ethers.BigNumber.from(70000));
      gasW = bump(gasW);

      updateModal("Finalizing: delivering MON…<br><small>Network busy? We’ll auto-retry with backoff.</small>" + FEE_HINT_HTML);
      const unwrapTx = await sendTxWithRetry(
        (overrides) => wmon.withdraw(wBal, { gasLimit: gasW, ...overrides }),
        fee,
        gasW,
        "Finalizing: delivering MON…"
      );
      updateModal("Waiting for final confirmation…", unwrapTx.hash);
      await roProvider.waitForTransaction(unwrapTx.hash, 1);
      $("withdraw-status").innerHTML = `Withdrawn ~${ethers.utils.formatUnits(wBal, 18)} MON. ${linkTx(unwrapTx.hash, "view tx")}`;
    } else {
      $("withdraw-status").textContent = `Withdrawn ${ethers.utils.formatUnits(assetsWei,18)} MON.`;
    }

    closeModal();
    $("withdraw-assets").value = "";
    await refreshBalancesThrottled();
    showGoodbyeModal();

  } catch (err) {
    console.error("[withdraw] error:", err);
    showErrorModal(err);
  } finally {
    busyWithdraw = false;
  }
}

// ===== Goodbye modal =====
const byeMsgs = [
  "Withdrawal complete.\nSorry to see you go, come back anytime!",
  "Funds returned! Hope to see you again at Rebel Pool.",
  "Your MON is on its way. Thanks for staking with us!",
  "We’re sorry to see you go.\n(It’s not us, it’s you, but you’re always welcome back!)",
  "Withdrawal successful.\nFeeling FOMO yet? You know where to find us.",
  "Unstaking complete. Sometimes you have to break up to make up.",
  "Another rebel takes a pause.\nRemember, the pool is always open for your return.",
  "Funds unstaked.\nGo out there and make trouble, but don’t be a stranger!",
  "Done!\nWhether you stake or withdraw, you’re part of the movement."
];
function showGoodbyeModal() {
  const msg = byeMsgs[Math.floor(Math.random()*byeMsgs.length)];
  const modal = document.createElement("div");
  modal.className = "modal";
  modal.innerHTML = `
    <div class="modal-content" style="text-align:center;">
      <h2>Sorry to See You Go!</h2>
      <div style="margin:18px 0; white-space:pre-line;">${msg}</div>
      <button onclick="this.closest('.modal').remove()">Close</button>
    </div>`;
  document.body.appendChild(modal);
}

// ===== INIT =====
async function init() {
  try {
    // 1) Load CFG + explorer strings
    CFG = await resolveNetConfig();
    if (!CFG || !CFG.pool || !CFG.wmon || !CFG.aquamon) {
      console.error("[withdraw] Bad or missing chain config:", CFG);
      showModal("Chain configuration missing.<br>Please check js/chain.js addresses and RPC.");
      return;
    }
    CHAIN_ID_DEC = CFG?.chainId || CHAIN_ID_DEC;
    EXPLORER_TX   = CFG?.explorer ? `${CFG.explorer}/tx/`      : "#";
    EXPLORER_ADDR = CFG?.explorer ? `${CFG.explorer}/address/` : "#";
    EXPLORER_TOK  = CFG?.explorer ? `${CFG.explorer}/token/`   : "#";

    // 2) RO provider/contracts
    initReadSide();
    await assertWiring();

    // 3) Network selector (if present)
    if (window.renderNetworkSelector) {
      renderNetworkSelector("network-select", () => location.reload());
    }

    // 4) Wire buttons
    $("connect-btn").style.display = "block";
    $("wallet-address").style.display = "none";
    $("connect-btn").onclick = connectWallet;
    $("withdraw-btn").onclick = () => { showModal("Preparing withdrawal…"); withdrawNow(); };
    const maxBtn = $("withdraw-max"); if (maxBtn) maxBtn.onclick = setMaxWithdraw;
    const input = $("withdraw-assets"); if (input) input.oninput = debounce(refreshBalancesAndPreviews, 400);

    // 5) Gentle auto-connect if already authorized
    if (window.ethereum) {
      try {
        const accounts = await window.ethereum.request({ method: "eth_accounts" });
        if (Array.isArray(accounts) && accounts.length > 0) {
          // connect w/out prompting
          const pick = pickInjectedProvider();
          if (pick) {
            injected = wrapInjectedRequest(pick.provider);
            try { await ensureMonadNetwork(injected, CFG); } catch {}
            provider = new ethers.providers.Web3Provider(injected, "any");
            provider.pollingInterval = 20000;
            provider.polling = false;

            user = accounts[0];
            signer = provider.getSigner(user);

            wmon = new ethers.Contract(CFG.wmon,  WMON_ABI,  signer);
            pool = new ethers.Contract(CFG.pool,  POOL_ABI,  signer);
            aqua = new ethers.Contract(CFG.aquamon, AQUAMON_ABI, signer);

            try {
              const [d1, d2] = await Promise.all([ wmonRO.decimals(), aquaRO.decimals() ]);
              wmonDec = d1 || 18; stDec = d2 || 18;
            } catch {}

            $("connect-btn").style.display = "none";
            $("wallet-address").style.display = "block";
            $("wallet-address").innerHTML = `Connected: ${linkAddr(user, fmtAddr(user))}`;

            injected.on?.("accountsChanged", () => location.reload());
            injected.on?.("chainChanged",    () => location.reload());
            injected.on?.("disconnect",      () => location.reload());

            await refreshBalancesThrottled();
          }
        } else {
          await refreshBalancesThrottled();
        }
      } catch {}
    } else {
      await refreshBalancesThrottled();
    }
  } catch (e) {
    console.error("[withdraw] init failed:", e);
    showModal("Initialization failed. Check console and your network configuration.");
  }
}

window.addEventListener("DOMContentLoaded", init);
