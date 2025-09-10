const AUTO_CLOSE_MS = 1600; 

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

let provider, signer, userAddr, stmon, arcmon;
let stmonDecimals = 18, arcmonDecimals = 18;

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

function openStatus(title, body) {
  const modal = $("wrap-modal");
  const msg   = $("wrap-modal-msg");
  msg.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
      <div style="width:10px;height:10px;border-radius:50%;background:#1a73e8;animation:pulse 1.2s infinite;"></div>
      <b>${escapeHtml(title)}</b>
    </div>
    <div>${body || ""}</div>
    <div id="status-extra" style="margin-top:10px;font-size:0.95em;color:#555;"></div>
    <style>@keyframes pulse{0%{opacity:.3}50%{opacity:1}100%{opacity:.3}}</style>
  `;
  modal.style.display = "flex";
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function updateStatus(body, extraHtml = "") {
  const msg = $("wrap-modal-msg");
  if (!msg) return;
  const container = msg.querySelector("div:nth-child(2)");
  if (container) container.innerHTML = body;
  const extra = $("status-extra");
  if (extra) extra.innerHTML = extraHtml;
}
function closeWrapModal() {
  const modal = $("wrap-modal");
  if (modal) modal.style.display = "none";
}
function autoCloseModal() { setTimeout(closeWrapModal, AUTO_CLOSE_MS); }

// ------- Wallet connect -------
async function connectWallet() {
  const cfg = await getNetConfig();
  if (!window.ethereum) { alert("No wallet found (install MetaMask or similar)"); return; }
  await ethereum.request({ method: 'eth_requestAccounts' });

  provider = new ethers.providers.Web3Provider(window.ethereum);
  signer   = provider.getSigner();
  userAddr = await signer.getAddress();

  stmon  = new ethers.Contract(cfg.aquamon, AQUAMON_ABI, signer);
  arcmon = new ethers.Contract(cfg.arcmon,  ARCMON_ABI,  signer);

  try {
    [stmonDecimals, arcmonDecimals] = await Promise.all([
      stmon.decimals().catch(() => 18),
      arcmon.decimals().catch(() => 18),
    ]);
  } catch {}

  $("connect-btn").style.display = "none";
  $("wallet-address").style.display = "block";
  $("wallet-address").innerHTML = `Connected: ${linkAddr(userAddr, userAddr.slice(0,6)+"..."+userAddr.slice(-4))}`;

  if (window.ethereum?.on) {
    window.ethereum.on('accountsChanged', () => location.reload());
    window.ethereum.on('chainChanged',   () => location.reload());
  }
  await refreshAll();
}

async function refreshAll() {
  if (!stmon || !arcmon || !userAddr) return;
  try {
    const [stBal, wstBal, exch] = await Promise.all([
      stmon.balanceOf(userAddr),
      arcmon.balanceOf(userAddr),
      arcmon.exchangeRate()
    ]);
    $("balance-stmon").textContent  = parseFloat(ethers.utils.formatUnits(stBal,  stmonDecimals)).toFixed(4);
    $("balance-wstmon").textContent = parseFloat(ethers.utils.formatUnits(wstBal, arcmonDecimals)).toFixed(4);
    $("exchange-rate").textContent  = (Number(exch) / 1e18).toFixed(6);
  } catch {}
}

// ------- Allowance helper -------
async function ensureAllowance(token, owner, spender, amountBN) {
  const current = await token.allowance(owner, spender);
  if (current.gte(amountBN)) return null;
  if (current.gt(0)) {
    const tx0 = await token.approve(spender, ethers.constants.Zero);
    await tx0.wait();
  }
  const tx = await token.approve(spender, amountBN);
  return await tx.wait();
}

async function wrapWstmon() {
  const cfg = await getNetConfig();
  const ui = $("wrap-wstmon-status");
  try {
    const amountStr = $("wrap-wstmon-amount").value;
    if (!amountStr || isNaN(amountStr) || Number(amountStr) <= 0) {
      ui.textContent = "Enter amount";
      return;
    }
    const parsed = ethers.utils.parseUnits(amountStr, stmonDecimals);

    openStatus("Wrapping stMON → wstMON", "Checking balance & allowance…");
    await ensureAllowance(stmon, userAddr, cfg.arcmon, parsed);
    await sleep(STEP_DELAY); 

    updateStatus("Wrapping… Please confirm transaction in your wallet.");
    const tx  = await arcmon.wrap(parsed, userAddr);
    ui.innerHTML = `Sent: ${linkTx(tx.hash, "pending tx")}`;
    updateStatus("Transaction sent. Waiting for confirmation…");

    await sleep(STEP_DELAY); 
    const r = await tx.wait();
    ui.innerHTML = `Wrapped! ${linkTx(r.transactionHash, "view tx")}`;
    updateStatus("Success", `: ${linkTx(r.transactionHash, "view on explorer")}`);

    $("wrap-wstmon-amount").value = "";
    await refreshAll();
    autoCloseModal();
  } catch (err) {
    ui.textContent = "Error: " + extractReadableError(err);
    updateStatus("Failed", `<div style="color:#b00;">${escapeHtml(extractReadableError(err))}</div>`);
    autoCloseModal();
  }
}

async function unwrapWstmon() {
  const ui = $("unwrap-wstmon-status");
  try {
    const amountStr = $("unwrap-wstmon-amount").value;
    if (!amountStr || isNaN(amountStr) || Number(amountStr) <= 0) {
      ui.textContent = "Enter amount";
      return;
    }
    const parsed = ethers.utils.parseUnits(amountStr, arcmonDecimals);

    openStatus("Unwrapping wstMON → stMON", "Checking balance…");
    await sleep(STEP_DELAY); 
    updateStatus("Unwrapping… Please confirm transaction in your wallet.");

    const tx  = await arcmon.unwrap(parsed, userAddr);
    ui.innerHTML = `Sent: ${linkTx(tx.hash, "pending tx")}`;
    updateStatus("Transaction sent. Waiting for confirmation…");

    await sleep(STEP_DELAY); 
    const r  = await tx.wait();
    ui.innerHTML = `Unwrapped! ${linkTx(r.transactionHash, "view tx")}`;
    updateStatus("Success", `Mined: ${linkTx(r.transactionHash, "view on explorer")}`);

    $("unwrap-wstmon-amount").value = "";
    await refreshAll();
    autoCloseModal();
  } catch (err) {
    ui.textContent = "Error: " + extractReadableError(err);
    updateStatus("Failed", `<div style="color:#b00;">${escapeHtml(extractReadableError(err))}</div>`);
    autoCloseModal();
  }
}


async function fillMaxWrap() {
  if (!stmon || !userAddr) return;
  const bal = await stmon.balanceOf(userAddr);
  $("wrap-wstmon-amount").value = ethers.utils.formatUnits(bal, stmonDecimals);
}
async function fillMaxUnwrap() {
  if (!arcmon || !userAddr) return;
  const bal = await arcmon.balanceOf(userAddr);
  $("unwrap-wstmon-amount").value = ethers.utils.formatUnits(bal, arcmonDecimals);
}

async function addWstmonToMetaMask() {
  const cfg = await getNetConfig();
  if (!window.ethereum) return;
  try {
    await window.ethereum.request({
      method: "wallet_watchAsset",
      params: {
        type: "ERC20",
        options: {
          address: cfg.arcmon,
          symbol: "wstMON",
          decimals: 18
        }
      }
    });
  } catch (err) {
    console.error("addWstmonToMetaMask error:", err);
  }
}

function extractReadableError(err) {
  const deep =
    err?.error?.data?.message ||
    err?.data?.message ||
    err?.error?.message ||
    err?.reason ||
    err?.message;
  let m = deep ? String(deep) : "Transaction failed (execution reverted).";
  if (m.includes("Internal JSON-RPC error")) {
    const i = err?.data?.message || err?.error?.data?.message;
    if (i) m = i;
  }
  m = m.replace(/^execution reverted:?/i, "").trim();
  return m || "Execution reverted.";
}
function escapeHtml(s){ return String(s).replace(/[&<>"']/g, m=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[m])); }

async function init() {
  renderNetworkSelector("network-select", () => location.reload());
  $("connect-btn").style.display = "block";
  $("wallet-address").style.display = "none";
  if (window.ethereum) {
    const accounts = await window.ethereum.request({ method: 'eth_accounts' }).catch(()=>[]);
    if (accounts.length > 0) await connectWallet();
  }
  $("connect-btn").onclick       = connectWallet;
  $("wrap-wstmon-btn").onclick   = wrapWstmon;
  $("unwrap-wstmon-btn").onclick = unwrapWstmon;
  $("wrap-max").onclick   = fillMaxWrap;
  $("unwrap-max").onclick = fillMaxUnwrap;
}
window.addEventListener('DOMContentLoaded', init);

window.closeWrapModal = closeWrapModal;
