// js/wallet.js
// Hardened wallet connect for MEW/MetaMask + chain checks (ethers v5)

/* Tiny helpers */
const W = {
  $: (id) => document.getElementById(id),
  sleep: (ms) => new Promise(r => setTimeout(r, ms)),
  hex: (n) => "0x" + Number(n).toString(16),
  clamp: (v, lo, hi) => Math.max(lo, Math.min(hi, v)),
  log: (...a) => console.log("[wallet]", ...a),
  err: (...a) => console.error("[wallet]", ...a),
};

/* Detect injected wallet (MEW first, then MetaMask) */
function pickInjected() {
  const eth = window.ethereum;
  if (!eth) return null;

  // Multiple providers pattern
  const providers = eth.providers && Array.isArray(eth.providers) ? eth.providers : [eth];

  // Prefer MEW if present
  let mew = providers.find(p => p.isMEW);
  if (mew) return { provider: mew, name: "MEW" };

  // Otherwise MetaMask
  let mm = providers.find(p => p.isMetaMask) || (eth.isMetaMask ? eth : null);
  if (mm) return { provider: mm, name: "MetaMask" };

  // Fallback to first provider
  return { provider: providers[0], name: "Injected" };
}

/* Resolve chain config from chain.js */
async function getResolvedCfg() {
  if (!window.getNetConfig) throw new Error("chain.js not loaded");
  const maybe = window.getNetConfig();
  const cfg = (maybe && typeof maybe.then === "function") ? await maybe : maybe;
  if (!cfg) throw new Error("no chain config");
  // fallback values just in case
  cfg.chainId = cfg.chainId || 10143;
  cfg.explorer = cfg.explorer || "https://testnet.monadscan.com";
  cfg.rpc = cfg.rpc || (Array.isArray(cfg.rpcs) && cfg.rpcs[0]) || "";
  if (!cfg.coin || !cfg.coin.native) {
    cfg.coin = { native: { name: "Monad", symbol: "MON", decimals: 18 } };
  }
  return cfg;
}

/* Request wrapper with timeout */
async function requestWithTimeout(eth, payload, ms = 120000) {
  const t = setTimeout(() => {
    // simulate "already pending" style error if it hangs forever
    const e = new Error("wallet request timeout");
    e.code = "WALLET_TIMEOUT";
    throw e;
  }, W.clamp(ms, 8000, 180000));
  try {
    return await eth.request(payload);
  } finally {
    clearTimeout(t);
  }
}

/* Ensure correct chain (switch or add) */
async function ensureChain(eth, cfg) {
  const chainIdHex = W.hex(cfg.chainId);
  try {
    const current = await eth.request({ method: "eth_chainId" });
    if (String(current).toLowerCase() === chainIdHex.toLowerCase()) return true;
  } catch {} // ignore and attempt switch

  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainIdHex }] });
    return true;
  } catch (e) {
    // 4902 = chain not added
    if (e && (e.code === 4902 || String(e.message||"").toLowerCase().includes("unrecognized chain"))) {
      W.log("adding chain", cfg.label || "Custom Chain");
      try {
        await eth.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: chainIdHex,
            chainName: cfg.label || "Monad Testnet",
            nativeCurrency: {
              name: cfg.coin?.native?.name || "Monad",
              symbol: cfg.coin?.native?.symbol || "MON",
              decimals: cfg.coin?.native?.decimals || 18
            },
            rpcUrls: (cfg.rpcs && cfg.rpcs.length ? cfg.rpcs : [cfg.rpc]).filter(Boolean),
            blockExplorerUrls: cfg.explorer ? [cfg.explorer] : []
          }]
        });
        // After add, switch again just to be safe on some wallets
        await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainIdHex }] });
        return true;
      } catch (e2) {
        throw new Error("User declined chain add / switch");
      }
    }
    if (e && e.code === 4001) throw new Error("User rejected chain switch");
    throw e;
  }
}

/* Connect accounts robustly */
async function requestAccounts(eth) {
  try {
    return await requestWithTimeout(eth, { method: "eth_requestAccounts" }, 120000);
  } catch (e) {
    // -32002: already processing a request; surface helpful msg
    if (e && e.code === -32002) {
      throw new Error("Wallet is busy with another request. Check your wallet popup.");
    }
    if (e && e.code === 4001) {
      throw new Error("User rejected the connection request.");
    }
    if (e && e.code === "WALLET_TIMEOUT") {
      throw new Error("Wallet did not respond. Check if a popup is blocked.");
    }
    throw e;
  }
}

/* Public API */
const Wallet = (() => {
  // state
  let eth;           // injected provider (raw)
  let providerName;  // "MEW"/"MetaMask"/"Injected"
  let web3;          // ethers.providers.Web3Provider
  let signer;        // ethers.Signer
  let address;       // string
  let cfg;           // chain config

  // UI elements (optional)
  let connectBtnEl, addrEl, statusEl;

  function setStatus(msg, cls="") {
    if (!statusEl) return;
    statusEl.textContent = msg || "";
    statusEl.className = cls ? `muted ${cls}` : "muted";
  }

  function formatAddr(a) { return a ? `${a.slice(0,6)}…${a.slice(-4)}` : ""; }

  async function initUI({ connectBtnId="connect-btn", addressElId="wallet-address", statusElId="wallet-status" } = {}) {
    connectBtnEl = W.$(connectBtnId) || null;
    addrEl       = W.$(addressElId) || null;
    statusEl     = W.$(statusElId) || null;

    cfg = await getResolvedCfg().catch(e => { W.err(e); return null; });
    if (!cfg) throw new Error("Failed to load network config");

    // pick injected
    const pick = pickInjected();
    if (!pick) {
      if (connectBtnEl) {
        connectBtnEl.style.display = "block";
        connectBtnEl.disabled = true;
        connectBtnEl.textContent = "No Wallet Found";
      }
      setStatus("Install MEW or MetaMask to continue.");
      return;
    }
    eth = pick.provider;
    providerName = pick.name;

    if (connectBtnEl) {
      connectBtnEl.style.display = "inline-block";
      connectBtnEl.disabled = false;
      connectBtnEl.textContent = `Connect ${providerName}`;
      connectBtnEl.onclick = connect;
    }
    if (addrEl) addrEl.style.display = "none";

    // preload accounts (silent)
    try {
      const accts = await eth.request({ method: "eth_accounts" });
      if (Array.isArray(accts) && accts.length) {
        await connect(); // completes setup + chain check
      }
    } catch {}

    // events
    eth.on?.("accountsChanged", (accts) => {
      if (Array.isArray(accts) && accts.length) {
        address = accts[0];
        if (addrEl) {
          addrEl.style.display = "block";
          addrEl.innerHTML = `Connected: <a href="${cfg.explorer}/address/${address}" target="_blank" rel="noopener">${formatAddr(address)}</a>`;
        }
        setStatus(`Connected via ${providerName}`);
      } else {
        address = null;
        if (addrEl) { addrEl.style.display = "none"; addrEl.innerHTML = ""; }
        if (connectBtnEl) { connectBtnEl.disabled = false; connectBtnEl.textContent = `Connect ${providerName}`; }
        setStatus("Wallet disconnected.");
      }
    });
    eth.on?.("chainChanged", async (cid) => {
      // normalize
      const want = W.hex(cfg.chainId).toLowerCase();
      if (String(cid).toLowerCase() !== want) {
        setStatus("Wrong network selected in wallet.", "err");
      } else {
        setStatus(`Network OK (${cfg.label || cfg.chainId})`);
      }
    });
  }

  async function connect() {
    if (!eth) throw new Error("No injected wallet found");
    if (connectBtnEl) { connectBtnEl.disabled = true; connectBtnEl.textContent = "Connecting…"; }
    setStatus("Requesting wallet access…");

    try {
      // Ensure chain first (some wallets require permissions for this; if so, it’ll fall through)
      try {
        await ensureChain(eth, cfg);
      } catch (e) {
        // Some wallets only allow switch after accounts granted; proceed.
        W.log("ensureChain pre-connect failed, will retry post-connect:", e.message || e);
      }

      const accts = await requestAccounts(eth);
      if (!Array.isArray(accts) || !accts.length) throw new Error("No accounts returned from wallet");
      address = accts[0];

      // Re-check / add chain post-connect (covers restrictive wallets)
      await ensureChain(eth, cfg);

      // Wire ethers
      web3   = new ethers.providers.Web3Provider(eth);
      signer = web3.getSigner();

      if (addrEl) {
        addrEl.style.display = "block";
        addrEl.innerHTML = `Connected: <a href="${cfg.explorer}/address/${address}" target="_blank" rel="noopener">${formatAddr(address)}</a>`;
      }
      setStatus(`Connected via ${providerName}`);
    } catch (e) {
      const msg = readableError(e);
      setStatus(msg, "err");
      throw e;
    } finally {
      if (connectBtnEl) { connectBtnEl.disabled = false; connectBtnEl.textContent = `Connect ${providerName}`; }
    }
  }

  function readableError(e) {
    const s = String(e && (e.message || e));
    if (/user rejected/i.test(s)) return "User rejected the request.";
    if (/already processing/i.test(s)) return "Wallet is already processing a request. Check the popup.";
    if (/timeout/i.test(s)) return "Wallet did not respond. Is the popup blocked?";
    if (/chain/i.test(s) && /switch|add/i.test(s)) return "Please approve the network switch in your wallet.";
    return s;
  }

  async function requireReady({ needChain = true } = {}) {
    if (!eth) throw new Error("No wallet detected");
    // ensure we still have an account
    const accts = await eth.request({ method: "eth_accounts" }).catch(()=>[]);
    if (!Array.isArray(accts) || !accts.length) {
      await connect(); // will throw if user rejects
    }
    if (needChain && cfg) {
      await ensureChain(eth, cfg);
    }
    if (!web3) web3 = new ethers.providers.Web3Provider(eth);
    if (!signer) signer = web3.getSigner();
    return { provider: web3, signer, address, cfg, providerName };
  }

  return {
    initUI,
    connect,
    requireReady,
    get address(){ return address; },
    get signer(){ return signer; },
    get provider(){ return web3; },
    get cfg(){ return cfg; },
    get name(){ return providerName; },
  };
})();

// Expose globally
window.Wallet = window.Wallet || Wallet;
