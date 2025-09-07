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

let provider, signer, userAddr, wmon, stmon, pool;
let wmonDecimals = 18, stmonDecimals = 18;
let busyStake = false;

const $ = (id) => document.getElementById(id);

function getExplorer(type) {
  const cfg = getNetConfig();
  if (!cfg.explorer) return "#";
  if (type === "tx") return `${cfg.explorer}/tx/`;
  if (type === "addr") return `${cfg.explorer}/address/`;
  if (type === "tok") return `${cfg.explorer}/token/`;
  return "#";
}
const linkTx = (hash, text) => `<a href="${getExplorer("tx")}${hash}" target="_blank" rel="noopener">${text}</a>`;
const linkAddr = (addr, text) => `<a href="${getExplorer("addr")}${addr}" target="_blank" rel="noopener">${text}</a>`;

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
  msgDiv.innerHTML = msg + (txHash ? `<br><a href="${getExplorer("tx")}${txHash}" target="_blank">View on MonadScan</a>` : "");
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

async function assertWiring() {
  const cfg = getNetConfig();
  try {
    const [u, a] = await Promise.all([
      pool.underlying(),
      pool.aquaToken()
    ]);
    const mismatch =
      u.toLowerCase() !== cfg.wmon.toLowerCase() ||
      a.toLowerCase() !== cfg.aquamon.toLowerCase();
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
    console.error("Wiring check failed:", e);
    throw e;
  }
}

async function connectWallet() {
  const cfg = getNetConfig();
  if (!window.ethereum) { alert("No wallet found (install MetaMask or similar)"); return; }
  await ethereum.request({ method: 'eth_requestAccounts' });

  provider = new ethers.providers.Web3Provider(window.ethereum);
  signer   = provider.getSigner();
  userAddr = await signer.getAddress();

  wmon  = new ethers.Contract(cfg.wmon, WMON_ABI, signer);
  stmon = new ethers.Contract(cfg.aquamon, AQUAMON_ABI, signer);
  pool  = new ethers.Contract(cfg.pool, POOL_ABI, signer);

  // decimals (safe default 18 if fail)
  try {
    [wmonDecimals, stmonDecimals] = await Promise.all([
      wmon.decimals(),
      stmon.decimals()
    ]);
  } catch (_) {}

  await assertWiring();

  $("connect-btn").style.display = "none";
  $("wallet-address").style.display = "block";
  $("wallet-address").innerHTML = `Connected: ${linkAddr(userAddr, userAddr.slice(0,6)+"..."+userAddr.slice(-4))}`;
  const stLink = document.getElementById("view-stmon-link");
  if (stLink) stLink.href = `${getExplorer("tok")}${cfg.aquamon}`;

  if (window.ethereum && window.ethereum.on) {
    window.ethereum.on('accountsChanged', () => location.reload());
    window.ethereum.on('chainChanged',   () => location.reload());
  }

  await refreshAllBalances();
}

async function updateAprAndYield() {
  const cfg = getNetConfig();
  const POOL_ADDR = cfg.pool;
  const MONAD_RPC = cfg.rpc;
  let apr = (typeof cfg.apr === "number") ? cfg.apr : 0;
  let aprType = "target";
  try {
    const provider = new ethers.providers.JsonRpcProvider(MONAD_RPC);
    const poolC = new ethers.Contract(POOL_ADDR, POOL_ABI, provider);
    const [totalAssets, index] = await Promise.all([
      poolC.totalAssets(),
      poolC.index()
    ]);
    if (totalAssets.isZero() || index.isZero()) {
      $("stat-apr").textContent = apr ? apr + "% (target)" : "N/A";
      $("apr-hint").title = "Pool is too new or empty for real APR, showing config target.";
      return apr;
    }
    const aprKey = `aprSample_${POOL_ADDR}_${cfg.label}`;
    const aprTimeKey = `aprSampleTime_${POOL_ADDR}_${cfg.label}`;
    const aprValueKey = `aprValue_${POOL_ADDR}_${cfg.label}`;
    const minSampleWindow = 3600; // 1hr minimum
    const now = Date.now() / 1000;
    let lastSample = localStorage.getItem(aprKey);
    let lastSampleTime = localStorage.getItem(aprTimeKey);
    let currentIndex = Number(index) / 1e18;
    let display = null;

    if (lastSample && lastSampleTime) {
      lastSample = parseFloat(lastSample);
      lastSampleTime = parseFloat(lastSampleTime);
      if (currentIndex > lastSample && now > lastSampleTime + minSampleWindow) {
        const elapsed = now - lastSampleTime;
        apr = ((currentIndex / lastSample - 1) * (31557600 / elapsed)) * 100;
        aprType = "computed";
        display = (apr > 100 ? "100%+" : apr.toFixed(2) + "%");
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
    $("stat-apr").textContent = apr ? apr + "% (target)" : "N/A";
    $("apr-hint").title = "APR unavailable, showing config target.";
    return apr;
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// --------- Balances ---------
async function getMonBalance(address) {
  if (!provider) return "–";
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

// --------- Stake Flow (unchanged) ---------
async function stakeNow() {
  if (busyStake) return;
  busyStake = true;
  try {
    const amountStr = $("stake-amount").value;
    if (!amountStr || isNaN(amountStr) || Number(amountStr) <= 0) {
      showStakeModal("Enter an amount to stake.");
      $("stake-status").textContent = "Enter amount";
      busyStake = false;
      return;
    }
    const net = await provider.getNetwork();
    if (net.chainId !== 10143) {
      showStakeModal(`Wrong network (chainId=${net.chainId}). Switch to Monad testnet (10143).`);
      busyStake = false;
      return;
    }
    const parsedAmount = ethers.utils.parseUnits(amountStr, 18);
    const monBalWei = await provider.getBalance(userAddr);
    if (monBalWei.lt(parsedAmount)) {
      showStakeModal("Insufficient Funds");
      busyStake = false;
      return;
    }
    const isPaused = await pool.paused().catch(() => false);
    if (isPaused) {
      showStakeModal("Pool is paused. Try again later.");
      busyStake = false;
      return;
    }
showStakeModal("Wrapping MON to WMON...");
const tx1 = await wmon.deposit({ value: parsedAmount });
updateStakeModal("Waiting for confirmation...", tx1.hash);
await tx1.wait();
await sleep(1200);

updateStakeModal("Approving WMON Wrapping...");
const currentAllowance = await wmon.allowance(userAddr, getNetConfig().pool);
if (currentAllowance.lt(parsedAmount)) {
  const approveTx = await wmon.approve(getNetConfig().pool, parsedAmount);
  updateStakeModal("Waiting for approval...", approveTx.hash);
  await approveTx.wait();
  await sleep(1200);
}

updateStakeModal("Staking WMON in Pool...");
const stakeTx = await pool.deposit(parsedAmount, userAddr);
updateStakeModal("Waiting for confirmation...", stakeTx.hash);
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
    console.error("Stake error:", err);
    let raw = err?.error?.data ?? err?.data ?? err?.error?.message ?? err?.reason ?? err?.message;
    if (!raw) {
      // If it's an object, try to stringify
      raw = typeof err === "object" ? JSON.stringify(err, null, 2) : String(err);
    }

    // If it's a rate limit error, show a friendly message
    if (
      (raw && /rate limit|429|too many requests/i.test(raw)) ||
      err?.code === -32005 ||
      err?.code === -32603
    ) {
      raw = "Request is being rate-limited by the RPC node.<br>Wait a few minutes and try again.<br>If this happens often, slow down your dashboard polling and avoid clicking multiple times.";
    }

    updateStakeModal(`Error: ${raw}<br><button onclick="closeStakeModal()">Close</button>`);
    $("stake-status").textContent = `Error: ${raw.replace(/<br>/g, " ")}`;
  } finally {
    busyStake = false;
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
  $("est-24h").textContent  = formatEstimate(stBal, apr, 1);
  $("est-week").textContent = formatEstimate(stBal, apr, 7);
  $("est-month").textContent= formatEstimate(stBal, apr, 30);
  $("est-year").textContent = formatEstimate(stBal, apr, 365);
}

// --------- INIT ---------
async function init() {
  renderNetworkSelector("network-select", () => location.reload());
  $("connect-btn").style.display = "block";
  $("wallet-address").style.display = "none";
  const cfg = getNetConfig();
  if (cfg.disabled) {
    $("stake-btn").disabled = true;
    $("stake-status").textContent = "This network is not active.";
    return;
  }
  if (window.ethereum) {
    const accounts = await window.ethereum.request({ method: 'eth_accounts' });
    if (accounts.length > 0) await connectWallet();
  }
  $("connect-btn").onclick = connectWallet;
  $("stake-btn").onclick   = stakeNow;
  if (userAddr) {
    $("connect-btn").style.display = "none";
    $("wallet-address").style.display = "block";
    $("wallet-address").innerHTML =
      `Connected: ${linkAddr(userAddr, userAddr.slice(0,6)+"..."+userAddr.slice(-4))}`;
    await refreshAllBalances();
  } else {
    await updateYieldEstimate();
  }
}

window.addEventListener('DOMContentLoaded', init);

// === Helper: Add token to MetaMask (stMON only on this page) ===
async function addTokenToMetaMask(tokenOrAddress, symbolOpt, decimalsOpt) {
  if (!window.ethereum) {
    console.error("MetaMask not found.");
    return;
  }
  const cfg = getNetConfig();
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
