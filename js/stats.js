// js/stats.js
(function (global) {
  if (global.__REBEL_STATS_INIT) return;
  global.__REBEL_STATS_INIT = true;

  const log = (...a) => console.log("[stats]", ...a);
  const err = (...a) => console.error("[stats]", ...a);

  const $ = (id) => document.getElementById(id);
  const fmt = (n, d = 4) => new Intl.NumberFormat(undefined, { maximumFractionDigits: d }).format(Number(n));
  const nowStr = () => new Date().toLocaleString();
  const { ethers } = global;

  const ERC20_META = ["function symbol() view returns (string)","function decimals() view returns (uint8)"];
  const ERC20_SUPPLY = ["function totalSupply() view returns (uint256)"];
  const POOL_RO = [
    "function totalAssets() view returns (uint256)",
    "function totalShares() view returns (uint256)",
    "function index() view returns (uint256)",
    "function paused() view returns (bool)"
  ];

  let cfg = null;
  let provider = null;
  let pool, aquaMeta, arcMeta, aquaSup, arcSup;
  let meta = { aSym: "stMON", aDec: 18, wSym: "wstMON", wDec: 18 };
  let refreshMs = 60000;
  let backoffPow = 0;
  const MAX_BACKOFF_POW = 5;

  const nextDelay = () => {
    const base = refreshMs * Math.pow(2, backoffPow);
    const jitter = base * (0.2 + Math.random() * 0.3);
    return Math.min(base + jitter, 10 * 60 * 1000);
  };
  function scheduleNext(ok){ backoffPow = ok ? 0 : Math.min(MAX_BACKOFF_POW, backoffPow + 1); setTimeout(refresh, nextDelay()); }
  function pill(text, cls){
    const b = $("rpc-ok");
    if (!b) return;
    b.textContent = text;
    b.classList.remove("loading","ok","bad");
    if (cls) b.classList.add(cls);
  }
  function markErr(e){
    pill((String(e).match(/429|rate/i) ? "RATE-LIMIT" : "DATA ERROR"), "bad");
    err(e);
  }
  function fromUnits(raw, dec = 18) { return Number(ethers.utils.formatUnits(raw, dec)); }

  async function resolveRpcFromConfig(base) {
    if (!base) throw new Error("Missing network config");
    if (base.rpc && typeof base.rpc === "string" && /^https?:\/\//.test(base.rpc)) return base.rpc;
    if (Array.isArray(base.rpcs) && base.rpcs.length) {
      if (global.pickWorkingRpc) {
        try {
          const picked = await global.pickWorkingRpc(base);
          log("pickWorkingRpc chose:", picked);
          return picked;
        } catch(e) {
          err("pickWorkingRpc failed, falling back to first rpcs[]:", e);
        }
      }
      return base.rpcs[0];
    }
    return "https://testnet-rpc.monad.xyz";
  }

  // NEW: await getNetConfig() if it returns a Promise
  async function getConfigAwaited() {
    if (!global.getNetConfig) return null;
    const maybe = global.getNetConfig();
    return (maybe && typeof maybe.then === "function") ? await maybe : maybe;
  }

  async function ensureWiring() {
    const base = await getConfigAwaited();
    log("base config from chain.js:", base);
    const rpc  = await resolveRpcFromConfig(base);
    log("resolved RPC:", rpc);
    const newCfg = Object.assign({}, base || {}, { rpc });

    if (!newCfg.pool || !newCfg.aquamon || !newCfg.arcmon) {
      err("incomplete addresses:", { pool: newCfg.pool, aquamon: newCfg.aquamon, arcmon: newCfg.arcmon });
      throw new Error("Incomplete network addresses");
    }
    if (cfg && cfg.label === newCfg.label && cfg.rpc === newCfg.rpc) return;

    cfg = newCfg;

    if ($("network-tag")) $("network-tag").textContent = (cfg.label || "").toUpperCase();
    const exAddr = cfg.explorer ? (cfg.explorer.replace(/\/+$/,'') + "/address/") : "#";
    if ($("addr-pool")) $("addr-pool").textContent = cfg.pool;
    if ($("addr-aqua")) $("addr-aqua").textContent = cfg.aquamon;
    if ($("addr-arc"))  $("addr-arc").textContent  = cfg.arcmon;
    if ($("link-pool")) $("link-pool").href = exAddr === "#" ? "#" : exAddr + cfg.pool;
    if ($("link-aqua")) $("link-aqua").href = exAddr === "#" ? "#" : exAddr + cfg.aquamon;
    if ($("link-arc"))  $("link-arc").href  = exAddr === "#" ? "#" : exAddr + cfg.arcmon;

    try {
      provider = new ethers.providers.JsonRpcBatchProvider(cfg.rpc);
      log("provider created:", provider.connection && provider.connection.url);
    } catch (e) {
      err("Batch provider failed, retrying with JsonRpcProvider", e);
      provider = new ethers.providers.JsonRpcProvider(cfg.rpc);
    }

    pool     = new ethers.Contract(cfg.pool,     POOL_RO,       provider);
    aquaMeta = new ethers.Contract(cfg.aquamon,  ERC20_META,    provider);
    arcMeta  = new ethers.Contract(cfg.arcmon,   ERC20_META,    provider);
    aquaSup  = new ethers.Contract(cfg.aquamon,  ERC20_SUPPLY,  provider);
    arcSup   = new ethers.Contract(cfg.arcmon,   ERC20_SUPPLY,  provider);

    log("contracts wired:", { pool: cfg.pool, aquamon: cfg.aquamon, arcmon: cfg.arcmon });

    const [aSym, aDec, wSym, wDec] = await Promise.all([
      aquaMeta.symbol(), aquaMeta.decimals(), arcMeta.symbol(), arcMeta.decimals()
    ]);
    meta = { aSym, aDec, wSym, wDec };
    log("token meta:", meta);

    if ($("a-symbol")) $("a-symbol").textContent = meta.aSym;
    if ($("a-dec"))    $("a-dec").textContent    = meta.aDec;
    if ($("w-symbol")) $("w-symbol").textContent = meta.wSym;
    if ($("w-dec"))    $("w-dec").textContent    = meta.wDec;

    pill("RPC OK", "ok");
  }

  async function refresh() {
    if ($("last-updated")) $("last-updated").textContent = nowStr();
    try {
      await ensureWiring();

      let totalAssetsRaw, totalSharesRaw, indexRaw, paused, aSupplyRaw, wSupplyRaw;

      try { totalAssetsRaw = await pool.totalAssets(); log("totalAssets()", String(totalAssetsRaw)); }
      catch(e){ err("totalAssets() failed", e); throw e; }

      try { totalSharesRaw = pool.totalShares ? await pool.totalShares() : ethers.constants.Zero; log("totalShares()", String(totalSharesRaw)); }
      catch(e){ err("totalShares() failed", e); throw e; }

      try { indexRaw = await pool.index(); log("index()", String(indexRaw)); }
      catch(e){ err("index() failed", e); throw e; }

      try { paused = await pool.paused().catch(()=>false); log("paused()", paused); }
      catch(e){ err("paused() failed", e); throw e; }

      try { aSupplyRaw = await aquaSup.totalSupply(); log("stMON totalSupply()", String(aSupplyRaw)); }
      catch(e){ err("aqua totalSupply() failed", e); throw e; }

      try { wSupplyRaw = await arcSup.totalSupply(); log("wstMON totalSupply()", String(wSupplyRaw)); }
      catch(e){ err("arc totalSupply() failed", e); throw e; }

      const index = Number(ethers.utils.formatUnits(indexRaw, 18));
      const totalAssetsMON = fromUnits(totalAssetsRaw, 18);
      const totalShares = fromUnits(totalSharesRaw, 18);

      if ($("tvl")) $("tvl").textContent = fmt(totalAssetsMON, 6) + " MON";
      if ($("total-shares")) $("total-shares").textContent = fmt(totalShares, 6);
      if ($("index")) $("index").textContent = fmt(index, 18);
      if ($("health")) { $("health").textContent = paused ? "Paused" : "Active"; $("health").className = "pill " + (paused ? "bad" : "ok"); }

      if ($("a-supply")) $("a-supply").textContent = fmt(fromUnits(aSupplyRaw, meta.aDec), 6);
      if ($("a-rate")) $("a-rate").textContent = fmt(index, 6) + " MON";
      if ($("w-supply")) $("w-supply").textContent = fmt(fromUnits(wSupplyRaw, meta.wDec), 6);
      if ($("w-rate")) $("w-rate").textContent = fmt(index, 6) + " MON";

      pill("RPC OK", "ok");
      scheduleNext(true);
    } catch (e) {
      markErr(e);
      scheduleNext(false);
    }
  }

  window.addEventListener("rebel:network-changed", () => { log("network changed event"); cfg = null; provider = null; refresh(); });
  (async function boot(){
    pill("LOADING…", "loading");
    log("boot");
    await refresh();
  })();
})(window);
