/* js/agent.js — Production-ready Automation Agent wiring
   - Uses global helpers: RPCUtils, getNetConfig/getResolvedNetConfig, connectWallet(), RULEDELEGATION_ABI
   - Safe: does not redeclare global provider/signer; uses window.provider/window.signer if present.
   - Wires Automations modal, info modals, sync/save rules to on-chain RuleDelegation contract.
*/

(function () {
  "use strict";

  // ---------- Local module state (not global) ----------
  const Agent = {};
  let cfg = null;
  let roProvider = null; // read-only (RPCUtils or ethers provider)
  let delegRO = null;    // read-only contract instance
  let deleg = null;      // write-side contract (signer)
  let userAddr = null;
  const RULE_CONTRACT_ADDR_PATH = "ruleDelegation"; // key in chain config

  // Map rule types to toggle IDs in the UI
  const RULE_TYPE_MAP = {
    1: { toggle: "ac-toggle", status: "ac-status" },      // Auto-Compound
    2: { toggle: "dca-toggle", status: "dca-status" },    // Scheduled DCA (we mapped to 2 previously)
    3: { toggle: "vs-toggle", status: "vs-status" },      // Validator Switch
    4: { toggle: "sl-toggle", status: "sl-status" },      // Partial Stop-Loss
    5: { toggle: "hc-toggle", status: "hc-status" },      // Harvest & Convert
    6: { toggle: "yr-toggle", status: "yr-status" },      // Yield Rebalance
    7: { toggle: "sg-toggle", status: "sg-status" },      // Suggestions
  };

  // Default parameters when creating a rule for a toggle that wasn't on-chain
  const RULE_DEFAULTS = {
    1: { threshold: 0, target: ethers.constants.AddressZero, rewardBps: 5 },   // Auto-compound
    2: { threshold: ethers.constants.Zero, target: ethers.constants.AddressZero, rewardBps: 5 }, // DCA - needs UI later
    3: { threshold: ethers.constants.Zero, target: ethers.constants.AddressZero, rewardBps: 10 },
    4: { threshold: 2500, target: ethers.constants.AddressZero, rewardBps: 8 }, // 25% partial default
    5: { threshold: 0, target: ethers.constants.AddressZero, rewardBps: 20 },
    6: { threshold: 50, target: ethers.constants.AddressZero, rewardBps: 8 },
    7: { threshold: 0, target: ethers.constants.AddressZero, rewardBps: 0 },
  };

  // ---------- small helpers ----------
  const $ = (id) => document.getElementById(id);
  const has = (id) => !!$(id);
  const log = (...a) => console.debug("[Agent]", ...a);
  const error = (...a) => console.error("[Agent]", ...a);
  const friendly = (err) => (window.RPCUtils && typeof window.RPCUtils.friendlyError === "function") ?
    window.RPCUtils.friendlyError(err) : (err?.message || String(err || "Unknown error"));

  // Graceful get signer/provider helpers (prefer global ones from stake.js)
  function getGlobalSigner() {
    if (window.signer) return window.signer;
    if (window.provider && window.provider.getSigner) return window.provider.getSigner();
    return null;
  }
  function getGlobalProvider() {
    if (window.provider) return window.provider;
    return null;
  }

  // Build read-only provider. Prefer RPCUtils.makeReadProvider if present (it returns { send })
  async function initReadProvider(localCfg) {
    try {
      if (!localCfg) return null;
      // Prefer RPCUtils.makeReadProvider (round-robin)
      if (window.RPCUtils && typeof window.RPCUtils.makeReadProvider === "function") {
        const rp = window.RPCUtils.makeReadProvider(localCfg);
        if (rp) {
          roProvider = rp;
          if (window.RPCUtils && typeof window.RPCUtils.setReadProvider === "function") {
            try { window.RPCUtils.setReadProvider(roProvider); } catch {}
          }
          log("RO provider: RPCUtils round-robin");
          return roProvider;
        }
      }
      // Fallback to ethers JsonRpcProvider using first working RPC
      const rpc = localCfg.rpc || (Array.isArray(localCfg.rpcs) ? localCfg.rpcs[0] : null) || localCfg.rpc;
      if (!rpc) {
        log("No RPC url available for read provider");
        return null;
      }
      // prefer ethers if available
      if (window.ethers && window.ethers.providers && window.ethers.providers.JsonRpcProvider) {
        const p = new window.ethers.providers.JsonRpcProvider(rpc, { name: localCfg.label || "net", chainId: localCfg.chainId || 0 });
        roProvider = p;
        if (window.RPCUtils && typeof window.RPCUtils.setReadProvider === "function") {
          try { window.RPCUtils.setReadProvider(roProvider); } catch {}
        }
        log("RO provider: ethers JsonRpcProvider", rpc);
        return roProvider;
      }
      log("Unable to create read provider");
      return null;
    } catch (e) {
      error("initReadProvider failed", e);
      return null;
    }
  }

  // Create read-only contract instance using RO provider (or wrapper object with send())
  function makeDelegROContract(addr, abi) {
    if (!addr || !abi) return null;
    try {
      if (!roProvider) return null;
      // If roProvider has send (RPCUtils), we can't use ethers.Contract directly; wrap a lightweight adapter
      if (typeof roProvider.send === "function" && !(roProvider instanceof window.ethers?.providers?.JsonRpcProvider)) {
        // create an ethers provider that uses custom send via JsonRpcProvider fallback if ethers exists
        if (window.ethers && window.ethers.providers && typeof window.ethers.providers.Web3Provider === "function") {
          // try to use JsonRpcProvider with first RPC as fallback already done earlier
        }
        // Simpler: use ethers.Contract with a JsonRpcProvider if available; else fall back to manual calls
      }
      if (window.ethers && typeof window.ethers.Contract === "function" && roProvider instanceof window.ethers.providers.JsonRpcProvider) {
        return new window.ethers.Contract(addr, abi, roProvider);
      }
      // As fallback, create a tiny read-only wrapper that only supports calls we need (rules(), nextRuleId())
      return {
        address: addr,
        interface: { // basic encode/decode - we only call .rules(i) and .nextRuleId()
        },
        // We'll only call via low-level RPC if this branch is used (but in practice roProvider is ethers provider)
      };
    } catch (e) {
      error("makeDelegROContract failed", e);
      return null;
    }
  }

  // create write contract (signer)
  function makeDelegContractWithSigner(addr, abi, signer) {
    if (!addr || !abi || !signer) return null;
    if (window.ethers && typeof window.ethers.Contract === "function") {
      return new window.ethers.Contract(addr, abi, signer);
    }
    return null;
  }

  // find toggle id for ruleType (reverse lookup)
  function toggleIdForRuleType(ruleType) {
    return RULE_TYPE_MAP[ruleType] ? RULE_TYPE_MAP[ruleType].toggle : null;
  }
  function statusIdForRuleType(ruleType) {
    return RULE_TYPE_MAP[ruleType] ? RULE_TYPE_MAP[ruleType].status : null;
  }

  // set toggle checked and status text
 function setToggleState(ruleType, on, ruleId = null) {
  const t = toggleIdForRuleType(ruleType);
  const s = statusIdForRuleType(ruleType);

  if (t) {
    const el = $(t);
    if (el) el.checked = !!on;
  }

  if (s) {
    const el = $(s);
    if (el) {
      if (on && ruleId !== null) el.textContent = `On • Rule #${ruleId}`;
      else if (on) el.textContent = `On`;
      else el.textContent = "Off";
    }
  }
}

function showToast(msg, type = "info") {
  let div = document.createElement("div");
  div.className = `toast ${type}`;
  div.textContent = msg;
  Object.assign(div.style, {
    position: "fixed", bottom: "20px", right: "20px",
    background: type === "error" ? "#b33" : (type === "success" ? "#2d2" : "#333"),
    color: "#fff", padding: "10px 14px", borderRadius: "6px",
    fontSize: "14px", zIndex: 9999, opacity: "0.95", transition: "opacity 0.5s"
  });
  document.body.appendChild(div);
  setTimeout(() => { div.style.opacity = "0"; }, 3000);
  setTimeout(() => { div.remove(); }, 3500);
}

  // ---------- Core: sync on-chain rules for current wallet owner ----------
  Agent.syncRules = async function syncRules() {
    try {
      if (!cfg) cfg = (typeof getNetConfig === "function") ? await getNetConfig() : null;
      if (!cfg) { log("syncRules: no cfg"); return; }

      const delegAddr = cfg?.[RULE_CONTRACT_ADDR_PATH];
      if (!delegAddr) { log("syncRules: ruleDelegation not configured for network"); return; }
      if (!window.RULEDELEGATION_ABI || !Array.isArray(window.RULEDELEGATION_ABI)) {
        throw new Error("RULEDELEGATION_ABI not found in page (expected in stake.js)");
      }

      // ensure roProvider and delegRO
      if (!roProvider) await initReadProvider(cfg);
      if (!roProvider) throw new Error("No read RPC available");

      // create RO contract if needed
      if (!delegRO) {
        if (roProvider instanceof window.ethers.providers.JsonRpcProvider) {
          delegRO = new window.ethers.Contract(delegAddr, window.RULEDELEGATION_ABI, roProvider);
        } else {
          // If RPCUtils provider returned, attempt to create ethers provider wrapper
          if (window.ethers && window.ethers.providers && window.ethers.providers.JsonRpcProvider) {
            const rpcUrl = cfg.rpc || (Array.isArray(cfg.rpcs) && cfg.rpcs[0]) || null;
            if (rpcUrl) {
              roProvider = new window.ethers.providers.JsonRpcProvider(rpcUrl, { chainId: cfg.chainId || 0 });
              delegRO = new window.ethers.Contract(delegAddr, window.RULEDELEGATION_ABI, roProvider);
            }
          }
        }
      }
      if (!delegRO) throw new Error("Failed to create RuleDelegation read contract");

      // Determine owner — try wallet first (silent)
      let owner = null;
      try {
        // prefer global window.userAddr (set by stake.js), else probe injected eth_accounts
        if (window.userAddr) owner = window.userAddr.toLowerCase();
        else if (window.ethereum && typeof window.ethereum.request === "function") {
          const accts = await window.ethereum.request({ method: "eth_accounts" }).catch(() => []);
          if (Array.isArray(accts) && accts.length) owner = String(accts[0]).toLowerCase();
        }
      } catch (e) { /* ignore */ }

      if (!owner) {
        // Not connected — clear UI toggles
        log("syncRules: no wallet connected; clearing toggles");
        Object.keys(RULE_TYPE_MAP).forEach(rt => setToggleState(Number(rt), false));
        return;
      }
      userAddr = owner;
      log("syncRules: owner:", owner);

      // fetch nextRuleId and scan rules (small mappings; expected count small)
      const next = Number((await delegRO.nextRuleId()).toString());
      log("syncRules: nextRuleId", next);
      // init map
      const found = {}; // ruleType -> { ruleId, active }
      for (let i = 0; i < next; i++) {
        try {
          const r = await delegRO.rules(i);
          if (!r || !r.owner) continue;
          if ((r.owner || "").toLowerCase() !== owner) continue;
          const ruleType = Number(r.ruleType);
          const active = Boolean(r.active);
          if (!found[ruleType]) found[ruleType] = { ruleId: i, active };
          // prefer latest (higher id) if multiple — keep highest id
          else if (i > found[ruleType].ruleId) found[ruleType] = { ruleId: i, active };
        } catch (e) {
          // ignore individual read errors
        }
      }

      // update toggles
      Object.keys(RULE_TYPE_MAP).forEach(rt => {
        const n = Number(rt);
        if (found[n]) setToggleState(n, found[n].active, found[n].ruleId);
        else setToggleState(n, false, null);
      });

      updateActiveBotsSummary(found);

      log("syncRules: done");
    } catch (e) {
      error("syncRules failed:", e);
      // show nothing intrusive; developer console contains details
    }
  };

function setAutomationStatus(msg, isError = false) {
  const el = document.getElementById("automations-status");
  if (!el) return;
  el.innerHTML = msg;
  el.style.color = isError ? "red" : "#333";
}


// ---------- Create or disable rules according to toggles ----------
// ---------- Create or disable rules according to toggles ----------
Agent.saveRules = async function saveRules() {
  try {
    if (!cfg) cfg = (typeof getNetConfig === "function") ? await getNetConfig() : null;
    if (!cfg) { alert("Network config missing"); return; }

    const delegAddr = cfg?.[RULE_CONTRACT_ADDR_PATH];
    if (!delegAddr) { alert("RuleDelegation not configured for this network"); return; }
    if (!window.RULEDELEGATION_ABI || !Array.isArray(window.RULEDELEGATION_ABI)) {
      alert("Contract ABI missing (RULEDELEGATION_ABI).");
      return;
    }

    // Ensure we have a signer
    let signer = getGlobalSigner();
    if (!signer && typeof window.connectWallet === "function") {
      await window.connectWallet();
      signer = getGlobalSigner();
    }
    if (!signer) { alert("Connect your wallet to save automations."); return; }

    // Prepare deleg contract
    deleg = makeDelegContractWithSigner(delegAddr, window.RULEDELEGATION_ABI, signer);
    if (!deleg) throw new Error("Failed to instantiate RuleDelegation contract with signer");

    if (!roProvider) await initReadProvider(cfg);
    if (!delegRO) {
      if (roProvider instanceof window.ethers.providers.JsonRpcProvider) {
        delegRO = new window.ethers.Contract(delegAddr, window.RULEDELEGATION_ABI, roProvider);
      } else {
        delegRO = new window.ethers.Contract(delegAddr, window.RULEDELEGATION_ABI, signer);
      }
    }

    // Read existing rules for owner
    const existing = {};
    try {
      const next = Number((await delegRO.nextRuleId()).toString());
      let owner = window.userAddr ? window.userAddr.toLowerCase() : null;
      if (!owner) {
        const accts = await signer.provider.send("eth_accounts", []).catch(() => []);
        if (accts?.[0]) owner = String(accts[0]).toLowerCase();
      }
      for (let i = 0; i < next; i++) {
        const r = await delegRO.rules(i).catch(() => null);
        if (!r || !r.owner) continue;
        if ((r.owner || "").toLowerCase() !== owner) continue;
        const rt = Number(r.ruleType);
        if (!existing[rt] || i > existing[rt].ruleId) existing[rt] = { ruleId: i, active: Boolean(r.active) };
      }
    } catch {}

    // Build actions
    const actions = [];
    for (const [rtStr, cfgMap] of Object.entries(RULE_TYPE_MAP)) {
      const rt = Number(rtStr);
      const toggleId = cfgMap.toggle;
      if (!toggleId || !has(toggleId)) continue;
      const checked = $(toggleId).checked;
      const ex = existing[rt];

      if (checked) {
        if (!ex || !ex.active) {
          let d = { ...(RULE_DEFAULTS[rt] || { threshold: 0, target: ethers.constants.AddressZero, rewardBps: 5 }) };

          // ---------- Override with user settings ----------
          if (rt === 1) { // Auto-Compound
            const min = parseFloat($("#ac-min")?.value || "0");
            if (min > 0) d.threshold = ethers.utils.parseUnits(min.toString(), 18);
            const tip = parseFloat($("#ac-tip")?.value || "0");
            if (tip >= 0) d.rewardBps = Math.floor(tip * 100); // convert % to bps
          }

          if (rt === 2) { // DCA
            const amt = parseFloat($("#dca-amount")?.value || "0");
            if (amt > 0) d.threshold = ethers.utils.parseUnits(amt.toString(), 18);
            const freq = $("#dca-frequency")?.value;
            if (freq) d.target = ethers.utils.formatBytes32String(freq); // encode as bytes32
            // start date is client-only for now (could be emitted in Suggestion rule later)
          }

          if (rt === 3) { // Validator Switch
            const target = $("#vs-validator")?.value;
            if (target) d.target = target;
            const delta = parseFloat($("#vs-delta")?.value || "0");
            if (delta > 0) d.threshold = Math.floor(delta * 100); // store bps
          }

          if (rt === 4) { // Stop-Loss
            const pct = parseFloat($("#sl-percent")?.value || "25");
            d.threshold = Math.floor(pct * 100); // store bps (e.g. 2500 = 25%)
          }

          if (rt === 5) { // Harvest & Convert
            const token = $("#hc-token")?.value;
            if (token) d.target = token;
            const slip = parseFloat($("#hc-slippage")?.value || "0");
            if (slip > 0) d.threshold = Math.floor(slip * 100); // basis points
          }

          if (rt === 6) { // Yield Rebalance
            const delta = parseFloat($("#yr-delta")?.value || "0");
            if (delta > 0) d.threshold = Math.floor(delta * 100);
          }
          // -----------------------------------------------

          actions.push({ type: "create", ruleType: rt, threshold: d.threshold, target: d.target, rewardBps: d.rewardBps });
        }
      } else {
        if (ex && ex.active) actions.push({ type: "disable", ruleId: ex.ruleId });
      }
    }

    if (!actions.length) { log("No automation changes detected."); return; }

    log(`Submitting ${actions.length} automation change(s) to wallet…`);

    // Fee guess fallback
    let feeGuess;
    try {
      feeGuess = (window.RPCUtils?.getNetworkFeeGuessSafe)
        ? await window.RPCUtils.getNetworkFeeGuessSafe()
        : { eip1559: false, gasPrice: null };
    } catch (e) {
      console.warn("[Agent] getNetworkFeeGuessSafe failed, falling back:", e);
      feeGuess = { eip1559: false, gasPrice: null };
    }



    // Execute sequentially
    for (const act of actions) {
      if (act.type === "create") {
        showTxInfoModal("Activating Bots", `Submitting ${actions.length} automation change(s)…<br>Please confirm in your wallet.`);
        try {
          let gasLimit;
          try {
            gasLimit = await deleg.estimateGas.createRule(act.ruleType, act.threshold, act.target, act.rewardBps);
            gasLimit = gasLimit.mul(130).div(100);
          } catch {
            gasLimit = ethers.BigNumber.from(200000);
          }
          

          const tx = await deleg.createRule(act.ruleType, act.threshold, act.target, act.rewardBps, { gasLimit });
          if (tx?.hash) await waitForTx(tx.hash);
          log("createRule tx", tx.hash);
          updateTxInfoModal(`Waiting for confirmation…<br>Tx: ${tx.hash.slice(0,10)}…`);
        } catch (e) {
          error("createRule failed", e);
          alert(`Failed to create rule type ${act.ruleType}: ${friendly(e)}`);
        }
      } else if (act.type === "disable") {
        try {
          let gasLimit;
          try {
            gasLimit = await deleg.estimateGas.disableRule(act.ruleId);
            gasLimit = gasLimit.mul(130).div(100);
          } catch {
            gasLimit = ethers.BigNumber.from(100000);
          }

          const tx = await deleg.disableRule(act.ruleId, { gasLimit });
          if (tx?.hash) await waitForTx(tx.hash);
          log("disableRule tx", tx.hash);
          updateTxInfoModal(`Waiting for confirmation…<br>Tx: ${tx.hash.slice(0,10)}…`);

        } catch (e) {
          error("disableRule failed", e);
          alert(`Failed to disable rule #${act.ruleId}: ${friendly(e)}`);
        }
      }
    }

    // Refresh and close modal
    await Agent.syncRules();
    const m = document.getElementById("automations-modal");
    if (m) m.style.display = "none";
    log("Automations saved and synced (modal closed).");
  } catch (e) {
    error("saveRules failed", e);
    alert("Failed to save automations: " + friendly(e));
  }
  updateTxInfoModal("✅ Automations saved successfully!");
  setTimeout(() => {
    closeTxInfoModal();
    }, 3000);
};

    async function waitForTx(hash) {
      try {
        if (roProvider?.waitForTransaction) return await roProvider.waitForTransaction(hash, 1);
      } catch {}
      if (window.RPCUtils?.roSend) {
        for (let i = 0; i < 60; i++) {
          try {
            const rec = await window.RPCUtils.roSend("eth_getTransactionReceipt", [hash]);
            if (rec?.blockNumber) return rec;
          } catch {}
          await new Promise(r => setTimeout(r, 2000));
        }
      }
      return null;
    }


function showTxInfoModal(title, body) {
  const modal = document.getElementById("txinfo-modal");
  if (!modal) return;

  const t = document.getElementById("txinfo-modal-title");
  const b = document.getElementById("txinfo-modal-body");

  if (t) t.textContent = title || "Transaction in Progress";
  if (b) b.innerHTML   = body  || "Confirm in your wallet…";

  modal.style.display = "flex";

  // wire backdrop + ESC to close once
  if (!modal.__wired) {
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeTxInfoModal();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeTxInfoModal();
    });
    modal.__wired = true;
  }
}


function updateTxInfoModal(msg) {
  const body = document.getElementById("txinfo-modal-body");
  if (body) body.innerHTML = msg;
}

function closeTxInfoModal() {
  const modal = document.getElementById("txinfo-modal");
  if (modal) modal.style.display = "none";
}


function updateActiveBotsSummary(found) {
  const div = document.getElementById("active-bots-summary");
  if (!div) return;

  const nameMap = {
    1: "Auto-Compound",
    2: "Scheduled DCA",
    3: "Validator Switch",
    4: "Stop-Loss",
    5: "Harvest & Convert",
    6: "Yield Rebalance",
    7: "Suggestions"
  };

  const formatRule = (ruleType, v) => {
    const name = nameMap[ruleType] || `Rule ${ruleType}`;
    const id = v.ruleId !== null ? `#${v.ruleId}` : "";

    // Format settings if present
    let details = "";
    if (v.threshold && v.threshold !== "0") {
      if ([2,5,6].includes(Number(ruleType))) {
        details += ` • Threshold: ${v.threshold}`;
      }
      if (ruleType === "4") {
        details += ` • ${Number(v.threshold) / 100}%`; // stop-loss %
      }
    }
    if (v.target && v.target !== "0x0000000000000000000000000000000000000000") {
      details += ` • Target: ${v.target.slice(0,6)}…${v.target.slice(-4)}`;
    }
    if (v.rewardBps) {
      details += ` • Tip: ${(v.rewardBps/100).toFixed(1)}%`;
    }

    return `<li><b>${name}</b> ${id}${details}</li>`;
  };

  const active = Object.entries(found)
    .filter(([_, v]) => v.active)
    .map(([ruleType, v]) => formatRule(ruleType, v));

  div.innerHTML = active.length
    ? `<div><b>Your Active Bots:</b></div><ul style="margin:4px 0 0 18px; padding:0;">${active.join("")}</ul>`
    : "<div><b>Your Active Bots:</b> None</div>";
}

  // ---------- Recommended presets apply (UI-only) ----------
  Agent.applyRecommended = function applyRecommended(ev) {
    try {
      const on = ev && ev.target ? !!ev.target.checked : true;
      // Simple "recommended" mapping: enable Auto-Compound + Yield Rebalance by default
      const recommended = [1, 6]; // rule types to turn on by default
      // Also set Auto-Compound tip UI, etc — simple UI-only defaults for now
      Object.keys(RULE_TYPE_MAP).forEach(rt => {
        const n = Number(rt);
        const tid = toggleIdForRuleType(n);
        if (!tid || !has(tid)) return;
        if (recommended.includes(n)) $(tid).checked = on;
        else $(tid).checked = false;
      });
      // keep save required: user must click Save to create on-chain rules
      //alert("Recommended toggles applied to the modal. Click Save to persist on-chain.");
    } catch (e) {
      error("applyRecommended failed", e);
    }
  };

  // ---------- UI wiring for modals and info icons ----------
function wireModalsAndInfo() {
  try {
    const openBtn = $("open-automations-btn");
    const modal = $("automations-modal");
    const closeBtn = $("automations-close");
    const saveBtn = $("save-automations-btn");
    const recommendedToggle = $("recommended-toggle");

    if (openBtn && modal) {
      openBtn.onclick = () => {
        modal.style.display = "flex";
        modal.querySelector(".modal-content")?.style?.setProperty("max-height", "80vh");
      };
    }

    if (closeBtn && modal) closeBtn.onclick = () => { modal.style.display = "none"; };
    if (saveBtn) saveBtn.onclick = Agent.saveRules;
    if (recommendedToggle) recommendedToggle.onchange = Agent.applyRecommended;
    if (modal) modal.onclick = (e) => { if (e.target === modal) modal.style.display = "none"; };

    document.querySelectorAll(".info-icon").forEach(icon => {
      icon.onclick = () => {
        const key = icon.dataset?.info;
        if (key) showInfoModal(key);
      };
    });

    document.querySelectorAll(".modal .modal-close").forEach(btn => {
      btn.onclick = () => {
        const m = btn.closest(".modal");
        if (m) m.style.display = "none";
      };
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        document.querySelectorAll(".modal").forEach(m => {
          if (m.style.display === "flex") m.style.display = "none";
        });
      }
    });

    log("UI modal wiring complete");
  } catch (e) {
    error("wireModalsAndInfo failed", e);
  }
}

function enforceConflicts(changedId) {
  const pairs = [
    // hard conflicts
    { a: "ac-toggle", b: "hc-toggle", msg: "You cannot enable Auto-Compound and Harvest & Convert at the same time." },
    // redundancy
    { a: "yr-toggle", b: "vs-toggle", msg: "Yield Rebalance and Validator Switch overlap. One will be disabled." }
  ];

  pairs.forEach(pair => {
    const a = $(pair.a), b = $(pair.b);
    if (!a || !b) return;
    if (changedId === pair.a && a.checked && b.checked) {
      b.checked = false;
      alert(pair.msg);
    } else if (changedId === pair.b && b.checked && a.checked) {
      a.checked = false;
      alert(pair.msg);
    }
  });

  // soft conflicts: just warn if both on
  const sl = $("sl-toggle");
  if (sl?.checked && ($("ac-toggle")?.checked || $("dca-toggle")?.checked)) {
    console.warn("⚠️ Stop-Loss + DCA/Auto-Compound may be conflicting strategies.");
    // optional: show inline warning in UI
    document.getElementById("sl-status")?.insertAdjacentHTML(
      "afterend",
      "<div class='muted' style='color:orange;font-size:0.8em;'>⚠️ Works, but may fight your DCA/Compounding</div>"
    );
  }
}

// Wire in the onchange handlers
["ac-toggle", "hc-toggle", "yr-toggle", "vs-toggle", "sl-toggle", "dca-toggle"]
  .forEach(id => {
    const el = $(id);
    if (el) el.onchange = () => enforceConflicts(id);
  });


// ---------- Init ----------
Agent.init = async function init() {
  try {
    log("Init start");

    // 0) wrap injected providers globally for rate-limit safety (if RPCUtils present)
    if (window.RPCUtils && typeof window.RPCUtils.wrapAllInjected === "function") {
      try {
        window.RPCUtils.wrapAllInjected({
          pre: 400, post: 300, base: 800, maxTries: 6, jitter: 200, debug: false
        });
      } catch (e) {
        log("wrapAllInjected failed", e);
      }
    }

    // 1) load network config (best-effort)
    if (typeof getNetConfig === "function") {
      cfg = await getNetConfig();
      log("Network:", cfg?.label || cfg?.chainId || "unknown");
    } else {
      cfg = null;
      log("No network config available from getNetConfig()");
    }

    // 2) init read provider if possible
    await initReadProvider(cfg);

    // 3) wire modals (automations + info ℹ️)
    wireModalsAndInfo();

    // 4) check for existing wallet / userAddr
    if (window.userAddr) {
      userAddr = window.userAddr;
      log("Found userAddr from global:", userAddr);
      Agent.syncRules().catch(e => log("Initial syncRules failed", e));
    } else if (window.ethereum?.request) {
      try {
        const accts = await window.ethereum.request({ method: "eth_accounts" }).catch(() => []);
        if (Array.isArray(accts) && accts.length) {
          userAddr = accts[0];
          log("Detected authorized account", userAddr);
          Agent.syncRules().catch(e => log("Initial syncRules failed", e));
        }
      } catch (e) {
        log("Silent account check failed", e);
      }
    }

    log("Agent ready");
  } catch (e) {
    error("Init failed", e);
    try {
      alert("Automation agent initialization failed: " + (e?.message || e));
    } catch {}
  }
};


  // expose
    window.Agent = Agent;

    window.addEventListener("DOMContentLoaded", () => {
        if (!window.Agent || !window.Agent._inited) {
        window.Agent.init && window.Agent.init();
        window.Agent._inited = true;
        }
    });

function showInfoModal(key) {
  const modal = document.getElementById("info-modal");
  const title = document.getElementById("info-modal-title");
  const body  = document.getElementById("info-modal-body");
  if (!modal || !title || !body) {
    console.error("[InfoModal] Missing modal/title/body elements!");
    return;
  }

  // Scoped selectors (avoid global ID collisions)
  const qi = (id) => modal.querySelector(`#${id}`);
  const qs = (sel) => modal.querySelector(sel);

  // Debug helpers
  const dlog = (...a) => console.debug("[InfoModal]", ...a);
  const dwarn = (...a) => console.warn("[InfoModal]", ...a);
  const derror = (...a) => console.error("[InfoModal]", ...a);

  dlog("open:", key);

  // UI defaults (what the user should see if nothing saved/entered)
  const UI_DEFAULTS = {
    "info-auto-compound": { min: 1.0, tip: 5.0 },
    "info-dca":           { freq: "monthly", amt: 10.0, date: new Date().toISOString().slice(0,10) },
    "info-validator":     { val: "", delt: 2.0 },
    "info-stoploss":      { pct: 25.0 },
    "info-harvest":       { token: "MON", slip: 0.5 },
    "info-rebalance":     { delt: 1.0 },
    "info-suggest":       {}
  };

  // Helper: pick number with priority (UI input > saved > UI default)
  function pickNum(inputVal, savedVal, uiDefault) {
    const has = (v) => v !== undefined && v !== null && `${v}`.trim() !== "";
    if (has(inputVal)) return parseFloat(inputVal);
    if (has(savedVal))  return parseFloat(savedVal);
    return parseFloat(uiDefault);
  }
  // Helper: pick string (UI input > saved > UI default)
  function pickStr(inputVal, savedVal, uiDefault) {
    const has = (v) => v !== undefined && v !== null && `${v}`.trim() !== "";
    if (has(inputVal)) return String(inputVal);
    if (has(savedVal))  return String(savedVal);
    return String(uiDefault);
  }

  const MAP = {
    "info-auto-compound": {
      title: "Auto-Compound",
      body: `
        Re-stakes your rewards automatically for higher yield.<br>
        <b>Vault Equivalent:</b> 30–90d auto-compound vault.<br>
        <b>Rebel Pool Advantage:</b> Same compounding, liquid, higher 99/1 yield.
        <hr>
        <div class="settings">
          <label><b>Min MON before compounding:</b></label><br>
          <input id="ac-min" type="number" min="0" step="0.01" placeholder="1.0" style="width:100%; margin:4px 0 8px;"/>
          <label><b>Executor Tip (%):</b></label><br>
          <input id="ac-tip" type="number" min="0" max="10" step="0.1" placeholder="5" style="width:100%; margin:4px 0;"/>
        </div>
        <div style="margin-top:12px; text-align:right;">
          <button id="ac-set-btn" class="btn small" type="button">Set</button>
        </div>
        <div id="ac-current" class="muted small" style="margin-top:6px;"></div>
      `,
      prefill() {
        const saved = JSON.parse(localStorage.getItem("ac-settings") || "{}");
        const ui = UI_DEFAULTS["info-auto-compound"];
        const min = pickNum(undefined, saved.min, ui.min);
        const tip = pickNum(undefined, saved.tip, ui.tip);

        if (qi("ac-min")) qi("ac-min").value = min;
        if (qi("ac-tip")) qi("ac-tip").value = tip;
        if (qi("ac-current")) qi("ac-current").textContent = `Min ${min} MON, Tip ${tip}%`;

        dlog("prefill: ac", { saved, ui, min, tip });
      },
      wire() {
        const btn = qi("ac-set-btn");
        if (!btn) { derror("wire: ac-set-btn missing"); return; }
        btn.onclick = () => {
          const saved = JSON.parse(localStorage.getItem("ac-settings") || "{}");
          const ui = UI_DEFAULTS["info-auto-compound"];
          const min = pickNum(qi("ac-min")?.value, saved.min, ui.min);
          const tip = pickNum(qi("ac-tip")?.value, saved.tip, ui.tip);

          localStorage.setItem("ac-settings", JSON.stringify({ min, tip }));
          if (qi("ac-current")) qi("ac-current").textContent = `Min ${min} MON, Tip ${tip}%`;

          showToast("Auto-Compound settings saved", "success");
          dlog("saved: ac", { min, tip });
          modal.style.display = "none";
        };
      }
    },

    "info-dca": {
      title: "Scheduled DCA",
      body: `
        Deposit MON on a fixed schedule.<br>
        <b>Vault Equivalent:</b> Locked recurring vaults.<br>
        <b>Rebel Pool Advantage:</b> DCA with no lockups, pause anytime.
        <hr>
        <div class="settings">
          <label><b>Frequency:</b></label><br>
          <select id="dca-frequency" style="width:100%; margin:4px 0 8px;">
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </select>
          <label><b>Amount (MON):</b></label><br>
          <input id="dca-amount" type="number" min="0" step="0.01" placeholder="10.0" style="width:100%; margin:4px 0 8px;"/>
          <label><b>Start Date:</b></label><br>
          <input id="dca-start" type="date" style="width:100%; margin:4px 0;"/>
        </div>
        <div style="margin-top:12px; text-align:right;">
          <button id="dca-set-btn" class="btn small" type="button">Set</button>
        </div>
        <div id="dca-current" class="muted small" style="margin-top:6px;"></div>
      `,
      prefill() {
        const saved = JSON.parse(localStorage.getItem("dca-settings") || "{}");
        const ui = UI_DEFAULTS["info-dca"];
        const freq = pickStr(undefined, saved.freq, ui.freq);
        const amt  = pickNum(undefined, saved.amt,  ui.amt);
        const date = pickStr(undefined, saved.date, ui.date);

        if (qi("dca-frequency")) qi("dca-frequency").value = freq;
        if (qi("dca-amount"))    qi("dca-amount").value    = amt;
        if (qi("dca-start"))     qi("dca-start").value     = date;
        if (qi("dca-current"))   qi("dca-current").textContent = `Scheduled: ${amt} MON ${freq}, from ${date}`;

        dlog("prefill: dca", { saved, ui, freq, amt, date });
      },
      wire() {
        const btn = qi("dca-set-btn");
        if (!btn) { derror("wire: dca-set-btn missing"); return; }
        btn.onclick = () => {
          const saved = JSON.parse(localStorage.getItem("dca-settings") || "{}");
          const ui = UI_DEFAULTS["info-dca"];
          const freq = pickStr(qi("dca-frequency")?.value, saved.freq, ui.freq);
          const amt  = pickNum(qi("dca-amount")?.value,    saved.amt,  ui.amt);
          const date = pickStr(qi("dca-start")?.value,     saved.date, ui.date);

          localStorage.setItem("dca-settings", JSON.stringify({ freq, amt, date }));
          if (qi("dca-current")) qi("dca-current").textContent = `Scheduled: ${amt} MON ${freq}, from ${date}`;

          showToast("DCA settings saved", "success");
          dlog("saved: dca", { freq, amt, date });
          modal.style.display = "none";
        };
      }
    },

    "info-validator": {
      title: "Validator Switch",
      body: `
        Move your stake to higher-yield validators automatically.<br>
        <b>Vault Equivalent:</b> Validator basket vault.<br>
        <b>Rebel Pool Advantage:</b> Liquid switching, no forced lockups.
        <hr>
        <div class="settings">
          <label><b>Target Validator:</b></label><br>
          <input id="vs-validator" type="text" placeholder="0x…" style="width:100%; margin:4px 0 8px;"/>
          <label><b>Min Yield Difference (%):</b></label><br>
          <input id="vs-delta" type="number" min="0" max="100" step="0.1" placeholder="2.0" style="width:100%; margin:4px 0;"/>
        </div>
        <div style="margin-top:12px; text-align:right;">
          <button id="vs-set-btn" class="btn small" type="button">Set</button>
        </div>
        <div id="vs-current" class="muted small" style="margin-top:6px;"></div>
      `,
      prefill() {
        const saved = JSON.parse(localStorage.getItem("vs-settings") || "{}");
        const ui = UI_DEFAULTS["info-validator"];
        const val  = pickStr(undefined, saved.val,  ui.val);
        const delt = pickNum(undefined, saved.delt, ui.delt);

        if (qi("vs-validator")) qi("vs-validator").value = val;
        if (qi("vs-delta"))     qi("vs-delta").value     = delt;
        if (qi("vs-current"))   qi("vs-current").textContent = `Target: ${val || "auto"}, Δ ${delt}%`;

        dlog("prefill: validator", { saved, ui, val, delt });
      },
      wire() {
        const btn = qi("vs-set-btn");
        if (!btn) { derror("wire: vs-set-btn missing"); return; }
        btn.onclick = () => {
          const saved = JSON.parse(localStorage.getItem("vs-settings") || "{}");
          const ui = UI_DEFAULTS["info-validator"];
          const val  = pickStr(qi("vs-validator")?.value, saved.val,  ui.val);
          const delt = pickNum(qi("vs-delta")?.value,     saved.delt, ui.delt);

          localStorage.setItem("vs-settings", JSON.stringify({ val, delt }));
          if (qi("vs-current")) qi("vs-current").textContent = `Target: ${val || "auto"}, Δ ${delt}%`;

          showToast("Validator settings saved", "success");
          dlog("saved: validator", { val, delt });
          modal.style.display = "none";
        };
      }
    },

    "info-stoploss": {
      title: "Partial Stop-Loss",
      body: `
        Redeem a portion of stake if losses cross threshold.<br>
        <b>Vault Equivalent:</b> Risk-managed vaults.<br>
        <b>Rebel Pool Advantage:</b> Flexible, non-destructive risk control.
        <hr>
        <div class="settings">
          <label><b>Redeem % of stake:</b></label><br>
          <input id="sl-percent" type="range" min="5" max="100" step="5" value="25" style="width:100%;"/>
          <div id="sl-percent-label" class="muted" style="text-align:right;">25%</div>
        </div>
        <div style="margin-top:12px; text-align:right;">
          <button id="sl-set-btn" class="btn small" type="button">Set</button>
        </div>
        <div id="sl-current" class="muted small" style="margin-top:6px;"></div>
      `,
      prefill() {
        const saved = JSON.parse(localStorage.getItem("sl-settings") || "{}");
        const ui = UI_DEFAULTS["info-stoploss"];
        const pct = pickNum(undefined, saved.pct, ui.pct);

        if (qi("sl-percent")) {
          qi("sl-percent").value = pct;
          const label = qi("sl-percent-label");
          if (label) label.textContent = pct + "%";
        }
        if (qi("sl-current")) qi("sl-current").textContent = `Stop-loss at ${pct}%`;

        dlog("prefill: stoploss", { saved, ui, pct });
      },
      wire() {
        if (qi("sl-percent") && qi("sl-percent-label")) {
          qi("sl-percent").oninput = () => {
            qi("sl-percent-label").textContent = qi("sl-percent").value + "%";
          };
        }
        const btn = qi("sl-set-btn");
        if (!btn) { derror("wire: sl-set-btn missing"); return; }
        btn.onclick = () => {
          const saved = JSON.parse(localStorage.getItem("sl-settings") || "{}");
          const ui = UI_DEFAULTS["info-stoploss"];
          const pct = pickNum(qi("sl-percent")?.value, saved.pct, ui.pct);

          localStorage.setItem("sl-settings", JSON.stringify({ pct }));
          if (qi("sl-current")) qi("sl-current").textContent = `Stop-loss at ${pct}%`;

          showToast("Stop-Loss settings saved", "success");
          dlog("saved: stoploss", { pct });
          modal.style.display = "none";
        };
      }
    },

    "info-harvest": {
      title: "Harvest & Convert",
      body: `
        Swap rewards into MON or stablecoin, then restake.<br>
        <b>Vault Equivalent:</b> Strategy vault with token conversion.<br>
        <b>Rebel Pool Advantage:</b> Keep liquidity, choose swap path.
        <hr>
        <div class="settings">
          <label><b>Target Token:</b></label><br>
          <select id="hc-token" style="width:100%; margin:4px 0 8px;">
            <option value="MON">MON</option>
            <option value="USDC">USDC</option>
          </select>
          <label><b>Slippage Tolerance (%):</b></label><br>
          <input id="hc-slippage" type="number" min="0" max="5" step="0.1" placeholder="0.5" style="width:100%; margin:4px 0;"/>
        </div>
        <div style="margin-top:12px; text-align:right;">
          <button id="hc-set-btn" class="btn small" type="button">Set</button>
        </div>
        <div id="hc-current" class="muted small" style="margin-top:6px;"></div>
      `,
      prefill() {
        const saved = JSON.parse(localStorage.getItem("hc-settings") || "{}");
        const ui = UI_DEFAULTS["info-harvest"];
        const token = pickStr(undefined, saved.token, ui.token);
        const slip  = pickNum(undefined, saved.slip,  ui.slip);

        if (qi("hc-token"))     qi("hc-token").value     = token;
        if (qi("hc-slippage"))  qi("hc-slippage").value  = slip;
        if (qi("hc-current"))   qi("hc-current").textContent = `Convert to ${token}, slip ${slip}%`;

        dlog("prefill: harvest", { saved, ui, token, slip });
      },
      wire() {
        const btn = qi("hc-set-btn");
        if (!btn) { derror("wire: hc-set-btn missing"); return; }
        btn.onclick = () => {
          const saved = JSON.parse(localStorage.getItem("hc-settings") || "{}");
          const ui = UI_DEFAULTS["info-harvest"];
          const token = pickStr(qi("hc-token")?.value,    saved.token, ui.token);
          const slip  = pickNum(qi("hc-slippage")?.value, saved.slip,  ui.slip);

          localStorage.setItem("hc-settings", JSON.stringify({ token, slip }));
          if (qi("hc-current")) qi("hc-current").textContent = `Convert to ${token}, slip ${slip}%`;

          showToast("Harvest settings saved", "success");
          dlog("saved: harvest", { token, slip });
          modal.style.display = "none";
        };
      }
    },

    "info-rebalance": {
      title: "Yield Rebalance",
      body: `
        Routes deposits to best strategies automatically.<br>
        <b>Vault Equivalent:</b> Auto-rebalance vaults.<br>
        <b>Rebel Pool Advantage:</b> Non-custodial, liquid, always optimal.
        <hr>
        <div class="settings">
          <label><b>Min Yield Delta (%):</b></label><br>
          <input id="yr-delta" type="number" min="0" max="20" step="0.1" placeholder="1.0" style="width:100%; margin:4px 0;"/>
        </div>
        <div style="margin-top:12px; text-align:right;">
          <button id="yr-set-btn" class="btn small" type="button">Set</button>
        </div>
        <div id="yr-current" class="muted small" style="margin-top:6px;"></div>
      `,
      prefill() {
        const saved = JSON.parse(localStorage.getItem("yr-settings") || "{}");
        const ui = UI_DEFAULTS["info-rebalance"];
        const delt = pickNum(undefined, saved.delt, ui.delt);

        if (qi("yr-delta"))   qi("yr-delta").value = delt;
        if (qi("yr-current")) qi("yr-current").textContent = `Rebalance if Δ ≥ ${delt}%`;

        dlog("prefill: rebalance", { saved, ui, delt });
      },
      wire() {
        const btn = qi("yr-set-btn");
        if (!btn) { derror("wire: yr-set-btn missing"); return; }
        btn.onclick = () => {
          const saved = JSON.parse(localStorage.getItem("yr-settings") || "{}");
          const ui = UI_DEFAULTS["info-rebalance"];
          const delt = pickNum(qi("yr-delta")?.value, saved.delt, ui.delt);

          localStorage.setItem("yr-settings", JSON.stringify({ delt }));
          if (qi("yr-current")) qi("yr-current").textContent = `Rebalance if Δ ≥ ${delt}%`;

          showToast("Yield Rebalance settings saved", "success");
          dlog("saved: rebalance", { delt });
          modal.style.display = "none";
        };
      }
    },

    "info-suggest": {
      title: "Suggestions",
      body: `
        Receive nudges with ROI, risks, and recommendations.<br>
        <b>Vault Equivalent:</b> Advisory-only products.<br>
        <b>Rebel Pool Advantage:</b> Transparent, optional suggestions.
      `
    }
  };

  const def = MAP[key] || { title: "Info", body: "<div>No details.</div>" };
  title.textContent = def.title;
  body.innerHTML = def.body;
  modal.style.display = "flex";
  dlog("rendered:", key);

  // Defer prefill+wire to ensure DOM nodes exist inside modal
  setTimeout(() => {
    try {
      if (typeof def.prefill === "function") def.prefill();
    } catch (e) { derror("prefill error:", e); }
    try {
      if (typeof def.wire === "function") def.wire();
    } catch (e) { derror("wire error:", e); }
  }, 0);
}



})();

