// js/stake.js  (ethers v5.7.x)

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

// ===== State =====
let provider, signer, userAddr, wmon, stmon, pool;
let wmonDecimals = 18, stmonDecimals = 18;
let busyStake = false;

// Cached config/explorer strings (avoid async getters in templating)
let CFG = null;
let EXPLORER_TX = "#";
let EXPLORER_ADDR = "#";
let EXPLORER_TOK = "#";
let CHAIN_ID_DEC = 10143; // default (Monad testnet)

// ===== DOM =====
const $ = (id) => document.getElementById(id);

// ===== Small utils =====
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const esc = (s) => (s||"").toString().replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
function linkTx(hash, text){ return `<a href="${EXPLORER_TX}${hash}" target="_blank" rel="noopener">${esc(text)}</a>`; }
function linkAddr(addr, text){ return `<a href="${EXPLORER_ADDR}${addr}" target="_blank" rel="noopener">${esc(text)}</a>`; }
function fmtAddr(a){ return a ? `${a.slice(0,6)}…${a.slice(-4)}` : ""; }

// ===== Wallet detection (MEW → MetaMask → first) =====
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

// ===== Chain ensure (switch or add) =====
async function ensureMonadNetwork(injected, cfg) {
  const wantHex = "0x" + (cfg.chainId || 10143).toString(16);
  // Already on the right chain?
  try {
    const current = await injected.request({ method: "eth_chainId" });
    if (String(current).toLowerCase() === wantHex.toLowerCase()) return true;
  } catch {}
  // Try switch
  try {
    await injected.request({ method: "wallet_switchEthereumChain", params: [{ chainId: wantHex }] });
    return true;
  } catch (e) {
    // 4902: add chain
    if (e && (e.code === 4902 || /unrecognized chain/i.test(e.message||""))) {
      await injected.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: wantHex,
          chainName: cfg.label || "Monad Testnet",
          nativeCurrency: { name: cfg.coin?.native?.name || "Monad", symbol: cfg.coin?.native?.symbol || "MON", decimals: 18 },
          rpcUrls: (cfg.rpcs && cfg.rpcs.length ? cfg.rpcs : [cfg.rpc]).filter(Boolean),
          blockExplorerUrls: cfg.explorer ? [cfg.explorer] : []
        }]
      });
      // switch again on some wallets
      await injected.request({ method: "wallet_switchEthereumChain", params: [{ chainId: wantHex }] });
      return true;
    }
    if (e && e.code === 4001) throw new Error("User rejected the network switch.");
    throw e;
  }
}

// ===== Read provider for APR reads (use cfg.rpc) =====
function makeReadProvider(cfg) {
  const rpc = (cfg.rpc || (Array.isArray(cfg.rpcs) && cfg.rpcs[0]) || "").trim();
  if (!rpc) return new ethers.providers.JsonRpcProvider(); // will fail-fast if used
  return new ethers.providers.JsonRpcProvider(rpc, { name:"monad-testnet", chainId: cfg.chainId || 10143 });
}

// ===== Modals & UI helpers =====
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

function showStakeModal(msg) {
  let modal = $("stake-modal");
  let msgDiv = $("stake-modal-msg");
  modal.style.display = "flex";
  msgDiv.innerHTML = msg;
}
function updateStakeModal(msg, txHash) {
  let msgDiv = $("stake-modal-msg");
  const link = txHash ? `<br><a href="${EXPLORER_TX}${txHash}" target="_blank" rel="noopener">View on MonadScan</a>` : "";
  msgDiv.innerHTML = msg + link;
}
function closeStakeModal() {
  $("stake-modal").style.display = "none";
}
function showCongratsModal() {
  closeStakeModal();
  let modal = document.createElement("div");
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

// ===== Diagnostics (surface helpful messages) =====
function friendlyError(err) {
  // Try to unwrap common RPC/wallet patterns
  const raw = err?.error?.data ?? err?.data ?? err?.error?.message ?? err?.reason ?? err?.message ?? err;
  let s = typeof raw === "object" ? JSON.stringify(raw) : String(raw);

  if (/(-32005|-32603)/.test(String(err?.code)) || /rate limit|429|too many requests/i.test(s)) {
    return "Request is being rate-limited by the RPC node.<br>Wait a minute and try again. Avoid double-clicking.";
  }
  if (err?.code === -32002 || /already processing/i.test(s)) {
    return "Your wallet is already handling a request.<br>Open your wallet and complete/close the pending prompt.";
  }
  if (err?.code === 4001 || /user rejected/i.test(s)) {
    return "You rejected the request in your wallet.";
  }
  if (/insufficient funds/i.test(s)) {
    return "Insufficient MON for this stake (or gas).";
  }
  if (/nonce too low/i.test(s)) {
    return "Wallet nonce is out of sync. Wait a moment or reset nonce, then retry.";
  }
  if (/wrong network|chain id/i.test(s)) {
    return "Wrong network selected in wallet. Please switch to Monad Testnet (10143).";
  }
  return esc(s || "Unknown error");
}
function showErrorModal(err) {
  const msg = friendlyError(err);
  updateStakeModal(`Error: ${msg}<br><button onclick="closeStakeModal()">Close</button>`);
  $("stake-status").textContent = `Error: ${msg.replace(/<br>/g, " ")}`;
}

// ===== Wiring self-checks =====
async function assertWiring() {
  if (!pool || !CFG) return;
  try {
    const [u, a] = await Promise.all([ pool.underlying(), pool.aquaToken() ]);
    const mismatch = u.toLowerCase() !== CFG.wmon.toLowerCase() || a.toLowerCase() !== CFG.aquamon.toLowerCase();
    if (mismatch) {
      showStakeModal(
        "Address config mismatch detected.<br>" +
        "UI constants do not match Pool wiring.<br>" +
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

// ===== Connect Wallet (hardened) =====
async function connectWallet() {
  CFG = await getNetConfig(); // from chain.js
  CHAIN_ID_DEC = CFG?.chainId || 10143;
  EXPLORER_TX   = CFG?.explorer ? `${CFG.explorer}/tx/` : "#";
  EXPLORER_ADDR = CFG?.explorer ? `${CFG.explorer}/address/` : "#";
  EXPLORER_TOK  = CFG?.explorer ? `${CFG.explorer}/token/` : "#";

  const pick = pickInjectedProvider();
  if (!pick) { alert("No wallet found. Please install MEW or MetaMask."); return; }
  const injected = pick.provider;

  // Ensure chain (switch/add)
  try { await ensureMonadNetwork(injected, CFG); }
  catch (e) { console.error("[stake] ensureMonadNetwork:", e); alert("Could not switch/add Monad Testnet in your wallet."); return; }

  // Request accounts
  try { await injected.request({ method: "eth_requestAccounts" }); }
  catch (e) {
    if (e?.code === -32002) alert("Wallet is already processing a request. Open your wallet and finish the pending prompt.");
    else if (e?.code === 4001) alert("You rejected the connection request.");
    else alert("Wallet connection failed.");
    return;
  }

  // Wire ethers
  provider = new ethers.providers.Web3Provider(injected, "any");
  signer   = provider.getSigner();
  userAddr = await signer.getAddress();

  // Instantiate contracts
  wmon  = new ethers.Contract(CFG.wmon,    WMON_ABI,     signer);
  stmon = new ethers.Contract(CFG.aquamon, AQUAMON_ABI,  signer);
  pool  = new ethers.Contract(CFG.pool,    POOL_ABI,     signer);

  // Decimals (best-effort)
  try {
    const [d1, d2] = await Promise.all([ wmon.decimals(), stmon.decimals() ]);
    wmonDecimals = d1 || 18; stmonDecimals = d2 || 18;
  } catch {}

  // Wiring check
  await assertWiring();

  // UI
  $("connect-btn").style.display = "none";
  $("wallet-address").style.display = "block";
  $("wallet-address").innerHTML = `Connected: ${linkAddr(userAddr, fmtAddr(userAddr))}`;

  // Events (reload on account/chain changes keeps it simple)
  if (injected && injected.on) {
    injected.on("accountsChanged", () => location.reload());
    injected.on("chainChanged",    () => location.reload());
    injected.on("disconnect",      () => location.reload());
  }

  await refreshAllBalances();
}

// ===== APR & Yield =====
async function updateAprAndYield() {
  try {
    const cfg = CFG || await getNetConfig();
    const POOL_ADDR = cfg.pool;
    let apr = (typeof cfg.apr === "number") ? cfg.apr : 0;

    const roProvider = makeReadProvider(cfg);
    const poolC = new ethers.Contract(POOL_ADDR, POOL_ABI, roProvider);
    const [totalAssets, index] = await Promise.all([ poolC.totalAssets(), poolC.index() ]);

    if (totalAssets.isZero() || index.isZero()) {
      $("stat-apr").textContent = apr ? apr + "% (target)" : "N/A";
      $("apr-hint").title = "Pool is too new or empty for real APR, showing config target.";
      return apr;
    }

    const aprKey = `aprSample_${POOL_ADDR}_${cfg.label}`;
    const aprTimeKey = `aprSampleTime_${POOL_ADDR}_${cfg.label}`;
    const aprValueKey = `aprValue_${POOL_ADDR}_${cfg.label}`;
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
        apr = ((currentIndex / lastSample - 1) * (31557600 / elapsed)) * 100;
        const display = (apr > 100 ? "100%+" : apr.toFixed(2) + "%");
        localStorage.setItem(aprKey, currentIndex);
        localStorage.setItem(aprTimeKey, now);
        localStorage.setItem(aprValueKey, display);
        $("stat-apr").textContent = display;
        $("apr-hint").title = "APR computed from pool index over last period.";
      } else {
        const lastAprValue = localStorage.getItem(aprValueKey);
        $("stat-apr").textContent = lastAprValue ? lastAprValue + " (recent)" : (apr + "% (target)");
        $("apr-hint").title = "Showing most recent computed APR or config target.";
      }
    } else {
      localStorage.setItem(aprKey, currentIndex);
      localStorage.setItem(aprTimeKey, now);
      $("stat-apr").textContent = apr ? apr + "% (target)" : "N/A";
      $("apr-hint").title = "No yield yet, showing config target.";
    }
    return apr;
  } catch (e) {
    const apr = (CFG && typeof CFG.apr === "number") ? CFG.apr : 0;
    $("stat-apr").textContent = apr ? apr + "% (target)" : "N/A";
    $("apr-hint").title = "APR unavailable, showing config target.";
    return apr;
  }
}

// --------- Balances ---------
async function getMonBalance(address) {
  if (!provider) return "0";
  const balance = await provider.getBalance(address);
  return ethers.utils.formatUnits(balance, 18);
}

async function refreshAllBalances() {
  if (!userAddr || !stmon) return;
  const [monBal, stmonBal] = await Promise.all([
    getMonBalance(userAddr),
    stmon.balanceOf(userAddr)
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

// --------- Stake Flow ---------
async function stakeNow() {
  if (busyStake) return;
  busyStake = true;
  try {
    if (!provider || !signer || !pool || !wmon) {
      showStakeModal("Connect your wallet first.");
      busyStake = false; return;
    }

    // Verify correct network (defense in depth)
    const net = await provider.getNetwork();
    if (Number(net.chainId) !== Number(CHAIN_ID_DEC)) {
      showStakeModal(`Wrong network (chainId=${net.chainId}). Switch to Monad Testnet (${CHAIN_ID_DEC}).`);
      busyStake = false; return;
    }

    const amountStr = $("stake-amount").value;
    if (!amountStr || isNaN(+amountStr) || +amountStr <= 0) {
      showStakeModal("Enter an amount to stake.");
      $("stake-status").textContent = "Enter amount";
      busyStake = false; return;
    }

    const parsedAmount = ethers.utils.parseUnits(amountStr, 18);

    // Funds check
    const monBalWei = await provider.getBalance(userAddr);
    if (monBalWei.lt(parsedAmount)) {
      showStakeModal("Insufficient funds for this amount.");
      busyStake = false; return;
    }

    // Pool paused?
    const isPaused = await pool.paused().catch(() => false);
    if (isPaused) {
      showStakeModal("Pool is paused. Try again later.");
      busyStake = false; return;
    }

    // Wrap MON -> WMON
    showStakeModal("Wrapping MON to WMON…");
    const tx1 = await wmon.deposit({ value: parsedAmount });
    updateStakeModal("Waiting for confirmation…", tx1.hash);
    await tx1.wait();
    await sleep(1200);

    // Approve pool if needed
    updateStakeModal("Approving WMON for Pool…");
    const poolAddr = CFG.pool; // cached cfg
    const currentAllowance = await wmon.allowance(userAddr, poolAddr);
    if (currentAllowance.lt(parsedAmount)) {
      const approveTx = await wmon.approve(poolAddr, parsedAmount);
      updateStakeModal("Waiting for approval…", approveTx.hash);
      await approveTx.wait();
      await sleep(1200);
    }

    // Stake WMON in Pool
    updateStakeModal("Staking WMON in Pool…");
    const stakeTx = await pool.deposit(parsedAmount, userAddr);
    updateStakeModal("Waiting for confirmation…", stakeTx.hash);
    await stakeTx.wait();

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
    showErrorModal(err);
  } finally {
    busyStake = false;
  }
}

// --------- INIT ---------
async function init() {
  // Network selector + initial state
  if (window.renderNetworkSelector) renderNetworkSelector("network-select", () => location.reload());

  $("connect-btn").style.display = "block";
  $("wallet-address").style.display = "none";

  // Cache config & explorer strings
  CFG = await getNetConfig();
  CHAIN_ID_DEC = CFG?.chainId || 10143;
  EXPLORER_TX   = CFG?.explorer ? `${CFG.explorer}/tx/` : "#";
  EXPLORER_ADDR = CFG?.explorer ? `${CFG.explorer}/address/` : "#";
  EXPLORER_TOK  = CFG?.explorer ? `${CFG.explorer}/token/` : "#";

  if (CFG.disabled) {
    $("stake-btn").disabled = true;
    $("stake-status").textContent = "This network is not active.";
    return;
  }

  // Silent auto-connect if already authorized
  if (window.ethereum) {
    try {
      const accounts = await window.ethereum.request({ method: 'eth_accounts' });
      if (Array.isArray(accounts) && accounts.length > 0) await connectWallet();
    } catch {}
  }

  // Wire buttons
  $("connect-btn").onclick = connectWallet;
  $("stake-btn").onclick   = stakeNow;

  // Post-connect UI (if connected already)
  if (userAddr) {
    $("connect-btn").style.display = "none";
    $("wallet-address").style.display = "block";
    $("wallet-address").innerHTML = `Connected: ${linkAddr(userAddr, fmtAddr(userAddr))}`;
    await refreshAllBalances();
  } else {
    await updateYieldEstimate(); // still show APR & projections
  }
}

window.addEventListener('DOMContentLoaded', init);

// === Helper: Add token to MetaMask (stMON / WMON) ===
async function addTokenToMetaMask(tokenOrAddress, symbolOpt, decimalsOpt) {
  if (!window.ethereum) { console.error("MetaMask not found."); return; }
  const cfg = CFG || await getNetConfig();
  let address, symbol = symbolOpt, decimals = decimalsOpt ?? 18;
  const isAddr = typeof tokenOrAddress === "string"
              && tokenOrAddress.startsWith("0x")
              && tokenOrAddress.length === 42;
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
