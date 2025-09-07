const POOL_ABI = [
  "function totalAssets() view returns (uint256)",
  "function index() view returns (uint256)",
  "function lastAccrualBlock() view returns (uint256)"
];

function onNetworkChanged() {
  updateChainStats();
  updatePoolStats();
}

let statsInterval = 60000;
let statsBackoffPow = 0;
const MAX_BACKOFF_POW = 5;
function nextStatsDelay() {
  const base = statsInterval * Math.pow(2, statsBackoffPow);
  const jitter = base * (0.2 + Math.random() * 0.3);
  return Math.min(base + jitter, 10 * 60 * 1000);
}
function scheduleStatsUpdate(success) {
  statsBackoffPow = success ? 0 : Math.min(MAX_BACKOFF_POW, statsBackoffPow + 1);
  setTimeout(async () => {
    try {
      await updateChainStats();
      await updatePoolStats();
      scheduleStatsUpdate(true);
    } catch (e) {
      console.error("Stats update failed, backing off:", e);
      scheduleStatsUpdate(false);
    }
  }, nextStatsDelay());
}

document.addEventListener("DOMContentLoaded", () => {
  renderNetworkSelector("network-select", onNetworkChanged);
  updateMastheadDateAndClock();
  setInterval(updateMastheadDateAndClock, 1000);

  updateChainStats();
  updatePoolStats();
  scheduleStatsUpdate(true);
});

async function updateChainStats() {
  const cfg = getNetConfig();
  try {
    const blockNumRes = await fetch(cfg.rpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_blockNumber",
        params: []
      })
    }).then(r => r.json());
    const blockNumberHex = blockNumRes.result;
    const blockNumber = parseInt(blockNumberHex, 16);

    const blockRes = await fetch(cfg.rpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "eth_getBlockByNumber",
        params: [blockNumberHex, false]
      })
    }).then(r => r.json());
    const timestampHex = blockRes.result.timestamp;
    const timestamp = parseInt(timestampHex, 16);
    const date = new Date(timestamp * 1000);

    document.getElementById("latest-block").textContent = blockNumber;
    document.getElementById("block-timestamp").textContent = date.toLocaleString();
  } catch (err) {
    document.getElementById("latest-block").textContent = "–";
    document.getElementById("block-timestamp").textContent = "Error";
    throw err;
  }
}

async function updatePoolStats() {
  const cfg = getNetConfig();
  const provider = new ethers.providers.JsonRpcProvider(cfg.rpc);
  const pool = new ethers.Contract(cfg.pool, POOL_ABI, provider);

  const aprKey = `aprSample_${cfg.pool}_${cfg.label}`;
  const aprTimeKey = `aprSampleTime_${cfg.pool}_${cfg.label}`;
  const aprValueKey = `aprValue_${cfg.pool}_${cfg.label}`;
  const minSampleWindow = 3600; 
  const configApr = typeof cfg.apr === "number" ? cfg.apr : 11.1; // fallback for demo

  try {
    const [totalAssets, index, lastAccrualBlock] = await Promise.all([
      pool.totalAssets(),
      pool.index(),
      pool.lastAccrualBlock()
    ]);
    document.getElementById("stat-tvs").textContent =
      ethers.utils.formatUnits(totalAssets, 18).replace(/\.0+$/, "") + " MON";
    const currentIndex = Number(index) / 1e18;
    document.getElementById("stat-index").textContent = currentIndex.toFixed(4);

    const blockRes = await fetch(cfg.rpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 42,
        method: "eth_getBlockByNumber",
        params: ["0x" + Number(lastAccrualBlock).toString(16), false]
      })
    }).then(r => r.json());
    const timestamp = parseInt(blockRes.result.timestamp, 16);
    const date = new Date(timestamp * 1000);
    document.getElementById("stat-rebase").textContent = date.toLocaleString();

    //=== APR Logic ==
    const now = Date.now() / 1000;
    let lastSample = localStorage.getItem(aprKey);
    let lastSampleTime = localStorage.getItem(aprTimeKey);
    let aprDisplay = configApr + "% (target)";
    let aprHint = "APR is set from config target.";

    if (totalAssets.isZero() || index.isZero()) {
      document.getElementById("stat-apr").textContent = aprDisplay;
      document.getElementById("stat-apr").title = aprHint;
    } else if (lastSample && lastSampleTime) {
      lastSample = parseFloat(lastSample);
      lastSampleTime = parseFloat(lastSampleTime);
      if (currentIndex > lastSample && now > lastSampleTime + minSampleWindow) {
        const elapsed = now - lastSampleTime;
        let chainApr = ((currentIndex / lastSample - 1) * (31557600 / elapsed)) * 100;
        // Clamp bad sammples
        if (chainApr < 0 || chainApr > 200) chainApr = null;
        // Use chain APR config => TESTNET SETTING
        if (chainApr !== null && Math.abs(chainApr - configApr) < 2) {
          aprDisplay = (chainApr > 100 ? "100%+" : chainApr.toFixed(2) + "%");
          aprHint = "APR computed from pool activity (on-chain).";
        } else {
          aprDisplay = configApr + "% (target)";
          aprHint = "APR fallback to config target (pool new or chain APR unstable).";
        }
        localStorage.setItem(aprKey, currentIndex);
        localStorage.setItem(aprTimeKey, now);
        localStorage.setItem(aprValueKey, aprDisplay);
        document.getElementById("stat-apr").textContent = aprDisplay;
        document.getElementById("stat-apr").title = aprHint;
      } else {
          // Only show stored value if it is "close enough" to config APR => FOR SOLID TESTNET DEMO
          let lastAprValue = localStorage.getItem(aprValueKey);
          let showStored = false;
          if (lastAprValue) {
            let lastNum = parseFloat(String(lastAprValue).replace(/[^\d.]+/g, ""));
            if (!isNaN(lastNum) && Math.abs(lastNum - configApr) < 2) {
              showStored = true;
            }
          }
          if (showStored) {
            document.getElementById("stat-apr").textContent = lastAprValue + " (recent)";
            document.getElementById("stat-apr").title = "Showing most recent computed APR (close to target).";
          } else {
            document.getElementById("stat-apr").textContent = aprDisplay;
            document.getElementById("stat-apr").title = aprHint;
            
            localStorage.setItem(aprValueKey, aprDisplay);
          }
        }
    } else {
      localStorage.setItem(aprKey, currentIndex);
      localStorage.setItem(aprTimeKey, now);
      document.getElementById("stat-apr").textContent = aprDisplay;
      document.getElementById("stat-apr").title = aprHint;
    }
  } catch (err) {
    document.getElementById("stat-tvs").textContent = "–";
    document.getElementById("stat-index").textContent = "–";
    document.getElementById("stat-apr").textContent = "–";
    document.getElementById("stat-rebase").textContent = "–";
    throw err;
  }
}
