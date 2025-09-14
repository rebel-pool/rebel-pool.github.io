// js/stake.js — ethers v5.7.x (UMD) – Rebel Pool
// Uses rpc-utils.js for: read provider (RR), global wallet wrap, fee guess, retries, friendly errors
/* globals RPCUtils, ethers */

// ===== ABIs =====
const WMON_ABI = [
  "function approve(address spender, uint256 amount) public returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function deposit() payable"
];
const POOL_ABI = [
  "function deposit(uint256 assets, address receiver) public returns (uint256)",
  "function underlying() view returns (address)",
  "function aquaToken() view returns (address)",
  "function arcToken() view returns (address)",
  "function paused() view returns (bool)",
  "function totalAssets() view returns (uint256)",
  "function index() view returns (uint256)",
  "function lastAccrualBlock() view returns (uint256)"
];
const AQUAMON_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function sharesOf(address owner) view returns (uint256)"
];

// ===== Pull utilities from rpc-utils.js =====
const {
  makeReadProvider,
  wrapInjectedRequest,         // kept for backwards-compat in connect flow
  wrapAllInjected,             // NEW: ensure ALL providers are wrapped
  pickInjectedProvider,
  ensureMonadNetwork,
  setReadProvider,
  roSend,
  getNetworkFeeGuessSafe,
  sendTxWithRetry,
  isFeeTooLow,
  friendlyError,
  RateLimitUI,
} = RPCUtils;

// ===== State =====
let CFG = null;
let CHAIN_ID_DEC = 10143;

let provider = null;     // wallet-backed provider (MetaMask/MEW)
let signer   = null;
let injected = null;

let wmon = null, stmon = null, pool = null;        // write-side (wallet)
let roProvider = null;                              // read-only (public RPC)
let wmonRO = null, stmonRO = null, poolRO = null;   // read-side contracts

let userAddr = null;
let wmonDecimals = 18, stmonDecimals = 18;
let busyStake = false;

// Explorer strings
let EXPLORER_TX = "#";
let EXPLORER_ADDR = "#";
let EXPLORER_TOK = "#";

let WALLET_CHAIN_ID_HEX = null;

const ZERO = ethers.constants.Zero;
const MaxUint256 = ethers.constants.MaxUint256;
const FUNDS_DEBUG = true;

// ===== DOM/helper utils =====
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const esc = (s) => (s||"").toString().replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const fmtAddr = (a) => a ? `${a.slice(0,6)}…${a.slice(-4)}` : "";
function linkTx(hash, text){ return `<a href="${EXPLORER_TX}${hash}" target="_blank" rel="noopener">${esc(text)}</a>`; }
function linkAddr(addr, text){ return `<a href="${EXPLORER_ADDR}${addr}" target="_blank" rel="noopener">${esc(text)}</a>`; }

// Fee guidance hint (shown on low/volatile fees)
const FEE_HINT_HTML = `<br><small class="muted">
Network fees are looking low/volatile. <br> wait ~30–60s for the network to stabilize and try again.
</small>`;

// ===== Modals & messages =====
const stakeCongratsMessages = [
  "Congratulations! You’ve joined Rebel Pool. Welcome to staking without compromise.",
  "Success! You’re officially a Rebel Pool staker—enjoy the power of no VC, no nonsense, just pure yield.",
  "Welcome aboard! Your stake is working for you (not some investor).",
  "You did it! You staked like a rebel. Welcome to the fight against staking inequality.",
  "Another rebel joins the cause! Stakers first, VCs never.",
  "Boom! You’re in. It’s not just staking, it’s a movement.",
  "Staking complete. Please proceed to quietly gloat.",
  "Welcome to Rebel Pool. Your yield is now on the right side of history.",
  "Stake confirmed! Together, we’re making staking fair again."
];
function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function renderStakeModal(msg, txHash) {
  const modal = $("stake-modal");
  const link = txHash ? `<br><a href="${EXPLORER_TX}${txHash}" target="_blank" rel="noopener">View on MonadScan</a>` : "";
  $("stake-modal-msg").innerHTML = `
    <div>${msg}${link}</div>
    <div style="text-align:right; margin-top:12px;">
      <button id="stake-modal-close">Close</button>
    </div>`;
  modal.style.display = "flex";
  const btn = document.getElementById("stake-modal-close");
  if (btn) btn.onclick = closeStakeModal;
}
function showStakeModal(msg) { renderStakeModal(msg, null); }
function updateStakeModal(msg, txHash) { renderStakeModal(msg, txHash); }
function closeStakeModal() { $("stake-modal").style.display = "none"; }

function showCongratsModal() {
  closeStakeModal();
  const modal = document.createElement("div");
  modal.className = "modal";
  modal.innerHTML = `
    <div class="modal-content" style="text-align:center;">
      <h2>Congratulations!</h2>
      <div style="margin: 18px 0;">${pickRandom(stakeCongratsMessages)}</div>
      <button id="congrats-close-btn">Close</button>
    </div>`;
  document.body.appendChild(modal);
  modal.querySelector("#congrats-close-btn").onclick = () => modal.remove();
}

// ===== Wiring self-check (RO reads, not wallet) =====
async function assertWiring() {
  if (!poolRO || !CFG) return;
  try {
    const [u, a] = await Promise.all([ poolRO.underlying(), poolRO.aquaToken() ]);
    const mismatch = u.toLowerCase() !== CFG.wmon.toLowerCase() || a.toLowerCase() !== CFG.aquamon.toLowerCase();
    if (mismatch) {
      showStakeModal(
        "Address config mismatch detected.<br>" +
        `Pool.underlying(): ${linkAddr(u,u)}<br>` +
        `Pool.aquaToken(): ${linkAddr(a,a)}<br>` +
        "Update chain.js addresses and reload."
      );
      throw new Error("Address config mismatch");
    }
  } catch (e) {
    console.error("[stake] Wiring check failed:", e);
    throw e;
  }
}

// ===== Config/RPC helpers =====
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
function makeRO(cfg) {
  const url = pickRpc(cfg);
  if (!url) return null;
  const chainId = cfg?.chainId || CHAIN_ID_DEC;
  return new ethers.providers.JsonRpcProvider(url, { name: "monad-testnet", chainId });
}

// ===== Read-side init (NEVER default to localhost) =====
function initReadSide() {
  // prefer local makeRO (ethers Provider) so Contracts can bind to it
  roProvider = (typeof makeRO === "function" ? makeRO(CFG) : makeReadProvider(CFG));
  if (roProvider) {
    roProvider.pollingInterval = 10000;
    // Let rpc-utils know our RO sender for roSend()
    if (typeof setReadProvider === "function") setReadProvider(roProvider);
    wmonRO  = new ethers.Contract(CFG.wmon,    WMON_ABI,    roProvider);
    stmonRO = new ethers.Contract(CFG.aquamon, AQUAMON_ABI, roProvider);
    poolRO  = new ethers.Contract(CFG.pool,    POOL_ABI,    roProvider);
  } else {
    wmonRO = stmonRO = poolRO = roProvider = null;
  }
}

// ===== Wallet connect (hardened) =====
function getLocalChainIdHex(inj) {
  const hex = inj && typeof inj.chainId === "string" ? inj.chainId : null;
  return hex && /^0x[0-9a-f]+$/i.test(hex) ? hex : null;
}

async function connectWalletAuthorized(preAccounts) {
  if (!CFG) return;
  const pick = pickInjectedProvider();
  if (!pick) return;

  // Already globally wrapped at init; still wrap local ref for safety
  injected = wrapInjectedRequest(pick.provider);
  try { await ensureMonadNetwork(injected, CFG); }
  catch (e) { console.error("[stake] ensureMonadNetwork:", e); return; }

  WALLET_CHAIN_ID_HEX = getLocalChainIdHex(injected) || WALLET_CHAIN_ID_HEX;

  provider = new ethers.providers.Web3Provider(injected, "any");
  provider.pollingInterval = 20000;
  provider.polling = false;

  // Prefer preAccounts; otherwise fetch silently
  userAddr = (Array.isArray(preAccounts) && preAccounts[0]) ? preAccounts[0] : null;
  if (!userAddr) {
    try {
      const list = await injected.request({ method: "eth_accounts" });
      userAddr = Array.isArray(list) ? list[0] : null;
    } catch {}
  }
  if (!userAddr) return;

  signer   = provider.getSigner(userAddr);

  // Write-side contracts (wallet)
  wmon  = new ethers.Contract(CFG.wmon,    WMON_ABI,    signer);
  stmon = new ethers.Contract(CFG.aquamon, AQUAMON_ABI, signer);
  pool  = new ethers.Contract(CFG.pool,    POOL_ABI,    signer);

  // Decimals via RO (avoid wallet reads)
  try {
    const [d1, d2] = await Promise.all([ wmonRO.decimals(), stmonRO.decimals() ]);
    wmonDecimals = d1 || 18; stmonDecimals = d2 || 18;
  } catch {}

  await assertWiring();

  // UI
  $("connect-btn").style.display = "none";
  $("wallet-address").style.display = "block";
  $("wallet-address").innerHTML = `Connected: ${linkAddr(userAddr, fmtAddr(userAddr))}`;

  if (injected && injected.on) {
    injected.on("accountsChanged", () => location.reload());
    injected.on("chainChanged",    () => location.reload());
    injected.on("disconnect",      () => location.reload());
  }

  await refreshAllBalances();
}

async function connectWallet() {
  if (!CFG) { console.error("[stake] connectWallet: CFG not loaded"); return; }
  const pick = pickInjectedProvider();
  if (!pick) { alert("No wallet found. Please install MEW or MetaMask."); return; }

  injected = wrapInjectedRequest(pick.provider);
  try { await ensureMonadNetwork(injected, CFG); }
  catch (e) { console.error("[stake] ensureMonadNetwork:", e); alert("Could not switch/add Monad Testnet in your wallet."); return; }

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

  // Bind signer to selected address
  let accounts = [];
  try { accounts = await injected.request({ method: "eth_accounts" }); } catch {}
  userAddr = Array.isArray(accounts) && accounts[0] ? accounts[0] : null;
  if (!userAddr) { alert("No account found in wallet."); return; }

  signer = provider.getSigner(userAddr);

  // Write-side contracts (wallet)
  wmon  = new ethers.Contract(CFG.wmon,    WMON_ABI,    signer);
  stmon = new ethers.Contract(CFG.aquamon, AQUAMON_ABI, signer);
  pool  = new ethers.Contract(CFG.pool,    POOL_ABI,    signer);

  // Decimals via RO (avoid wallet reads)
  try {
    const [d1, d2] = await Promise.all([ wmonRO.decimals(), stmonRO.decimals() ]);
    wmonDecimals = d1 || 18; stmonDecimals = d2 || 18;
  } catch {}

  await assertWiring();

  // UI
  $("connect-btn").style.display = "none";
  $("wallet-address").style.display = "block";
  $("wallet-address").innerHTML = `Connected: ${linkAddr(userAddr, fmtAddr(userAddr))}`;

  if (injected && injected.on) {
    injected.on("accountsChanged", () => location.reload());
    injected.on("chainChanged",    () => location.reload());
    injected.on("disconnect",      () => location.reload());
  }

  await refreshAllBalances();
}

// ===== APR & Yield (RO only) =====
async function updateAprAndYield() {
  const aprCfg = (typeof CFG?.apr === "number") ? CFG.apr : 0;
  if (!roProvider || !poolRO) {
    $("stat-apr").textContent = aprCfg ? `${aprCfg}% (target)` : "N/A";
    $("apr-hint").title = "APR unavailable from chain; showing config target.";
    return aprCfg;
  }
  try {
    const [totalAssets, index] = await Promise.all([ poolRO.totalAssets(), poolRO.index() ]);
    if (totalAssets.isZero() || index.isZero()) {
      $("stat-apr").textContent = aprCfg ? `${aprCfg}% (target)` : "N/A";
      $("apr-hint").title = "Pool is too new or empty for real APR, showing config target.";
      return aprCfg;
    }
    const aprKey = `aprSample_${CFG.pool}_${CFG.label}`;
    const aprTimeKey = `aprSampleTime_${CFG.pool}_${CFG.label}`;
    const aprValueKey = `aprValue_${CFG.pool}_${CFG.label}`;
    const minSampleWindow = 3600; // 1hr
    const now = Date.now() / 1000;
    let lastSample = localStorage.getItem(aprKey);
    let lastSampleTime = localStorage.getItem(aprTimeKey);
    const currentIndex = Number(index) / 1e18;

    if (lastSample && lastSampleTime) {
      lastSample = parseFloat(lastSample);
      lastSampleTime = parseFloat(lastSampleTime);
      if (currentIndex > lastSample && now > lastSampleTime + minSampleWindow) {
        const elapsed = now - lastSampleTime;
        let apr = ((currentIndex / lastSample - 1) * (31557600 / elapsed)) * 100;
        const display = (apr > 100 ? "100%+" : apr.toFixed(2) + "%");
        localStorage.setItem(aprKey, currentIndex);
        localStorage.setItem(aprTimeKey, now);
        localStorage.setItem(aprValueKey, display);
        $("stat-apr").textContent = display;
        $("apr-hint").title = "APR computed from pool index over last period.";
        return apr;
      } else {
        const lastAprValue = localStorage.getItem(aprValueKey);
        $("stat-apr").textContent = lastAprValue ? `${lastAprValue} (recent)` : `${aprCfg}% (target)`;
        $("apr-hint").title = "Showing most recent computed APR or config target.";
        return aprCfg;
      }
    } else {
      localStorage.setItem(aprKey, currentIndex);
      localStorage.setItem(aprTimeKey, now);
      $("stat-apr").textContent = aprCfg ? `${aprCfg}% (target)` : "N/A";
      $("apr-hint").title = "No yield yet, showing config target.";
      return aprCfg;
    }
  } catch (e) {
    console.warn("[stake] APR read failed:", e);
    $("stat-apr").textContent = aprCfg ? `${aprCfg}% (target)` : "N/A";
    $("apr-hint").title = "APR unavailable, showing config target.";
    return aprCfg;
  }
}

// --------- Balances (RO) ---------
async function getMonBalance(address) {
  if (!roProvider) return "0";
  const balance = await roProvider.getBalance(address);
  return ethers.utils.formatUnits(balance, 18);
}
async function refreshAllBalances() {
  if (!userAddr || !stmonRO) return;
  const [monBal, stmonBal] = await Promise.all([
    getMonBalance(userAddr),
    stmonRO.balanceOf(userAddr)
  ]);
  $("balance-mon").textContent   = (+monBal).toFixed(4);
  $("balance-stmon").textContent = parseFloat(ethers.utils.formatUnits(stmonBal, stmonDecimals)).toFixed(4);
  await updateYieldEstimate();
}

// --- Yield Projection Helper (dynamic APR) ---
function formatEstimate(amount, apr, days) {
  if (!amount || !apr || isNaN(amount) || isNaN(apr)) return "–";
  const rate = apr / 100;
  const growth = amount * Math.pow(1 + rate, days / 365);
  return growth.toFixed(4);
}
async function updateYieldEstimate() {
  let stBal = parseFloat($("balance-stmon").textContent);
  if (isNaN(stBal)) stBal = 0;
  const apr = await updateAprAndYield();
  $("est-24h").textContent   = formatEstimate(stBal, apr, 1);
  $("est-week").textContent  = formatEstimate(stBal, apr, 7);
  $("est-month").textContent = formatEstimate(stBal, apr, 30);
  $("est-year").textContent  = formatEstimate(stBal, apr, 365);
}

// --- Wallet balance (wallet RPC, but wrapped) ---
async function getWalletBalanceWeiSafe(addr) {
  // Prefer RO provider (not rate-limited by wallet)
  try {
    const bn = await roProvider.getBalance(addr);
    return bn;
  } catch {}
  // Fallback to wallet (wrapped) if RO failed
  try {
    const hex = await injected.request({ method: "eth_getBalance", params: [addr, "latest"] });
    return ethers.BigNumber.from(hex);
  } catch {
    // Final fallback: signal "unknown" by returning null
    return null;
  }
}

// --------- Stake Flow (RO reads; wallet writes; RO waits) ---------
async function stakeNow() {
  if (busyStake) return;
  busyStake = true;
  try {
    if (!provider || !signer || !pool || !wmon) {
      showStakeModal("Connect your wallet first.");
      return;
    }

    // Verify chain via cached value (we reload on chainChanged).
    const wantHex = "0x" + (CFG.chainId || CHAIN_ID_DEC).toString(16);
    if (WALLET_CHAIN_ID_HEX && WALLET_CHAIN_ID_HEX.toLowerCase() !== wantHex.toLowerCase()) {
      showStakeModal(`Wrong network (chainId=${parseInt(WALLET_CHAIN_ID_HEX,16)}). Switch to Monad Testnet (${parseInt(wantHex,16)}).`);
      return;
    }

    // Amount
    const amountStr = $("stake-amount").value;
    if (!amountStr || isNaN(+amountStr) || +amountStr <= 0) {
      showStakeModal("Enter an amount to stake.");
      $("stake-status").textContent = "Enter amount";
      return;
    }
    const parsedAmount = ethers.utils.parseUnits(amountStr, 18);

    // RO reads
    const [roMonBal, paused, wmonBalRO] = await Promise.all([
      roProvider.getBalance(userAddr).catch(() => null),
      poolRO.paused().catch(() => false),
      wmonRO.balanceOf(userAddr).catch(() => ZERO),
    ]);
    if (paused) { showStakeModal("Pool is paused. Try again later."); return; }

    // Prefer wallet’s own balance view for fee gating
    let monBalWei = await getWalletBalanceWeiSafe(userAddr);
    if (!monBalWei) monBalWei = roMonBal ?? ZERO;

    // How much we still need to wrap to reach stake amount
    const needWrap = wmonBalRO.gte(parsedAmount) ? ZERO : parsedAmount.sub(wmonBalRO);

    // Fees (RO only) → overrides for wallet txs
    const fee = await getNetworkFeeGuessSafe();
    const feeOverrides = fee.eip1559
      ? { type: 2, maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas }
      : { gasPrice: fee.gasPrice };

    // Gas estimates via RO (with safe fallbacks)
    const bump = (g) => g.mul(118).div(100); // +18%
    let gasWrap = ZERO, gasApprove = ZERO, gasStake = ZERO;

    if (needWrap.gt(0)) {
      gasWrap = await wmonRO.estimateGas.deposit({ from: userAddr, value: needWrap }).catch(() => ethers.BigNumber.from(80000));
      gasWrap = bump(gasWrap);
    }

    const currentAllowance = await wmonRO.allowance(userAddr, CFG.pool).catch(() => ZERO);
    if (currentAllowance.lt(parsedAmount)) {
      gasApprove = await wmonRO.estimateGas.approve(CFG.pool, MaxUint256, { from: userAddr }).catch(() => ethers.BigNumber.from(65000));
      gasApprove = bump(gasApprove);
    }

    gasStake = await poolRO.estimateGas.deposit(parsedAmount, userAddr, { from: userAddr }).catch(() => ethers.BigNumber.from(160000));
    gasStake = bump(gasStake);

    const perGas = fee.eip1559 ? fee.maxFeePerGas : fee.gasPrice;
    const cost = (g) => g.mul(perGas);

    if (FUNDS_DEBUG) {
      console.debug("[stake/funds] amount(wei):", parsedAmount.toString());
      console.debug("[stake/funds] wmonBalRO(wei):", wmonBalRO.toString());
      console.debug("[stake/funds] needWrap(wei):", needWrap.toString());
      console.debug("[stake/funds] monBalWei(wallet view, wei):", monBalWei.toString());
      console.debug("[stake/gas] wrap:", gasWrap.toString(), "approve:", gasApprove.toString(), "stake:", gasStake.toString());
      if (fee.eip1559) {
        console.debug("[stake/fee]", { maxFeePerGas: perGas.toString(), maxPriorityFeePerGas: fee.maxPriorityFeePerGas.toString() });
      } else {
        console.debug("[stake/fee]", { gasPrice: perGas.toString() });
      }
    }

    // 1) WRAP (only shortfall)
    if (needWrap.gt(0)) {
      const needForWrap = needWrap.add(cost(gasWrap));
      if (monBalWei.lt(needForWrap)) {
        const need = ethers.utils.formatUnits(needForWrap, 18);
        const have = ethers.utils.formatUnits(monBalWei, 18);
        showStakeModal(`Insufficient MON for wrap + gas.<br>Need ~${Number(need).toFixed(6)}, have ${Number(have).toFixed(6)}.`);
        $("stake-status").textContent = "Insufficient funds";
        return;
      }
      await sleep(350);
      showStakeModal("Wrapping MON to WMON…<br><small>Network busy? We’ll auto-retry with backoff.</small>" + FEE_HINT_HTML);

      const tx1 = await sendTxWithRetry(
        (overrides) => wmon.deposit({ value: needWrap, ...overrides }),
        fee,
        gasWrap,
        "Wrapping MON to WMON…"
      );
      updateStakeModal("Waiting for confirmation…", tx1.hash);
      await roProvider.waitForTransaction(tx1.hash, 1);
      await sleep(900);
      monBalWei = await getWalletBalanceWeiSafe(userAddr) || monBalWei;
    }

    // 2) APPROVE (if needed)
    if (currentAllowance.lt(parsedAmount)) {
      const needForApprove = cost(gasApprove);
      if (monBalWei.lt(needForApprove)) {
        const need = ethers.utils.formatUnits(needForApprove, 18);
        const have = ethers.utils.formatUnits(monBalWei, 18);
        showStakeModal(`Insufficient MON to pay approval gas.<br>Need ~${Number(need).toFixed(6)}, have ${Number(have).toFixed(6)}.`);
        $("stake-status").textContent = "Insufficient funds";
        return;
      }
      await sleep(350);
      updateStakeModal("Approving WMON for Pool…<br><small>Network busy? We’ll auto-retry with backoff.</small>" + FEE_HINT_HTML);

      const approveTx = await sendTxWithRetry(
        (overrides) => wmon.approve(CFG.pool, MaxUint256, overrides),
        fee,
        gasApprove,
        "Approving WMON for Pool…"
      );
      updateStakeModal("Waiting for approval…", approveTx.hash);
      await roProvider.waitForTransaction(approveTx.hash, 1);
      await sleep(900);
      monBalWei = await getWalletBalanceWeiSafe(userAddr) || monBalWei;
    }

    // 3) STAKE
    const needForStake = cost(gasStake);
    if (monBalWei.lt(needForStake)) {
      const need = ethers.utils.formatUnits(needForStake, 18);
      const have = ethers.utils.formatUnits(monBalWei, 18);
      showStakeModal(`Insufficient MON to pay stake gas.<br>Need ~${Number(need).toFixed(6)}, have ${Number(have).toFixed(6)}.`);
      $("stake-status").textContent = "Insufficient funds";
      return;
    }
    await sleep(600);
    updateStakeModal("Staking WMON in Pool…<br><small>Network busy? We’ll auto-retry with backoff.</small>" + FEE_HINT_HTML);

    const stakeTx = await sendTxWithRetry(
      (overrides) => pool.deposit(parsedAmount, userAddr, overrides),
      fee,
      gasStake,
      "Staking WMON in Pool…"
    );

    updateStakeModal("Waiting for confirmation…", stakeTx.hash);
    await sleep(600);
    await roProvider.waitForTransaction(stakeTx.hash, 1);

    // Done
    updateStakeModal(
      "Staked! Your stMON (AquaMON) will appear shortly." +
      `<br>${linkTx(stakeTx.hash, "View stake tx")}` +
      `<br><button onclick='closeStakeModal()'>Close</button>`
    );
    $("stake-status").textContent = "Staked! Watch your MON grow.";
    $("stake-amount").value = "";
    await refreshAllBalances();
    closeStakeModal();
    showCongratsModal();

  } catch (err) {
    console.error("[stake] error:", err);
    const msg = friendlyError(err);
    updateStakeModal(`Error: ${msg}<br><button onclick="closeStakeModal()">Close</button>`);
    $("stake-status").textContent = `Error: ${msg.replace(/<br>/g, " ")}`;
  } finally {
    busyStake = false;
  }
}

// === Helper: Add token to MetaMask (stMON / WMON) ===
async function addTokenToMetaMask(tokenOrAddress, symbolOpt, decimalsOpt) {
  if (!window.ethereum) { console.error("MetaMask not found."); return; }
  const cfg = CFG || await resolveNetConfig();
  let address, symbol = symbolOpt, decimals = decimalsOpt ?? 18;
  const isAddr = typeof tokenOrAddress === "string" && tokenOrAddress.startsWith("0x") && tokenOrAddress.length === 42;
  if (isAddr) {
    address = tokenOrAddress;
    if (!symbol) {
      if (address.toLowerCase() === cfg.aquamon.toLowerCase()) symbol = "stMON";
      else if (address.toLowerCase() === cfg.wmon.toLowerCase()) symbol = "WMON";
      else symbol = "TOKEN";
    }
  } else {
    const key = (tokenOrAddress || "").toLowerCase();
    if (key === "stmon") { address = cfg.aquamon; symbol = "stMON"; decimals = stmonDecimals; }
    else if (key === "wmon") { address = cfg.wmon; symbol = "WMON"; decimals = wmonDecimals; }
    else { throw new Error("Unknown token: " + tokenOrAddress); }
  }
  try {
    const wasAdded = await window.ethereum.request({
      method: "wallet_watchAsset",
      params: { type: "ERC20", options: { address, symbol, decimals } }
    });
    console.log(wasAdded ? `Added ${symbol} (${address})` : `User declined to add ${symbol}`);
  } catch (err) {
    console.error("addTokenToMetaMask error:", err);
  }
}

// ===== INIT =====
async function init() {
  try {
    // 0) Globally wrap ALL injected providers so nothing bypasses queue/backoff
    wrapAllInjected({ pre: 400, post: 300, base: 800, maxTries: 6, jitter: 300, debug: true });

    // 1) Load CFG first
    CFG = await resolveNetConfig();
    if (!CFG || !CFG.pool || !CFG.wmon || !CFG.aquamon) {
      console.error("[stake] Bad or missing chain config:", CFG);
      showStakeModal("Chain configuration missing.<br>Please check js/chain.js addresses and RPC.");
      return;
    }
    CHAIN_ID_DEC = CFG?.chainId || CHAIN_ID_DEC;

    // 2) Explorer strings for links
    EXPLORER_TX   = CFG?.explorer ? `${CFG.explorer}/tx/`      : "#";
    EXPLORER_ADDR = CFG?.explorer ? `${CFG.explorer}/address/` : "#";
    EXPLORER_TOK  = CFG?.explorer ? `${CFG.explorer}/token/`   : "#";

    // 3) Read-only provider/contracts
    initReadSide();
    await assertWiring();

    // 4) Populate static labels from CFG
    const NATIVE_SYM = CFG?.coin?.native?.symbol || "MON";
    const AQUA_SYM   = CFG?.coin?.aqua?.symbol   || "stMON";
    $("stake-title").textContent = `Stake ${NATIVE_SYM}, Earn ${AQUA_SYM}`;
    $("native-sym-label").textContent = `${NATIVE_SYM}:`;
    $("aqua-sym-label").textContent   = `${AQUA_SYM}:`;
    $("aqua-sym-label2").textContent  = AQUA_SYM;
    const stLink = $("view-stmon-link");
    if (stLink) {
      stLink.textContent = `View ${AQUA_SYM} on Explorer`;
      stLink.href = CFG?.explorer ? `${EXPLORER_TOK}${CFG.aquamon}` : "#";
    }
    $("add-token-btn").textContent = `Add ${AQUA_SYM} to Wallet`;

    // 5) Network selector
    if (window.renderNetworkSelector) {
      renderNetworkSelector("network-select", () => location.reload());
    }

    // 6) Modal UX: backdrop click + ESC to close (wire once)
    (function wireModalDismiss() {
      const modal = $("stake-modal");
      if (modal && !modal.__wired) {
        modal.addEventListener("click", (e) => { if (e.target === modal) closeStakeModal(); });
        document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeStakeModal(); });
        modal.__wired = true;
      }
    })();

    // 7) Disable page if network is disabled
    if (CFG.disabled) {
      $("stake-btn").disabled = true;
      $("stake-status").textContent = "This network is not active.";
      return;
    }

    // 8) Wire buttons
    $("connect-btn").onclick = connectWallet;
    $("stake-btn").onclick   = stakeNow;

    // 9) Initial wallet UI
    $("connect-btn").style.display = "block";
    $("wallet-address").style.display = "none";

    // 10) Gentle auto-check (once): if already authorized, connect (no prompt)
    const eth = window.ethereum; // already wrapped globally
    if (eth) {
      try {
        const accounts = await eth.request({ method: "eth_accounts" }); // silent probe
        if (Array.isArray(accounts) && accounts.length > 0) {
          await connectWalletAuthorized(accounts); // NO eth_requestAccounts here
        }
      } catch {}
    }

    // 11) APR & projections even if not connected
    if (userAddr) {
      $("connect-btn").style.display = "none";
      $("wallet-address").style.display = "block";
      $("wallet-address").innerHTML = `Connected: ${linkAddr(userAddr, fmtAddr(userAddr))}`;
      await refreshAllBalances();
    } else {
      await updateYieldEstimate();
    }
  } catch (e) {
    console.error("[stake] init failed:", e);
    showStakeModal("Initialization failed. Check console and your network configuration.");
  }
}

window.addEventListener('DOMContentLoaded', init);
