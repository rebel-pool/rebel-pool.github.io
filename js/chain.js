// js/chain.js

// ------------------------------
// Networks (store multiple RPCs)
// ------------------------------
const NETWORKS = {
  "monad-testnet": {
    label: "Monad Testnet",
    chainId: 10143,
    rpcs: [
      "https://testnet-rpc.monad.xyz",          // official (QuickNode)
      "https://rpc.ankr.com/monad_testnet",     // Ankr
      "https://monad-testnet.rpc.tatum.io",     // Tatum
      "https://monad-testnet.rpc.thirdweb.com"  // thirdweb
    ],
    ws: [
      "wss://testnet-rpc.monad.xyz",      // QuickNode WS
      "wss://rpc-testnet.monadinfra.com"  // Monad Foundation WS
    ],
    explorer: "https://testnet.monadscan.com",
    pool: "0x25E24c54e65a51aa74087B8EE44398Bb4AB231Dd",
    wmon: "0x0f19e23E213F40Cd1dB36AA2486f2DA76586b010",
    aquamon: "0xd4522Ed884254008C04008E3b561dFCF4eFC0306",
    arcmon: "0x19157c7b66Af91083431D616cbD023Cfda3264bd",
    router: "0x6f6ca25862E5424a00A17775fb97fa71236CCD52",
    ruleDelegation: "0x83a050A961127C1D8968E8DF40DE8310EC786C8A", 
    coin: {
      native:  { name: "Monad",          symbol: "MON" },
      wrapped: { name: "Wrapped Monad",  symbol: "WMON" },
      aqua:    { name: "AquaMON",        symbol: "stMON" },
      arc:     { name: "ArcMON",         symbol: "wstMON" }
    },
    apr: 11.1,
    disabled: false
  },

  "monad-mainnet": {
    label: "Monad Mainnet (soon)",
    chainId: 0,
    rpcs: [],
    ws: [],
    explorer: "",
    pool: "",
    wmon: "",
    aquamon: "",
    arcmon: "",
    coin: {
      native:  { name: "Monad",          symbol: "MON" },
      wrapped: { name: "Wrapped Monad",  symbol: "WMON" },
      aqua:    { name: "AquaMON",        symbol: "stMON" },
      arc:     { name: "ArcMON",         symbol: "wstMON" }
    },
    apr: 8.3,
    disabled: true
  },

  "sepolia": {
    label: "Optimism Sepolia (demo)",
    chainId: 1,
    rpcs: [],
    ws: [],
    explorer: "",
    pool: "",
    wmon: "",
    aquamon: "",
    arcmon: "",
    coin: {
      native:  { name: "Sepolia ETH",    symbol: "ETH" },
      wrapped: { name: "Wrapped ETH",    symbol: "WETH" },
      aqua:    { name: "AquaETH",        symbol: "stETH" },
      arc:     { name: "ArcETH",         symbol: "wstETH" }
    },
    apr: 4.2,
    disabled: true
  }
};

// --- Fast helpers (no RPC ping) ---
function getSelectedNetworkKey() {
  let key = localStorage.getItem("rebel_network");
  if (!key || NETWORKS[key]?.disabled) {
    key = Object.entries(NETWORKS).find(([k, v]) => !v.disabled)?.[0];
  }
  return key;
}

function getStaticNetConfig() {
  const key = getSelectedNetworkKey();
  return NETWORKS[key]; // direct reference (treat as read-only)
}

// Optional: WS candidates (prefer explicit ws[], fallback to wss:// from https://)
function getWsCandidates(cfgLike) {
  const cfg = cfgLike || getStaticNetConfig();
  if (Array.isArray(cfg?.ws) && cfg.ws.length) return cfg.ws;
  return (cfg?.rpcs || [])
    .map(u => (u.startsWith("https://") ? u.replace(/^https:/, "wss:") : null))
    .filter(Boolean);
}

// ------------------------------------
// Network selector (unchanged behavior)
// ------------------------------------
function renderNetworkSelector(selectId = "network-select", onChange) {
  const select = document.getElementById(selectId);
  if (!select) return;
  select.innerHTML = "";
  Object.entries(NETWORKS).forEach(([key, net]) => {
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = net.label;
    if (net.disabled) opt.disabled = true;
    select.appendChild(opt);
  });
  let saved = localStorage.getItem("rebel_network");
  if (!saved || NETWORKS[saved]?.disabled) {
    saved = Object.entries(NETWORKS).find(([k, v]) => !v.disabled)?.[0];
  }
  select.value = saved;
  select.onchange = (e) => {
    if (NETWORKS[e.target.value].disabled) {
      select.value = saved;
      return;
    }
    localStorage.setItem("rebel_network", e.target.value);
    if (onChange) onChange(e.target.value);
  };
}

// -----------------------------------------------------
// Base config getter (returns object with rpcs[] intact)
// -----------------------------------------------------
async function getNetConfig() {
  let key = localStorage.getItem("rebel_network");
  if (!key || NETWORKS[key]?.disabled) {
    key = Object.entries(NETWORKS).find(([k, v]) => !v.disabled)?.[0];
  }
  const base = NETWORKS[key];
  const cfg  = JSON.parse(JSON.stringify(base)); // clone so we don’t mutate

  try {
    cfg.rpc = await pickWorkingRpc(base);
  } catch (e) {
    console.warn("No working RPC found for", base.label);
    cfg.rpc = "";
  }

  return cfg;
}

// -----------------------------------------------------------------
// Resolved config getter (ASYNC): picks ONE working rpc & returns it
// -> UI pages can simply: const cfg = await getResolvedNetConfig();
// -> Then use cfg.rpc everywhere (reads/writes), no dropdown needed.
// -----------------------------------------------------------------
async function getResolvedNetConfig() {
  const base = await getNetConfig();               // ← await was missing
  const cfg  = JSON.parse(JSON.stringify(base));   // deep clone
  try {
    cfg.rpc = await pickWorkingRpc(base);
  } catch (e) {
    console.warn("No working RPC found for", base.label, e);
    cfg.rpc = ""; // empty if none worked
  }
  return cfg;
}

// -----------------
// RPC test & select
// -----------------
async function pickWorkingRpc(cfg) {
  const rpcs = (cfg.rpcs && cfg.rpcs.length ? cfg.rpcs : []).filter(Boolean);
  if (rpcs.length === 0) throw new Error("No RPC candidates configured");

  const cacheKey = `rebel_rpc_${cfg.label}`;
  const cached   = localStorage.getItem(cacheKey);

  // Try cached first
  if (cached && rpcs.includes(cached)) {
    try {
      await testRpc(cached);
      return cached;
    } catch (_) {
      console.warn("Cached RPC failed, trying others…");
    }
  }

  // Probe candidates in order
  for (const url of rpcs) {
    try {
      await testRpc(url);
      localStorage.setItem(cacheKey, url);
      return url;
    } catch (e) {
      console.warn("RPC failed:", url, e?.message || e);
      continue;
    }
  }

  throw new Error("All RPC candidates failed");
}

async function testRpc(url) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] })
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (!json || !json.result) throw new Error("Invalid JSON-RPC response");
}

// ---------------------------------------------
// Optional: JSON-RPC with automatic RPC fallback
// (Use only if you need raw fetch calls on pages.)
// ---------------------------------------------
async function fetchWithFallback(body, cfgLike) {
  const cfg = cfgLike || getNetConfig();
  const rpcs = (cfg.rpcs && cfg.rpcs.length ? cfg.rpcs : []).filter(Boolean);
  let lastErr;
  for (let i = 0; i < rpcs.length; i++) {
    try {
      const res = await fetch(rpcs[i], {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const json = await res.json();
      if (json && !json.error) return json;
      lastErr = new Error(JSON.stringify(json.error || {}));
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("All RPCs failed");
}

// ---------------------------------------------
// (Optional) helper: explorer URL base by type
// ---------------------------------------------
function getExplorerBase(type) {
  const cfg = getStaticNetConfig(); // use sync version
  if (!cfg?.explorer) return "#";
  if (type === "tx")   return `${cfg.explorer}/tx/`;
  if (type === "addr") return `${cfg.explorer}/address/`;
  if (type === "tok")  return `${cfg.explorer}/token/`;
  return "#";
}

// Export to global (if not using modules)
window.renderNetworkSelector    = window.renderNetworkSelector    || renderNetworkSelector;
window.getNetConfig             = window.getNetConfig             || getNetConfig;
window.getResolvedNetConfig     = window.getResolvedNetConfig     || getResolvedNetConfig;
window.fetchWithFallback        = window.fetchWithFallback        || fetchWithFallback;
window.getExplorerBase          = window.getExplorerBase          || getExplorerBase;
window.pickWorkingRpc           = window.pickWorkingRpc           || pickWorkingRpc;

window.getStaticNetConfig      = window.getStaticNetConfig      || getStaticNetConfig;
window.getSelectedNetworkKey   = window.getSelectedNetworkKey   || getSelectedNetworkKey;
window.getWsCandidates         = window.getWsCandidates         || getWsCandidates;
