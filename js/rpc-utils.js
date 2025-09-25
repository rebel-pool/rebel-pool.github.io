// js/rpc-utils.js — UMD-style utilities (attach to window.RPCUtils)
// - Read provider factory (round-robin) / setter
// - Global wrapper for ALL injected providers (queue + backoff + modal)
// - ChainId cache + listener (no spam)
// - Offload safe reads to RO pool
// - Global cross-tab wallet-send mutex + pacing
// - Safe fee guess (RO only) + sendTxWithRetry
// - Friendly errors
// - Basic wallet helpers (pickInjectedProvider, ensureMonadNetwork)
// - Optional coalesced block polling
// - Node health helpers (status, block info, balances)

;(function (global) {
  const RPCUtils = {};
  let roProvider = null; // shared RO provider set by setReadProvider()

  // ---------- Mini helpers ----------
  function esc(s){ return String(s||"").replace(/[&<>"]/g, c=>({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;" }[c])); }
  const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
  const hasEthers = ()=> typeof global.ethers !== "undefined";

  // ---------- Rate-limit modal ----------
  const RateLimitUI = (function(){
    let modal, msgEl, stopBtn, timerId, stop=false;

    function ensure(){
      if (modal) return;
      modal = document.createElement('div');
      modal.id = 'rl-modal';
      modal.className = 'modal';
      modal.style.display = 'none';
      modal.innerHTML = `
        <div class="modal-content" style="max-width:520px">
          <h3 style="margin:0 0 8px">RPC is busy / rate-limited</h3>
          <div id="rl-msg" class="muted" style="line-height:1.5"></div>
          <div style="margin-top:12px; display:flex; gap:8px; justify-content:flex-end">
            <button id="rl-stop" class="btn btn-outline">Stop retries</button>
          </div>
          <div class="muted" style="margin-top:10px; font-size:.9em">
            Your wallet controls submission. If a popup appears, act there.<br>
            If nothing appears, click the wallet’s browser icon to open it.
          </div>
        </div>`;
      document.body.appendChild(modal);
      msgEl   = modal.querySelector('#rl-msg');
      stopBtn = modal.querySelector('#rl-stop');
      stopBtn.onclick = ()=>{ stop = true; };
    }

    async function onBackoff({ method, attempt, maxTries, delayMs }) {
      ensure(); stop=false; modal.style.display='flex';
      const secs = Math.max(0, Math.ceil(delayMs/1000));
      msgEl.innerHTML =
        `The RPC is rate-limiting <code>${esc(method)}</code>.<br>`+
        `Attempt <b>${attempt}</b> of <b>${maxTries}</b>. Retrying in <b id="rl-count">${secs}</b>s…`;
      clearInterval(timerId);
      let left = secs;
      const counter = modal.querySelector('#rl-count');
      await new Promise(resolve=>{
        timerId = setInterval(()=>{
          if (stop) { clearInterval(timerId); resolve(); return; }
          if (left<=0){ clearInterval(timerId); resolve(); return; }
          left -= 1; if (counter) counter.textContent = String(left);
        },1000);
      });
    }
    function hide(){ clearInterval(timerId); if (modal) modal.style.display='none'; }
    function shouldStop(){ return stop; }
    return { onBackoff, hide, shouldStop };
  })();

  RPCUtils.RateLimitUI = RateLimitUI;

  // ---------- RO provider plumbing (round-robin sender) ----------
  RPCUtils.setReadProvider = function(provider){ roProvider = provider || null; };
  RPCUtils.makeReadProvider = function(cfg){
    const urls = []
      .concat(Array.isArray(cfg?.rpcs) ? cfg.rpcs : [])
      .concat(cfg?.rpc ? [cfg.rpc] : [])
      .filter(Boolean);
    if (!urls.length) return null;

    let i = 0;
    async function rrSend(method, params = []){
      let lastErr;
      for (let k=0; k<urls.length; k++){
        const url = urls[i++ % urls.length];
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: Math.random(), method, params })
          });
          if (!res.ok) throw new Error(`RO HTTP ${res.status}`);
          const j = await res.json();
          if (j.error) { const e = new Error(j.error.message); e.code = j.error.code; throw e; }
          return j.result;
        } catch (e) { lastErr = e; }
      }
      throw lastErr || new Error('RO failed');
    }
    return { send: rrSend };
  };
  RPCUtils.roSend = async function(method, params=[]){
    if (!roProvider) throw new Error('RO provider not initialized');
    return await roProvider.send(method, params);
  };

  // ---------- Wallet helpers ----------
  function getLocalChainIdHex(inj){
    const hex = inj && typeof inj.chainId==="string" ? inj.chainId : null;
    return hex && /^0x[0-9a-f]+$/i.test(hex) ? hex.toLowerCase() : null;
  }
  RPCUtils.pickInjectedProvider = function(){
    const eth = global.ethereum;
    const list = [];
    if (Array.isArray(eth?.providers)) list.push(...eth.providers);
    if (eth && !list.includes(eth)) list.push(eth);
    if (!list.length) return null;
    const mew = list.find(p=>p && (p.isMEW || p?.providerInfo?.name==="MEW"));
    if (mew) return { provider: mew, name:'MEW' };
    const mm  = list.find(p=>p && p.isMetaMask) || (eth?.isMetaMask ? eth : null);
    if (mm) return { provider: mm, name:'MetaMask' };
    return list[0] ? { provider: list[0], name:'Injected' } : null;
  };
  RPCUtils.ensureMonadNetwork = async function(inj, cfg){
    const wantHex = "0x"+(cfg?.chainId || 10143).toString(16);
    const local = getLocalChainIdHex(inj);
    if (local===wantHex.toLowerCase()) return wantHex;

    try {
      const current = await inj.request({ method:'eth_chainId' });
      if (String(current).toLowerCase()===wantHex.toLowerCase()) return wantHex;
    } catch {}

    try {
      await inj.request({ method:'wallet_switchEthereumChain', params:[{ chainId: wantHex }] });
      return wantHex;
    } catch (e) {
      const msg = String(e?.message||"").toLowerCase();
      const needsAdd = (e?.code===4902) || /unrecognized|not added|missing chain/.test(msg) || e?.code===-32603;
      if (needsAdd) {
        await inj.request({
          method:'wallet_addEthereumChain',
          params:[{
            chainId: wantHex,
            chainName: cfg?.label || 'Monad Testnet',
            nativeCurrency: { name: cfg?.coin?.native?.name || 'Monad', symbol: cfg?.coin?.native?.symbol || 'MON', decimals: 18 },
            rpcUrls: (Array.isArray(cfg?.rpcs)?cfg.rpcs:[]).concat(cfg?.rpc?[cfg.rpc]:[]).filter(Boolean),
            blockExplorerUrls: cfg?.explorer ? [cfg.explorer] : []
          }]
        });
        await inj.request({ method:'wallet_switchEthereumChain', params:[{ chainId: wantHex }] });
        return wantHex;
      }
      if (e?.code===4001) throw new Error('User rejected the network switch.');
      throw e;
    }
  };

  // ---------- ChainId cache + listeners ----------
  let _chainIdCache = null;
  let _chainIdInflight = null;
  function cacheChainId(cid){
    if (typeof cid === 'string' && /^0x[0-9a-f]+$/i.test(cid)) _chainIdCache = cid.toLowerCase();
    return _chainIdCache;
  }
  async function getChainIdFromWallet(inj){
    if (_chainIdCache) return _chainIdCache;
    if (_chainIdInflight) return _chainIdInflight;
    _chainIdInflight = inj.requestOriginal({ method: 'eth_chainId' })
      .then(cacheChainId)
      .finally(()=>{ _chainIdInflight = null; });
    return _chainIdInflight;
  }

  // ---------- Cross-tab global send mutex ----------
  const SEND_LOCK_KEY = 'rebel_wallet_send_lock_v1';
  const SEND_LOCK_TTL = 15000; // 15s refresh window
  const HAS_BC = typeof BroadcastChannel !== 'undefined';
  const SEND_CH = HAS_BC ? new BroadcastChannel('rebel_wallet_send') : null;
  const LOCK_OWNER = Math.random().toString(36).slice(2);
  const now = ()=>Date.now();
  function getLock(){ try { return JSON.parse(localStorage.getItem(SEND_LOCK_KEY)||'null'); } catch { return null; } }
  function setLock(v){ try { localStorage.setItem(SEND_LOCK_KEY, JSON.stringify(v)); } catch {} }
  function clearLock(){ try { localStorage.removeItem(SEND_LOCK_KEY); } catch {} }
  async function acquireGlobalSendLock(timeoutMs=20000){
    const start = now();
    while (true){
      const cur = getLock();
      if (!cur || (now() - cur.t) > SEND_LOCK_TTL){
        setLock({ id: LOCK_OWNER, t: now() });
        await sleep(50);
        const again = getLock();
        if (again && again.id === LOCK_OWNER) return; // acquired
      }
      if (now() - start > timeoutMs) {
        const err = new Error('Wallet send lock timeout');
        err.code = 'SEND_LOCK_TIMEOUT';
        throw err;
      }
      await sleep(120);
    }
  }
  function refreshGlobalSendLock(){ const cur=getLock(); if (cur && cur.id===LOCK_OWNER) setLock({ id: LOCK_OWNER, t: now() }); }
  function releaseGlobalSendLock(){ const cur=getLock(); if (cur && cur.id===LOCK_OWNER) clearLock(); try { SEND_CH?.postMessage('release'); } catch {}
  }
  SEND_CH && (SEND_CH.onmessage = ()=>{});

  // ---------- MetaMask throttle wrapper with pacing ----------
  const OFFLOAD_TO_RO = new Set([
    'eth_blockNumber','eth_getBlockByNumber','eth_gasPrice','eth_maxPriorityFeePerGas','eth_feeHistory',
    'eth_getTransactionByHash','eth_getTransactionReceipt','eth_call','eth_estimateGas','eth_getBalance','eth_getCode',
    'eth_getLogs','eth_maxFeePerGas'
  ]);

  let _lastWalletSendAt = 0;
  const TX_SPACING_MS = 2500; // enforce min gap between wallet sends (tune 1200–3000)

  RPCUtils.wrapInjectedRequest = function(inj, opts={}){
    if (!inj || typeof inj.request!=="function") return inj;
    if (inj.__rp_wrapped_request) return inj;

    const o = Object.assign({ pre: 500, post: 350, base: 1000, maxTries: 6, jitter: 300, debug: true }, opts);

    const original = inj.request.bind(inj);
    let queue = Promise.resolve();
    inj.__rp_wrapped_request = true;
    inj.requestOriginal = original;

    // keep chainId cache fresh
    try { inj.removeListener?.('chainChanged', cacheChainId); inj.on?.('chainChanged', (cid)=>{ cacheChainId(cid); }); } catch {}

    inj.request = (args)=>{
      queue = queue.then(async ()=>{
        const method = args?.method || 'unknown';
        const params = args?.params || [];

        // 0) short-circuit eth_chainId using cache
        if (method === 'eth_chainId') {
          const cid = _chainIdCache || await getChainIdFromWallet(inj);
          if (o.debug) console.debug('[mmwrap] ← eth_chainId cached', cid);
          RateLimitUI.hide();
          return cid;
        }

        // 1) offload safe reads to RO
        if (OFFLOAD_TO_RO.has(method) && roProvider) {
          try {
            if (o.debug) console.debug('[mmwrap→ro]', method, params);
            const res = await RPCUtils.roSend(method, params);
            if (o.debug) console.debug('[mmwrap←ro]', method, 'ok');
            RateLimitUI.hide();
            return res;
          } catch (e) {
            if (o.debug) console.debug('[mmwrap ro-fallback]', method, e);
          }
        }

        // wallet-bound?
        const isWalletSend = (
          method === 'eth_sendTransaction' ||
          method === 'eth_signTransaction' ||
          method.startsWith('eth_signTypedData')
        );

        if (isWalletSend) {
          // cross-tab global lock + spacing gate
          await acquireGlobalSendLock();
          const gap = TX_SPACING_MS - (Date.now() - _lastWalletSendAt);
          if (gap > 0) {
            if (o.debug) console.debug('[mmwrap] ⏳ pacing send by', gap, 'ms');
            await sleep(gap);
          }
        }

        const pre = o.pre + Math.random()*o.jitter;
        if (o.debug) console.debug('[mmwrap] →', method, params);
        await sleep(pre);

        try {
          let attempt = 0;
          while (true) {
            try {
              const res = await original(args);
              if (o.debug) console.debug('[mmwrap] ←', method, 'ok');
              if (isWalletSend) _lastWalletSendAt = Date.now();
              RateLimitUI.hide();
              await sleep(o.post);
              return res;
            } catch (e) {
              const msg = (e?.message||'') + ' ' + JSON.stringify(e?.data||{});
              const rl  = /429|rate limit|-32005|-32603/i.test(msg) || e?.code===-32005 || e?.code===-32603;
              if (!rl || attempt+1>=o.maxTries) { if (o.debug) console.debug('[mmwrap] ✖', method, 'error (giving up)', e); RateLimitUI.hide(); throw e; }
              attempt++;
              const delay = o.base * Math.pow(2, attempt-1) + Math.random()*o.jitter;
              if (o.debug) console.debug('[mmwrap] ↻', method, `backoff ${Math.round(delay)}ms (attempt ${attempt+1}/${o.maxTries})`);
              await RateLimitUI.onBackoff({ method, attempt: attempt+1, maxTries: o.maxTries, delayMs: delay });
              await sleep(delay);
              if (isWalletSend) refreshGlobalSendLock();
            }
          }
        } finally {
          if (isWalletSend) releaseGlobalSendLock();
        }
      });
      return queue;
    };

    return inj;
  };

  // Wrap primary and multiplexed providers so nothing bypasses queue/backoff
  RPCUtils.wrapAllInjected = function(opts){
    const eth = global.ethereum;
    if (!eth) return null;
    RPCUtils.wrapInjectedRequest(eth, opts);
    if (Array.isArray(eth.providers)) eth.providers.forEach(p => RPCUtils.wrapInjectedRequest(p, opts));
    return eth;
  };

  // ---------- Fees + retry ----------
RPCUtils.getNetworkFeeGuessSafe = async function() {
  if (!roProvider) throw new Error("RO provider not initialized");
  if (!hasEthers()) throw new Error("Ethers not loaded for fee math");
  const { BigNumber, utils } = global.ethers;

  try {
    // Try EIP-1559 style first
    const latest = await RPCUtils.roSend("eth_getBlockByNumber", ["latest", false]).catch(()=>null);
    const tipHex = await RPCUtils.roSend("eth_maxPriorityFeePerGas", []).catch(()=>null);

    if (latest?.baseFeePerGas) {
      const base = BigNumber.from(latest.baseFeePerGas);
      const tip  = tipHex ? BigNumber.from(tipHex) : utils.parseUnits("2", "gwei");
      const maxFeePerGas = base.mul(12).div(10).add(tip);
      return { eip1559: true, maxFeePerGas, maxPriorityFeePerGas: tip };
    }
  } catch (e) {
    console.warn("[rpc-utils] getNetworkFeeGuessSafe EIP-1559 failed, falling back:", e);
  }

  // Fallback: legacy gasPrice
  try {
    const gpHex = await RPCUtils.roSend("eth_gasPrice", []).catch(()=>null);
    if (gpHex) {
      const gasPrice = global.ethers.BigNumber.from(gpHex).mul(5).div(4);
      return { eip1559: false, gasPrice };
    }
  } catch (e) {
    console.warn("[rpc-utils] getNetworkFeeGuessSafe gasPrice fallback failed:", e);
  }

  // Final hardcoded fallback
  return { eip1559: false, gasPrice: global.ethers.utils.parseUnits("1", "gwei") };
};


  function isFeeTooLow(err){
    const s = String(err?.reason || err?.error?.message || err?.message || err || '').toLowerCase();
    return /fee too low|maxfeepergas|max priority fee|underpriced|replacement/i.test(s);
  }
  RPCUtils.isFeeTooLow = isFeeTooLow;

  function friendlyError(err){
    const raw = err?.error?.data ?? err?.data ?? err?.error?.message ?? err?.reason ?? err?.message ?? err;
    let s = typeof raw==='object' ? JSON.stringify(raw) : String(raw||'');
    if (err?.code==='USER_ABORT_RATE_LIMIT') return 'Stopped while the network was overloaded. Try again later from your wallet.';
    if ((/-32005|-32603/).test(String(err?.code)) || /rate limit|429|too many requests/i.test(s)) {
      return 'Request is being rate-limited by the RPC node.<br>Wait a minute and try again. Avoid double-clicking.';
    }
    if (err?.code===-32002 || /already processing/i.test(s)) return 'Your wallet is already handling a request.<br>Open your wallet and complete/close the pending prompt.';
    if (err?.code===4001 || /user rejected/i.test(s)) return 'You rejected the request in your wallet.';
    if (/insufficient funds/i.test(s)) return 'Insufficient MON in your wallet for this action (or gas).';
    if (/nonce too low/i.test(s))     return 'Wallet nonce is out of sync. Wait a moment or reset nonce, then retry.';
    if (/wrong network|chain id/i.test(s)) return 'Wrong network selected in wallet. Please switch to Monad Testnet (10143).';
    if (isFeeTooLow(err)) {
      return 'Network rejected the fee as too low. We retried with a higher tip automatically. If it still fails, wait ~30–60s for fees to stabilize and try again.';
    }
    return esc(s || 'Unknown error');
  }
  RPCUtils.friendlyError = friendlyError;

  RPCUtils.sendTxWithRetry = async function(fnSend, baseFee, gasLimit, labelHtml){
    let overrides = baseFee.eip1559
      ? { type:2, maxFeePerGas: baseFee.maxFeePerGas, maxPriorityFeePerGas: baseFee.maxPriorityFeePerGas }
      : { gasPrice: baseFee.gasPrice };
    if (gasLimit && !overrides.gasLimit) overrides.gasLimit = gasLimit;

    const MAX_RETRIES = 2; // total attempts = 1 + 2
    let attempt = 0;

    while (true) {
      try {
        if (labelHtml && attempt===0) {
          const hint = `<br><small class="muted"></small>`;
          if (typeof global.updateStakeModal === 'function') {
            global.updateStakeModal(`${labelHtml}<br><small>Submitting…</small>${hint}`);
          }
        }
        const tx = await fnSend(overrides);
        return tx;
      } catch (e) {
        if (!isFeeTooLow(e) || attempt>=MAX_RETRIES) throw e;
        attempt++;
        const factor  = attempt===1 ? 1.40 : 1.65;
        const tipBump = attempt===1 ? 1.0  : 2.0;
        if (baseFee.eip1559) {
          overrides = {
            type: 2,
            maxFeePerGas: baseFee.maxFeePerGas.mul(Math.round(factor*100)).div(100),
            maxPriorityFeePerGas: baseFee.maxPriorityFeePerGas.add(global.ethers.utils.parseUnits(String(tipBump), 'gwei')),
            gasLimit
          };
        } else {
          overrides = { gasPrice: baseFee.gasPrice.mul(Math.round(factor*100)).div(100), gasLimit };
        }
        const nextAttempt = attempt+1;
        const total = MAX_RETRIES+1;
        if (typeof global.updateStakeModal === 'function') {
          const hint = `<br><small class="muted">Network fees look low/volatile. If this fails, wait ~30–60s for fees to stabilize and try again.</small>`;
          global.updateStakeModal(`${labelHtml}<br><small>Fee too low — retrying with a higher tip (attempt ${nextAttempt} of ${total})…</small>${hint}`);
        }
      }
    }
  };

  // ---------- Optional: coalesced block polling ----------
  let _blkTimer=null, _blkSubs=new Set();
  RPCUtils.subscribeBlocks = function(fn){
    _blkSubs.add(fn);
    if (!_blkTimer) _blkTimer = setInterval(async ()=>{
      try {
        const n = await RPCUtils.roSend('eth_blockNumber', []);
        _blkSubs.forEach(f=>{ try { f(n) } catch{} });
      } catch {}
    }, 4000);
    return ()=>{ _blkSubs.delete(fn); if(!_blkSubs.size){ clearInterval(_blkTimer); _blkTimer=null; } };
  };

  // ---------- Node Health Helpers ----------
  RPCUtils.getNodeStatus = async function() {
    if (!roProvider) throw new Error("RO provider not initialized");

    const [cid, clientVersion, peerCount, syncing, protocol, listening] = await Promise.allSettled([
      RPCUtils.roSend("eth_chainId", []),
      RPCUtils.roSend("web3_clientVersion", []),
      RPCUtils.roSend("net_peerCount", []),
      RPCUtils.roSend("eth_syncing", []),
      RPCUtils.roSend("eth_protocolVersion", []),
      RPCUtils.roSend("net_listening", [])
    ]);

    function ok(p) { return p.status === "fulfilled" ? p.value : null; }

    return {
      chainId: ok(cid),
      clientVersion: ok(clientVersion),
      peerCount: ok(peerCount) ? parseInt(ok(peerCount), 16) : null,
      syncing: ok(syncing) && ok(syncing) !== false ? ok(syncing) : false,
      protocolVersion: ok(protocol),
      listening: ok(listening)
    };
  };

  RPCUtils.getBlockInfo = async function(tag = "latest") {
    if (!roProvider) throw new Error("RO provider not initialized");
    const block = await RPCUtils.roSend("eth_getBlockByNumber", [tag, false]);
    return {
      number: block?.number ? parseInt(block.number, 16) : null,
      timestamp: block?.timestamp ? new Date(parseInt(block.timestamp, 16) * 1000) : null,
      txCount: Array.isArray(block?.transactions) ? block.transactions.length : 0,
      baseFeePerGas: block?.baseFeePerGas || null,
      miner: block?.miner || null,
      hash: block?.hash || null,
      raw: block
    };
  };

  RPCUtils.getBalance = async function(addr) {
    if (!roProvider) throw new Error("RO provider not initialized");
    if (!hasEthers()) throw new Error("Ethers not loaded for BigNumber math");
    const balHex = await RPCUtils.roSend("eth_getBalance", [addr, "latest"]);
    return balHex ? global.ethers.BigNumber.from(balHex) : global.ethers.BigNumber.from(0);
  };

  // ---------- expose ----------
  global.RPCUtils = RPCUtils;
})(window);
