// js/wallet.js
// Robust wallet bootstrap for MEW/MetaMask + Monad Testnet (ethers v5)

const W = {
  $: (id) => document.getElementById(id),
  sleep: (ms) => new Promise(r => setTimeout(r, ms)),
  hex: (n) => "0x" + Number(n).toString(16),
  clamp: (v, lo, hi) => Math.max(lo, Math.min(hi, v)),
  log: (...a) => console.log("[wallet]", ...a),
  err: (...a) => console.error("[wallet]", ...a),
};

// ---------- EIP-6963 discovery (multi-wallet safe) ----------
let __discovered = [];
window.addEventListener('eip6963:announceProvider', (ev) => {
  const p = ev?.detail?.provider;
  if (p && !__discovered.includes(p)) __discovered.push(p);
});
try { window.dispatchEvent(new Event('eip6963:requestProvider')); } catch {}

// Normalize chainId to lowercase hex
function toHexChainId(x) {
  const s = String(x);
  return s.startsWith('0x') ? s.toLowerCase() : ('0x' + Number(s).toString(16)).toLowerCase();
}

// Detect injected wallet (MEW > MetaMask > first)
function pickInjected() {
  const eth = window.ethereum;
  if (!eth && __discovered.length === 0) return null;

  const base = [];
  if (Array.isArray(eth?.providers)) base.push(...eth.providers);
  if (eth && !base.includes(eth)) base.push(eth);
  if (__discovered.length) base.push(...__discovered);

  const providers = [...new Set(base)];
  if (!providers.length) return null;

  const mew = providers.find(p => p.isMEW);
  if (mew) return { provider: mew, name: "MEW" };

  const mm = providers.find(p => p.isMetaMask) || (eth?.isMetaMask ? eth : null);
  if (mm) return { provider: mm, name: "MetaMask" };

  return { provider: providers[0], name: "Injected" };
}

// Load network config supplied by chain.js
async function getResolvedCfg() {
  if (!window.getNetConfig) throw new Error("chain.js not loaded");
  const maybe = window.getNetConfig();
  const cfg = (maybe && typeof maybe.then === "function") ? await maybe : maybe;
  if (!cfg) throw new Error("no chain config");
  // fallbacks
  cfg.chainId  = cfg.chainId  || 10143;
  cfg.label    = cfg.label    || "Monad Testnet";
  cfg.explorer = cfg.explorer || "https://testnet.monadscan.com";
  cfg.rpc      = cfg.rpc      || (Array.isArray(cfg.rpcs) && cfg.rpcs[0]) || "";
  if (!Array.isArray(cfg.rpcs)) cfg.rpcs = cfg.rpc ? [cfg.rpc] : [];
  if (!cfg.coin || !cfg.coin.native) {
    cfg.coin = { native: { name: "Monad", symbol: "MON", decimals: 18 } };
  }
  return cfg;
}

// Wrapper with timeout (prevents hanging eth_requestAccounts)
async function requestWithTimeout(eth, payload, ms = 120000) {
  ms = W.clamp(ms, 8000, 180000);
  let timer;
  try {
    return await Promise.race([
      eth.request(payload),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const e = new Error("wallet request timeout"); e.code = "WALLET_TIMEOUT";
          reject(e);
        }, ms);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// (Optional) serialize/backoff only for connect-time RPCs
function wrapWalletForConnect(eth) {
  if (!eth || eth.__rp_wrapped_connect) return eth;
  const original = eth.request.bind(eth);
  let q = Promise.resolve();
  eth.__rp_wrapped_connect = true;

  eth.request = (args) => {
    const m = args?.method || "";
    const needs = /^(eth_requestAccounts|eth_accounts|eth_chainId|wallet_switchEthereumChain|wallet_addEthereumChain)$/i.test(m);
    if (!needs) return original(args);

    q = q.then(async () => {
      const pre = 400 + Math.random()*300;
      await new Promise(r => setTimeout(r, pre));
      let attempt = 0, max = 5, base = 700, jitter = 300;
      for (;;) {
        try { return await original(args); }
        catch (e) {
          const s = (e?.message||"") + " " + (e?.code||"");
          const rl = /429|rate limit|-32005|-32603/i.test(s);
          if (!rl || attempt >= max-1) throw e;
          attempt++;
          const backoff = base * (2 ** (attempt-1)) + Math.random()*jitter;
          await new Promise(r => setTimeout(r, backoff));
        }
      }
    });
    return q;
  };
  return eth;
}

// Ensure chain (switch or add)
async function ensureChain(eth, cfg) {
  const chainIdHex = W.hex(cfg.chainId).toLowerCase();
  try {
    const current = await eth.request({ method: "eth_chainId" });
    if (toHexChainId(current) === chainIdHex) return true;
  } catch {} // ignore, try switch

  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainIdHex }] });
    return true;
  } catch (e) {
    const msg = String(e?.message || "").toLowerCase();
    const needsAdd =
      e?.code === 4902 ||
      e?.code === -32603 ||
      msg.includes("unrecognized chain") ||
      msg.includes("not added") ||
      msg.includes("missing chain");
    if (needsAdd) {
      W.log("adding chain", cfg.label || "Custom Chain");
      try {
        await eth.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: chainIdHex,
            chainName: cfg.label || "Monad Testnet",
            nativeCurrency: {
              name:    cfg.coin?.native?.name     || "Monad",
              symbol:  cfg.coin?.native?.symbol   || "MON",
              decimals:cfg.coin?.native?.decimals || 18
            },
            rpcUrls: (cfg.rpcs && cfg.rpcs.length ? cfg.rpcs : [cfg.rpc]).filter(Boolean),
            blockExplorerUrls: cfg.explorer ? [cfg.explorer] : []
          }]
        });
        await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainIdHex }] });
        return true;
      } catch {
        throw new Error("User declined chain add / switch");
      }
    }
    if (e && e.code === 4001) throw new Error("User rejected chain switch");
    throw e;
  }
}

// Connect accounts with clear errors
async function requestAccounts(eth) {
  try {
    return await requestWithTimeout(eth, { method: "eth_requestAccounts" }, 120000);
  } catch (e) {
    if (e?.code === -32002) throw new Error("Wallet is busy with another request. Check your wallet popup.");
    if (e?.code === 4001) throw new Error("User rejected the connection request.");
    if (e?.code === "WALLET_TIMEOUT") throw new Error("Wallet did not respond. Check if a popup is blocked.");
    throw e;
  }
}

// -------- Public API (singleton) --------
const Wallet = (() => {
  let eth, providerName, web3, signer, address, cfg;
  let read;                         // Fallback read provider (no wallet)
  let connectBtnEl, addrEl, statusEl;
  let __connecting = false;         // reentrancy guard

  function setStatus(msg, cls="") {
    if (!statusEl) return;
    statusEl.textContent = msg || "";
    statusEl.className = cls ? `muted ${cls}` : "muted";
  }
  const formatAddr = (a) => a ? `${a.slice(0,6)}…${a.slice(-4)}` : "";

  function buildReadProvider(rpcs) {
    const urls = (rpcs && rpcs.length ? rpcs : []).filter(Boolean);
    const providers = urls.map((u) => new ethers.providers.StaticJsonRpcProvider(u));
    if (!providers.length) return null;
    // 1-of-N quorum to avoid fan-out spam yet still have fallback
    return new ethers.providers.FallbackProvider(providers, 1);
  }

  async function initUI({ connectBtnId="connect-btn", addressElId="wallet-address", statusElId="wallet-status", pollingMs=15000 } = {}) {
    connectBtnEl = W.$(connectBtnId) || null;
    addrEl       = W.$(addressElId) || null;
    statusEl     = W.$(statusElId) || null;

    cfg = await getResolvedCfg().catch(e => { W.err(e); return null; });
    if (!cfg) throw new Error("Failed to load network config");

    // Build a dedicated read provider for all reads (prevents wallet RPC throttling)
    read = buildReadProvider(cfg.rpcs);

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
    eth = wrapWalletForConnect(pick.provider); providerName = pick.name;

    if (connectBtnEl) {
      connectBtnEl.style.display = "inline-block";
      connectBtnEl.disabled = false;
      connectBtnEl.textContent = `Connect ${providerName}`;
      connectBtnEl.onclick = connect;
    }
    if (addrEl) addrEl.style.display = "none";

    // silent preload
    try {
      const accts = await eth.request({ method: "eth_accounts" });
      if (Array.isArray(accts) && accts.length) await connect();
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

    eth.on?.("chainChanged", (cid) => {
      const want = toHexChainId(cfg.chainId);
      const got  = toHexChainId(cid);
      setStatus(got !== want ? "Wrong network selected in wallet." : `Network OK (${cfg.label || cfg.chainId})`,
                got !== want ? "err" : "");
    });

    // Prepare signer provider lazily; also reduce wallet polling interval to avoid 429s
    web3 = new ethers.providers.Web3Provider(eth);
    web3.pollingInterval = pollingMs; // default ~4s → 15s
  }

  async function connect() {
    if (!eth) throw new Error("No injected wallet found");
    if (__connecting) return;
    __connecting = true;
    if (connectBtnEl) { connectBtnEl.disabled = true; connectBtnEl.textContent = "Connecting…"; }
    setStatus("Requesting wallet access…");

    try {
      try { await ensureChain(eth, cfg); } catch (e) { W.log("ensureChain pre-connect failed:", e?.message || e); }
      const accts = await requestAccounts(eth);
      if (!Array.isArray(accts) || !accts.length) throw new Error("No accounts returned from wallet");
      address = accts[0];

      await ensureChain(eth, cfg);

      // (re)wire ethers signer
      web3   = web3 || new ethers.providers.Web3Provider(eth);
      signer = web3.getSigner();

      if (addrEl) {
        addrEl.style.display = "block";
        addrEl.innerHTML = `Connected: <a href="${cfg.explorer}/address/${address}" target="_blank" rel="noopener">${formatAddr(address)}</a>`;
      }
      setStatus(`Connected via ${providerName}`);
    } catch (e) {
      const s = String(e?.message || e);
      if (/user rejected/i.test(s)) setStatus("User rejected the request.", "err");
      else if (/already processing/i.test(s)) setStatus("Wallet is already processing a request. Check the popup.", "err");
      else if (/timeout/i.test(s)) setStatus("Wallet did not respond. Is the popup blocked?", "err");
      else if (/chain/i.test(s) && /switch|add/i.test(s)) setStatus("Please approve the network switch in your wallet.", "err");
      else setStatus(s, "err");
      throw e;
    } finally {
      if (connectBtnEl) { connectBtnEl.disabled = false; connectBtnEl.textContent = `Connect ${providerName}`; }
      __connecting = false;
    }
  }

  async function requireReady({ needChain = true } = {}) {
    if (!eth) throw new Error("No wallet detected");
    const accts = await eth.request({ method: "eth_accounts" }).catch(()=>[]);
    if (!Array.isArray(accts) || !accts.length) await connect();
    if (needChain && cfg) await ensureChain(eth, cfg);
    if (!web3) web3 = new ethers.providers.Web3Provider(eth);
    if (!signer) signer = web3.getSigner();
    return { provider: web3, signer, address, cfg, providerName, read };
  }

  // ---- Fees (EIP-1559) from read provider to avoid wallet RPC throttling ----
  async function suggestFees(multiplier = 2, tipGwei = 2) {
    const r = read || web3;
    const block = await r.getBlock('latest').catch(() => null);
    // Fallback base = 1.2 gwei if node can’t give us base fee
    const base = (block && block.baseFeePerGas)
      ? block.baseFeePerGas
      : ethers.utils.parseUnits('1.2', 'gwei');
    // Monad returns ~2 gwei from maxPriorityFeePerGas; enforce a ≥2 gwei floor
    const tip  = ethers.utils.parseUnits(String(Math.max(2, tipGwei)), 'gwei');
    const maxFee = base.mul(multiplier).add(tip);
    return { maxFeePerGas: maxFee, maxPriorityFeePerGas: tip };
  }

  // Allow runtime RPC tweak
  function setRPCs(rpcs = []) {
    cfg.rpcs = rpcs.filter(Boolean);
    read = buildReadProvider(cfg.rpcs);
  }

  function setPollingInterval(ms = 15000) {
    if (web3) web3.pollingInterval = ms;
  }

  return {
    initUI, connect, requireReady,
    suggestFees, setRPCs, setPollingInterval,
    get read(){ return read; },
    get address(){ return address; },
    get signer(){ return signer; },
    get provider(){ return web3; },
    get cfg(){ return cfg; },
    get name(){ return providerName; },
  };
})();

window.Wallet = window.Wallet || Wallet;
