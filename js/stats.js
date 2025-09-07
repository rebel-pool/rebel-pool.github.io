// ===== Rebel Pool — stats.js v1.3 (no WMON in UI) =====
(function (global) {
  if (global.__REBEL_STATS_INIT) return;
  global.__REBEL_STATS_INIT = true;

  const NETWORK = "testnet";
  const RPC_URL = "https://testnet-rpc.monad.xyz"; // swap to your node when ready
  const EXPLORER_ADDR = "https://testnet.monadscan.com/address/";

  // Contracts (keep in sync)
  const POOL_ADDRESS    = "0x25E24c54e65a51aa74087B8EE44398Bb4AB231Dd";
  const AQUAMON_ADDRESS = "0xd4522Ed884254008C04008E3b561dFCF4eFC0306"; // stMON
  const ARCMON_ADDRESS  = "0x19157c7b66Af91083431D616cbD023Cfda3264bd"; // wstMON

  // ABIs
  const ERC20_META = [
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
  ];
  const ERC20_SUPPLY = [
    "function totalSupply() view returns (uint256)",
  ];
  const POOL_RO = [
    "function totalAssets() view returns (uint256)",
    "function totalShares() view returns (uint256)",
    "function index() view returns (uint256)",
    "function paused() view returns (bool)",
  ];

  const $ = (id) => document.getElementById(id);
  const fmt = (n, d=4) => new Intl.NumberFormat(undefined, { maximumFractionDigits: d }).format(Number(n));
  const nowStr = () => new Date().toLocaleString();

  if (!global.ethers) {
    const b = $("rpc-ok"); if (b){ b.textContent = "ETHERS.JS MISSING"; b.classList.remove("loading"); b.classList.add("bad"); }
    return;
  }
  const { ethers } = global;

  // Batch provider to reduce RPC hits
  const provider = new ethers.providers.JsonRpcBatchProvider(RPC_URL);

  // Contracts
  const pool      = new ethers.Contract(POOL_ADDRESS,    POOL_RO,       provider);
  const aquaMeta  = new ethers.Contract(AQUAMON_ADDRESS, ERC20_META,    provider);
  const arcMeta   = new ethers.Contract(ARCMON_ADDRESS,  ERC20_META,    provider);
  const aquaSup   = new ethers.Contract(AQUAMON_ADDRESS, ERC20_SUPPLY,  provider);
  const arcSup    = new ethers.Contract(ARCMON_ADDRESS,  ERC20_SUPPLY,  provider);

  $("network-tag").textContent = NETWORK.toUpperCase();

  // Explorer links
  (function setLinks(){
    $("addr-pool").textContent = POOL_ADDRESS;
    $("addr-aqua").textContent = AQUAMON_ADDRESS;
    $("addr-arc").textContent  = ARCMON_ADDRESS;
    $("link-pool").href = EXPLORER_ADDR + POOL_ADDRESS;
    $("link-aqua").href = EXPLORER_ADDR + AQUAMON_ADDRESS;
    $("link-arc").href  = EXPLORER_ADDR + ARCMON_ADDRESS;
  })();

  // Cache static token meta (only st/wst)
  let meta = { aSym: "stMON", aDec: 18, wSym: "wstMON", wDec: 18 };
  async function loadMetaOnce(){
    try {
      const [aSym, aDec, wSym, wDec] = await Promise.all([
        aquaMeta.symbol(), aquaMeta.decimals(),
        arcMeta.symbol(),  arcMeta.decimals(),
      ]);
      meta = { aSym, aDec, wSym, wDec };
      $("a-symbol").textContent = meta.aSym;
      $("a-dec").textContent    = meta.aDec;
      $("w-symbol").textContent = meta.wSym;
      $("w-dec").textContent    = meta.wDec;

      const b = $("rpc-ok"); if (b){ b.textContent = "RPC OK"; b.classList.remove("loading"); b.classList.add("ok"); }
    } catch (e) {
      markErr(e, "META"); throw e;
    }
  }

  const fromUnits = (raw, dec=18) => Number(ethers.utils.formatUnits(raw, dec));

  // Backoff
  let refreshMs = 60000;
  let backoffPow = 0;
  const MAX_BACKOFF_POW = 5;
  const nextDelay = () => {
    const base = refreshMs * Math.pow(2, backoffPow);
    const jitter = base * (0.2 + Math.random()*0.3);
    return Math.min(base + jitter, 10*60*1000);
  };
  function scheduleNext(ok){ backoffPow = ok ? 0 : Math.min(MAX_BACKOFF_POW, backoffPow+1); setTimeout(refresh, nextDelay()); }
  function markErr(err, where){
    console.error(`[${where}]`, err);
    const b=$("rpc-ok"); if (b){ b.textContent = (String(err).includes("429") ? "RATE-LIMIT: backing off" : "DATA ERROR"); b.classList.remove("ok"); b.classList.add("bad"); }
  }

  async function refresh(){
    $("last-updated").textContent = nowStr();
    try {
      const [
        totalAssetsRaw, totalSharesRaw, indexRaw, paused,
        aSupplyRaw, wSupplyRaw,
      ] = await Promise.all([
        pool.totalAssets(),
        pool.totalShares(),
        pool.index(),
        pool.paused().catch(()=>false),
        aquaSup.totalSupply(),
        arcSup.totalSupply(),
      ]);

      // Assume 18 decimals for assets since underlying is native MON (we’re not showing WMON)
      const index = Number(ethers.utils.formatUnits(indexRaw, 18));
      const totalAssetsMON = fromUnits(totalAssetsRaw, 18);
      const totalShares    = fromUnits(totalSharesRaw, 18);

      $("tvl").textContent          = fmt(totalAssetsMON, 6) + " MON";
      $("total-shares").textContent = fmt(totalShares, 6);
      $("index").textContent        = fmt(index, 18);
      $("health").textContent = paused ? "Paused" : "Active";
      $("health").className = "pill " + (paused ? "bad" : "ok");

      $("a-supply").textContent = fmt(fromUnits(aSupplyRaw, meta.aDec), 6);
      $("a-rate").textContent   = fmt(index, 6) + " MON";

      $("w-supply").textContent = fmt(fromUnits(wSupplyRaw, meta.wDec), 6);
      $("w-rate").textContent   = fmt(index, 6) + " MON";

      const b = $("rpc-ok"); if (b){ b.textContent = "RPC OK"; b.classList.remove("bad"); b.classList.add("ok"); }
      scheduleNext(true);
    } catch (e) {
      markErr(e, "REFRESH");
      scheduleNext(false);
    }
  }

  (async function boot(){
    try { await loadMetaOnce(); } catch {}
    refresh();
  })();
})(window);
