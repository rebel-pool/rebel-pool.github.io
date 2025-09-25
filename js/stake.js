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
  "function lastAccrualBlock() view returns (uint256)",
  "function accrue() external returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function convertToShares(uint256 assets) view returns (uint256)"
];
const AQUAMON_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function sharesOf(address owner) view returns (uint256)"
];

const REBEL_NATIVE_ROUTER_ABI = [
  "function depositNative(address receiver) payable returns (uint256)"
];

window.RULEDELEGATION_ABI = [
  "function createRule(uint8 ruleType, uint256 threshold, address target, uint256 rewardBps) external returns (uint256)",
  "function disableRule(uint256 ruleId) external",
  "function enableRule(uint256 ruleId) external",
  "function executeRule(uint256 ruleId) external",
  "function rules(uint256) view returns (address owner, uint8 ruleType, uint256 threshold, address target, uint256 rewardBps, bool active)",
  "function nextRuleId() view returns (uint256)"
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
} = RPCUtils || {};

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

</small>`;

// ===== Modals & messages =====
const stakeCongratsMessages = [
  "Congratulations! You’ve joined Rebel Pool. Welcome to staking without compromise.",
  "Success! You’re officially a Rebel Pool staker—enjoy the power of no VC, no nonsense, just pure yield.",
  "Welcome aboard! Your stake is working for you (not some investor).",
  "You did it! You staked like a rebel. Welcome to the fight against staking inequality.",
  "Another rebel joins the cause! Stakers first, VCs never.",
  "Boom! You’re in. It’s not just staking, it’s a movement.",
  "Deposit complete. Please proceed to quietly gloat.",
  "Welcome to Rebel Pool. Your yield is now on the right side of history.",
  "Stake confirmed! Together, we’re making staking fair again."
];
function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function renderStakeModal(msg, txHash) {
  const modal = $("stake-modal");
  const msgEl = $("stake-modal-msg");
  if (!modal || !msgEl) {
    console.warn("[stake] Modal not present, skipping render:", msg);
    return; // avoid TypeError
  }
  const link = txHash ? `<div style="margin-top:8px">${linkTx(txHash, "View on MonadScan ↗")}</div>` : "";
  msgEl.innerHTML = `<div>${msg}${link}</div>`;
  modal.style.display = "flex";
}

function showStakeModal(msg) {
  renderStakeModal(msg, null);
}

function updateStakeModal(msg, txHash) {
  const msgEl = $("stake-modal-msg");
  const modal = $("stake-modal");

  if (!modal || !msgEl) {
    // 🚀 New: handle Automations context
    const autoModal = $("automations-modal");
    if (autoModal && autoModal.style.display === "flex") {
      console.log("[stake] updateStakeModal routed to Automations modal");
      autoModal.style.display = "none"; // close automations modal
      // optional: toast or alert
      alert(msg + (txHash ? `\nTx: ${txHash}` : ""));
    } else {
      console.warn("[stake] updateStakeModal: no modal found");
    }
    return;
  }

  const link = txHash ? `<div style="margin-top:8px">${linkTx(txHash, "View on MonadScan ↗")}</div>` : "";
  msgEl.innerHTML = `<div>${msg}${link}</div>`;
  modal.style.display = "flex";
}

function closeStakeModal() {
  const modal = $("stake-modal");
  if (modal) modal.style.display = "none";
}

function showCongratsModal(txHash) {
  const modal = document.createElement("div");
  modal.className = "modal";
  modal.innerHTML = `
    <div class="modal-content" style="text-align:center;">
      <h2>Congratulations!</h2>
      <div style="margin: 18px 0;">${pickRandom(stakeCongratsMessages)}</div>
      ${txHash ? `<div style="margin-top:8px">${linkTx(txHash, "View Transaction ↗")}</div>` : ""}
      <span class="modal-close" style="top:8px;right:10px;">&times;</span>
    </div>`;
  modal.style.display = "flex";
  document.body.appendChild(modal);

  modal.querySelector(".modal-close").onclick = () => modal.remove();
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.remove(); });
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

// ===== RuleDelegation helpers =====
function hasRuleDelegationConfigured() {
  return (CFG && CFG.ruleDelegation && CFG.ruleDelegation !== "");
}
async function getRuleDelegationContract(signerOrProvider) {
  if (!hasRuleDelegationConfigured()) throw new Error("RuleDelegation contract not configured");
  return new ethers.Contract(CFG.ruleDelegation, RULEDELEGATION_ABI, signerOrProvider);
}
async function updateAcContractInfo() {
  const el = $("ac-contract-info");
  if (!el) return;
  if (!hasRuleDelegationConfigured()) {
    el.textContent = "Not configured on this network";
    return;
  }
  el.innerHTML = `<a href="${EXPLORER_ADDR + CFG.ruleDelegation}" target="_blank" rel="noopener">${fmtAddr(CFG.ruleDelegation)}</a>`;
}
async function estimateCreateRuleGas(ruleType = 1, threshold = 0, target = ethers.constants.AddressZero, rewardBps = 5) {
  try {
    if (!roProvider) initReadSide();
    const deleg = await getRuleDelegationContract(roProvider);
    const calldata = deleg.interface.encodeFunctionData("createRule", [ruleType, threshold, target, rewardBps]);
    const estHex = await roProvider.send("eth_estimateGas", [{ to: CFG.ruleDelegation, data: calldata }]);
    const bn = ethers.BigNumber.from(estHex);
    $("ac-gas-est").textContent = `${bn.toString()} wei`;
    return bn;
  } catch (e) {
    $("ac-gas-est").textContent = "estimate failed";
    return null;
  }
}


// ===== Read-side init (NEVER default to localhost) =====
function initReadSide() {
  // prefer local makeRO (ethers Provider) so Contracts can bind to it
  roProvider = (typeof makeRO === "function" ? makeRO(CFG) : (typeof RPCUtils !== "undefined" && RPCUtils.makeReadProvider ? RPCUtils.makeReadProvider(CFG) : null));
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

  window.provider = provider;
  window.signer   = signer;
  window.userAddr = userAddr;


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

  window.provider = provider;
  window.signer   = signer;
  window.userAddr = userAddr;


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

  // fallback if no RO provider
  if (!roProvider || !poolRO) {
    $("stat-apr").textContent = aprCfg ? `${aprCfg}% (target)` : "N/A";
    return aprCfg;
  }

  try {
    const [totalAssets, index] = await Promise.all([
      poolRO.totalAssets(),
      poolRO.index()
    ]);

    if (totalAssets.isZero() || index.isZero()) {
      $("stat-apr").textContent = aprCfg ? `${aprCfg}% (target)` : "N/A";
      return aprCfg;
    }

    // local storage keys
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
        return apr;
      } else {
        const lastAprValue = localStorage.getItem(aprValueKey);
        $("stat-apr").textContent = lastAprValue ? `${lastAprValue} (recent)` : `${aprCfg}% (target)`;
        return aprCfg;
      }
    } else {
      // first-time sample
      localStorage.setItem(aprKey, currentIndex);
      localStorage.setItem(aprTimeKey, now);
      $("stat-apr").textContent = aprCfg ? `${aprCfg}% (target)` : "N/A";
      return aprCfg;
    }
  } catch (e) {
    console.warn("[stake] APR read failed:", e);
    $("stat-apr").textContent = aprCfg ? `${aprCfg}% (target)` : "N/A";
    return aprCfg;
  }
}


  function showAPRInfoModal() {
    const modal = document.getElementById("info-modal");
    const title = document.getElementById("info-modal-title");
    const body  = document.getElementById("info-modal-body");
    if (!modal) return;

    title.textContent = "APR (Annual Percentage Rate)";
    body.innerHTML = `
      <p><b>APR is computed dynamically from pool activity</b> — specifically the stMON index growth over time.</p>
      <p><b>Details:</b><br>
          • If enough history exists, we sample actual yield.<br>
          • If the pool is new/empty, we fall back to the configured target APR.<br>
          • Results update periodically as new blocks accrue.
      </p>
      <p><b>Rebel Pool Advantage:</b><br>
          Transparent, liquid APR with no lockups — unlike vaults where you only see fixed advertised rates.</p>
    `;

    modal.style.display = "flex";
  }


// --------- Balances (RO) ---------
async function getMonBalance(address) {
  if (!roProvider) return "0";
  const balance = await roProvider.getBalance(address);
  return ethers.utils.formatUnits(balance, 18);
}
async function refreshAllBalances() {
  if (!stmonRO) return;
  // if userAddr present, show balances; otherwise show dash
  try {
    if (!userAddr) {
      await updateYieldEstimate();
      return;
    }
    const [monBal, stmonBal] = await Promise.all([
      getMonBalance(userAddr),
      stmonRO.balanceOf(userAddr)
    ]);
    $("balance-mon").textContent   = (+monBal).toFixed(4);
    $("balance-stmon").textContent = parseFloat(ethers.utils.formatUnits(stmonBal, stmonDecimals)).toFixed(4);
    await updateYieldEstimate();
  } catch (e) {
    console.warn("[refreshAllBalances] failed:", e);
  }
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

async function stakeNow() {
  if (busyStake) return;
  busyStake = true;
  try {
    if (!provider || !signer || !userAddr) {
      showStakeModal("Connect your wallet first.");
      return;
    }

    // Check chain
    const wantHex = "0x" + (CFG.chainId || CHAIN_ID_DEC).toString(16);
    if (WALLET_CHAIN_ID_HEX && WALLET_CHAIN_ID_HEX.toLowerCase() !== wantHex.toLowerCase()) {
      showStakeModal(`Wrong network. Switch to Monad Testnet (${parseInt(wantHex,16)}).`);
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

    // Fees
    const fee = await (typeof getNetworkFeeGuessSafe === "function" ? getNetworkFeeGuessSafe() : { eip1559: false, gasPrice: null });
    const feeOverrides = fee.eip1559
      ? { type: 2, maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas }
      : { gasPrice: fee.gasPrice };

    // Router contract
    const router = new ethers.Contract(CFG.router, REBEL_NATIVE_ROUTER_ABI, signer);

    // Estimate gas (safe fallback if fails)
    let gasStake = await router.estimateGas.depositNative(userAddr, { value: parsedAmount })
      .catch(() => ethers.BigNumber.from(180000));
    gasStake = gasStake.mul(118).div(100);

    // Show modal + send tx
    showStakeModal("Staking MON to Rebel Pool" + FEE_HINT_HTML);
    const tx = await sendTxWithRetry(
      (overrides) => router.depositNative(userAddr, { value: parsedAmount, ...overrides }),
      fee,
      gasStake,
      "Staking MON in Rebel Pool"
    );

    updateStakeModal("Waiting for Confirmation…", tx.hash);
    await roProvider.waitForTransaction(tx.hash, 1);

    // Success
    await refreshAllBalances();
    closeStakeModal();
    showCongratsModal();

  } catch (err) {
    console.error("[quickStake] error:", err);
    const msg = typeof friendlyError === "function" ? friendlyError(err) : (err?.message || String(err));
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

// ===== Auto-Compound toggle wiring =====
function openAcModal() {
  const m = $("ac-modal");
  if (!m) return;
  m.style.display = "flex";
  m.setAttribute("aria-hidden", "false");
  updateAcContractInfo();
  estimateCreateRuleGas();
}
function closeAcModal() {
  const m = $("ac-modal");
  if (!m) return;
  m.style.display = "none";
  m.setAttribute("aria-hidden", "true");
}

// ===== INIT =====
async function init() {
  try {
    // 0) Globally wrap ALL injected providers so nothing bypasses queue/backoff
    if (typeof wrapAllInjected === "function") {
      wrapAllInjected({ pre: 400, post: 300, base: 800, maxTries: 6, jitter: 300, debug: true });
    }

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
    $("connect-btn").onclick = async () => {
      const cfg = CFG || await resolveNetConfig();
      showWalletPicker(cfg, async (inj) => {
        injected = inj;
        try { await ensureMonadNetwork(injected, cfg); } catch(e) { console.error(e); return; }

        WALLET_CHAIN_ID_HEX = (injected.chainId || '').toLowerCase?.() || WALLET_CHAIN_ID_HEX;
        provider = new ethers.providers.Web3Provider(injected, "any");
        provider.polling = false; provider.pollingInterval = 20000;

        const accounts = await injected.request({ method: "eth_accounts" });
        userAddr = Array.isArray(accounts) && accounts[0] ? accounts[0] : null;
        if (!userAddr) { alert("No account found in wallet."); return; }

        signer = provider.getSigner(userAddr);
        wmon  = new ethers.Contract(CFG.wmon,    WMON_ABI,    signer);
        stmon = new ethers.Contract(CFG.aquamon, AQUAMON_ABI, signer);
        pool  = new ethers.Contract(CFG.pool,    POOL_ABI,    signer);

        try { const [d1,d2]=await Promise.all([wmonRO.decimals(), stmonRO.decimals()]); wmonDecimals=d1||18; stmonDecimals=d2||18; } catch {}
        await assertWiring();

        $("connect-btn").style.display = "none";
        $("wallet-address").style.display = "block";
        $("wallet-address").innerHTML = `Connected: ${linkAddr(userAddr, fmtAddr(userAddr))}`;

        injected.on?.("accountsChanged", () => location.reload());
        injected.on?.("chainChanged",    () => location.reload());
        injected.on?.("disconnect",      () => location.reload());

        await refreshAllBalances();
      });
    };
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

refreshAcRuleIdUI().catch(()=>{});

window.addEventListener('DOMContentLoaded', init);


// ---------- Helpers: find own rules + latest rule id ----------
async function getOwnRuleIds() {
  if (!hasRuleDelegationConfigured()) return [];
  if (!roProvider) initReadSide();
  const delegRO = await getRuleDelegationContract(roProvider);
  const next = Number((await delegRO.nextRuleId()).toString());
  // get connected owner (try wallet or injected)
  let owner = null;
  try {
    const eth = window.ethereum;
    if (eth) {
      const accts = await eth.request({ method: "eth_accounts" }).catch(()=>[]);
      if (Array.isArray(accts) && accts.length) owner = accts[0].toLowerCase();
    }
  } catch {}
  if (!owner) return [];

  const found = [];
  for (let i = 0; i < next; i++) {
    try {
      const r = await delegRO.rules(i);
      if ((r.owner||"").toLowerCase() === owner) {
        found.push({ ruleId: i, ruleType: Number(r.ruleType), threshold: r.threshold.toString(), target: r.target, rewardBps: Number(r.rewardBps), active: Boolean(r.active) });
      }
    } catch (e) {
      // ignore read failures for specific indices
    }
  }
  return found;
}

async function getLatestOwnRuleId() {
  const arr = await getOwnRuleIds();
  if (!arr || arr.length === 0) return null;
  // pick highest ruleId (most-recent)
  arr.sort((a,b) => b.ruleId - a.ruleId);
  return arr[0].ruleId;
}

// ---------- Approve helper (underlying ERC20) ----------
async function approveUnderlying(amountInput) {
  if (!CFG || !CFG.wmon) {
    alert("Underlying token address not configured for this network.");
    return;
  }
  if (!signer || !userAddr) {
    alert("Connect wallet to approve.");
    return;
  }

  const tokenAddr = CFG.wmon;
  const token = new ethers.Contract(tokenAddr, WMON_ABI, signer);
  let amount;
  if (typeof amountInput === "string" && amountInput.toLowerCase() === "max") {
    amount = MaxUint256;
  } else {
    // try parse decimal amount (assume 18 decimals)
    try {
      amount = ethers.utils.parseUnits(String(amountInput || "0"), wmonDecimals || 18);
    } catch (e) {
      alert("Invalid approve amount.");
      return;
    }
  }

  try {
    const fee = await (typeof getNetworkFeeGuessSafe === "function" ? getNetworkFeeGuessSafe() : { eip1559:false, gasPrice:null });
    let gasEstimate;
    try { gasEstimate = await token.estimateGas.approve(CFG.ruleDelegation, amount, {}); gasEstimate = gasEstimate.mul(120).div(100); } catch(e){ gasEstimate = ethers.BigNumber.from(100000); }
    const tx = await sendTxWithRetry(
      (overrides) => token.approve(CFG.ruleDelegation, amount, { ...overrides, gasLimit: gasEstimate }),
      fee,
      gasEstimate,
      "Approve underlying to RuleDelegation"
    );
    // Wait for confirmation
    if (roProvider) await roProvider.waitForTransaction(tx.hash, 1);
    alert("Approve confirmed. Tx: " + tx.hash);
    return tx;
  } catch (e) {
    console.error("approveUnderlying failed", e);
    alert("Approve failed: " + (typeof friendlyError === "function" ? friendlyError(e) : (e.message||e)));
    throw e;
  }
}

// ---------- Update UI with latest rule id (call after create or at init) ----------
async function refreshAcRuleIdUI() {
  const rid = await getLatestOwnRuleId();
  const ridEl = $("ac-rule-id");
  if (rid !== null && ridEl) {
    ridEl.textContent = `#${rid}`;
    if (toggle) toggle.dataset.ruleId = String(rid);
    if (toggle) {
      toggle.setAttribute("aria-checked", "true");
      $("ac-state").textContent = `On — Delegation rule #${rid}`;
    }
  } else {
    if (ridEl) ridEl.textContent = "none";
    if (toggle) {
      delete toggle.dataset.ruleId;
      toggle.setAttribute("aria-checked", "false");
      $("ac-state").textContent = "Off";
    }
  }
}
