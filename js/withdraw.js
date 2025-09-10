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

let provider, signer, user, wmon, pool, aqua;
let wmonDec = 18, stDec = 18;
let busyWithdraw = false;

const $ = (id) => document.getElementById(id);

async function getExplorer(type) {
  const cfg = await getNetConfig();
  if (!cfg.explorer) return "#";
  if (type === "tx") return `${cfg.explorer}/tx/`;
  if (type === "addr") return `${cfg.explorer}/address/`;
  if (type === "tok") return `${cfg.explorer}/token/`;
  return "#";
}
const linkTx = (hash, text) => `<a href="${getExplorer("tx")}${hash}" target="_blank" rel="noopener">${text}</a>`;
const linkAddr = (addr, text) => `<a href="${getExplorer("addr")}${addr}" target="_blank" rel="noopener">${text}</a>`;
function setDisabled(el, disabled) { if (!el) return; disabled ? el.setAttribute("disabled","disabled") : el.removeAttribute("disabled"); }

const byeMsgs = [
  "Withdrawal complete. \n Sorry to see you go, come back anytime!",
  "Funds returned! Hope to see you again at Rebel Pool.",
  "Your MON is on its way. Thanks for staking with us!",
  "We’re sorry to see you go. \n (It’s not us, it’s you, but you’re always welcome back!)",
  "Withdrawal successful. \n Feeling FOMO yet? You know where to find us.",
  "Unstaking complete. Sometimes you have to break up to make up.",
  "Another rebel takes a pause. \n Remember, the pool is always open for your return.",
  "Funds unstaked. \n Go out there and make trouble, but don’t be a stranger!",
  "Done! \n Whether you stake or withdraw, you’re part of the movement."
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

function showModal(msg) { $("withdraw-modal").style.display = "flex"; $("withdraw-modal-msg").innerHTML = msg; }
function updateModal(msg, txHash) {
  $("withdraw-modal-msg").innerHTML = msg + (txHash ? `<br><a href="${getExplorer("tx")}${txHash}" target="_blank">View on MonadScan</a>` : "");
}
function closeModal() { $("withdraw-modal").style.display = "none"; }

// Sanity 
async function assertWiring() {
  const cfg = await getNetConfig();
  const [u, a] = await Promise.all([pool.underlying(), pool.aquaToken()]);
  const mismatch = (
    u.toLowerCase() !== cfg.wmon.toLowerCase() ||
    a.toLowerCase() !== cfg.aquamon.toLowerCase()
  );
  if (mismatch) {
    showModal(
      "=> Address config mismatch. <=<br>" +
      `Pool.underlying(): ${linkAddr(u,u)}<br>` +
      `Pool.aquaToken(): ${linkAddr(a,a)}<br>` +
      "Update chain.js addresses and reload."
    );
    throw new Error("Address config mismatch");
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}


async function connectWallet() {
  const cfg = await getNetConfig();
  if (!window.ethereum) { alert("No wallet found (install MetaMask or similar)"); return; }
  await ethereum.request({ method: "eth_requestAccounts" });

  provider = new ethers.providers.Web3Provider(window.ethereum);
  provider.pollingInterval = 12000;
  signer   = provider.getSigner();
  user     = await signer.getAddress();

  wmon = new ethers.Contract(cfg.wmon, WMON_ABI, signer);
  pool = new ethers.Contract(cfg.pool, POOL_ABI, signer);
  aqua = new ethers.Contract(cfg.aquamon, AQUAMON_ABI, signer);

  try { [wmonDec, stDec] = await Promise.all([wmon.decimals(), aqua.decimals()]); } catch {}

  await assertWiring();

  $("connect-btn").style.display    = "none";
  $("wallet-address").style.display = "block";
  $("wallet-address").innerHTML = `Connected: ${linkAddr(user, user.slice(0,6)+"..."+user.slice(-4))}`;

  if (window.ethereum?.on) {
    window.ethereum.on('accountsChanged', () => location.reload());
    window.ethereum.on('chainChanged',   () => location.reload());
  }
  await refreshBalancesThrottled();
}

async function getMonBalance(addr) {
  if (!provider) return "0.0";
  const bal = await provider.getBalance(addr);
  return ethers.utils.formatUnits(bal, 18);
}
async function refreshBalancesAndPreviews() {
  if (!user) return;
  try {
    const [monBal, stBal] = await Promise.all([
      getMonBalance(user),
      aqua.balanceOf(user)
    ]);
    $("balance-mon").textContent   = (+monBal).toFixed(4);
    $("balance-stmon").textContent = parseFloat(ethers.utils.formatUnits(stBal, stDec)).toFixed(4);
    const val = $("withdraw-assets").value;
    if (val && !isNaN(val) && Number(val) > 0) {
      const assetsWei = ethers.utils.parseUnits(val, 18);
      const shares = await pool.convertToShares(assetsWei);
      $("preview-line").textContent = `Will burn ~${ethers.utils.formatUnits(shares,18)} shares for ${val} MON.`;
    } else {
      $("preview-line").textContent = "";
    }
  } catch (e) { console.error("refresh error:", e); }
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

async function setMaxWithdraw() {
  if (!pool || !user) return;
  const maxW = await pool.maxWithdraw(user); // assets in wei
  if (maxW.isZero()) { $("withdraw-assets").value = ""; $("preview-line").textContent = ""; return; }
  const safe = maxW.sub(1); 
  $("withdraw-assets").value = ethers.utils.formatUnits(safe, 18);
  await refreshBalancesAndPreviews();
}

async function withdrawNow() {
  if (busyWithdraw) return;
  busyWithdraw = true;
  setDisabled($("withdraw-btn"), true);
  try {
    const amountStr = $("withdraw-assets").value;
    if (!amountStr || isNaN(amountStr) || Number(amountStr) <= 0) {
      $("withdraw-status").textContent = "Enter a withdraw amount.";
      return;
    }
    const cfg = await getNetConfig();
    const net = await provider.getNetwork();
    if (net.chainId !== 10143) {
      showModal(`Wrong network (chainId=${net.chainId}). Switch to Monad testnet (10143).`);
      return;
    }
    let assetsWei = ethers.utils.parseUnits(amountStr, 18);
    const isPaused = await pool.paused().catch(() => false);
    if (isPaused) { showModal("Pool is paused. Try again later."); return; }
    
    const maxW = await pool.maxWithdraw(user);
    if (maxW.isZero()) { $("withdraw-status").textContent = "Nothing available to withdraw."; return; }
    if (assetsWei.gt(maxW)) assetsWei = maxW.sub(1);
    if (assetsWei.lte(0)) { $("withdraw-status").textContent = "Amount too small."; return; }
    
    const sharesNeeded = await pool.convertToShares(assetsWei);
    if (sharesNeeded.isZero()) { $("withdraw-status").textContent = "Amount too small (rounds to 0 shares)."; return; }

    const currentAllow = await aqua.allowance(user, cfg.pool);
    if (currentAllow.lt(sharesNeeded)) {
      showModal("Approving stMON for withdrawal (one-time)...");
      const approveTx = await aqua.approve(cfg.pool, ethers.constants.MaxUint256);
      updateModal("Waiting for approval confirmation…", approveTx.hash);
      await approveTx.wait();
      await sleep(STEP_DELAY); 
    }

    await sleep(STEP_DELAY);    
    await pool.callStatic.withdraw(assetsWei, user, user);

    showModal("Withdrawing… Please confirm in MetaMask.");
    await sleep(STEP_DELAY);    
    const tx = await pool.withdraw(assetsWei, user, user);
    updateModal("Waiting for withdrawal confirmation…", tx.hash);
    await tx.wait();
    await sleep(STEP_DELAY);

    const wmonBal = await wmon.balanceOf(user);
    if (wmonBal.gt(0)) {
      updateModal("Finalizing: delivering MON…");
      await sleep(STEP_DELAY);
      const tx2 = await wmon.withdraw(wmonBal);
      updateModal("Waiting for final confirmation…", tx2.hash);
      await tx2.wait();
      $("withdraw-status").innerHTML = `Withdrawn ~${ethers.utils.formatUnits(wmonBal, 18)} MON. ${linkTx(tx2.hash, "view tx")}`;
    } else {
      $("withdraw-status").textContent = `Withdrawn ${ethers.utils.formatUnits(assetsWei,18)} MON.`;
    }
    closeModal();
    $("withdraw-assets").value = "";
    await refreshBalancesThrottled();
    showGoodbyeModal();
  } catch (err) {
    console.error("Withdraw error:", err);
    const raw = err?.error?.data ?? err?.data ?? err?.error?.message ?? err?.reason ?? err?.message ?? String(err);
    updateModal(`Error: ${raw}<br><button onclick="closeModal()">Close</button>`);
    $("withdraw-status").textContent = `Error: ${raw}`;
  } finally {
    busyWithdraw = false;
    setDisabled($("withdraw-btn"), false);
  }
}

async function init() {
  renderNetworkSelector("network-select", () => location.reload());
  $("connect-btn").style.display = "block";
  $("wallet-address").style.display = "none";
  $("connect-btn").onclick = connectWallet;
  $("withdraw-btn").onclick = withdrawNow;
  const maxBtn = $("withdraw-max");
  if (maxBtn) maxBtn.onclick = setMaxWithdraw;
  const input = $("withdraw-assets");
  if (input) input.oninput = debounce(refreshBalancesAndPreviews, 400);
  if (window.ethereum) {
    const accounts = await window.ethereum.request({ method: "eth_accounts" });
    if (accounts.length > 0) await connectWallet();
  }
}
window.addEventListener("DOMContentLoaded", init);
