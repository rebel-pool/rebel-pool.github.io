/* globals RPCUtils */
(function () {
  const { wrapInjectedRequest, ensureMonadNetwork } = RPCUtils;
  const $ = (id) => document.getElementById(id);

  // Detect installed injected wallets
  function detectInjected() {
    const eth = window.ethereum || {};
    const list = Array.isArray(eth.providers) ? eth.providers.slice() : [];
    if (eth && !list.includes(eth)) list.push(eth);

    const out = [];
    for (const p of list) {
      const id =
        p.isMetaMask ? 'metamask' :
        p.isBraveWallet ? 'brave' :
        p.isCoinbaseWallet ? 'coinbase' :
        p.isMEW || p?.providerInfo?.name === 'MEW' ? 'mew' :
        'injected';
      const name =
        id === 'metamask' ? 'MetaMask' :
        id === 'brave' ? 'Brave Wallet' :
        id === 'coinbase' ? 'Coinbase Wallet' :
        id === 'mew' ? 'MEW Wallet' : 'Injected';
      out.push({ id, name, provider: p });
    }
    // de-dupe by id (prefer first instance)
    const seen = new Set();
    return out.filter(w => (seen.has(w.id) ? false : (seen.add(w.id), true)));
  }

  // Minimal icons (optional: swap with real svgs)
  const ICONS = {
    metamask: '🦊', brave: '🦁', coinbase: '🟦', mew: '💎', injected: '🧩',
    rainbow: '🌈', walletconnect: '🔗'
  };

  function itemEl({ id, name, onClick }) {
    const el = document.createElement('div');
    el.className = 'wp-item';
    el.innerHTML = `<span class="wp-ico">${ICONS[id] || '🧩'}</span><span>${name}</span>`;
    el.onclick = onClick;
    return el;
  }

  async function connectInjected(provider, cfg, onConnected, onError) {
    try {
      const inj = wrapInjectedRequest(provider);
      await ensureMonadNetwork(inj, cfg);
      await inj.request({ method: 'eth_requestAccounts' });
      onConnected(inj);
    } catch (e) {
      onError?.(e);
    }
  }

  // Public API
  window.showWalletPicker = function showWalletPicker(cfg, onConnected) {
    const modal = $('wallet-picker');
    const installed = detectInjected();
    const $inst = $('wp-installed-list');
    const $pop = $('wp-popular-list');
    $inst.innerHTML = '';
    $pop.innerHTML = '';

    // Installed section
    if (installed.length) {
      installed.forEach(w => {
        $inst.appendChild(itemEl({
          id: w.id, name: w.name,
          onClick: () => connectInjected(w.provider, cfg, (inj) => {
            modal.style.display = 'none';
            onConnected?.(inj);
          }, (e) => alert(e?.message || 'Failed to connect'))
        }));
      });
    } else {
      $('wp-installed').style.display = 'none';
    }

    // Popular (WalletConnect optional hook)
    $pop.appendChild(itemEl({
      id: 'rainbow', name: 'Rainbow',
      onClick: () => alert('Use WalletConnect on mobile to connect Rainbow.')
    }));
    $pop.appendChild(itemEl({
      id: 'coinbase', name: 'Coinbase Wallet',
      onClick: () => alert('Install Coinbase Wallet extension or use WalletConnect.')
    }));
    $pop.appendChild(itemEl({
      id: 'walletconnect', name: 'WalletConnect',
      onClick: () => alert('WC not wired yet. If you want, I’ll add it (v2) with Monad chain config).')
    }));

    // Dismiss on backdrop click / ESC
    if (!modal.__wired) {
      modal.addEventListener('click', (e) => { if (e.target === modal) modal.style.display = 'none'; });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') modal.style.display = 'none'; });
      modal.__wired = true;
    }

    modal.style.display = 'flex';
  };
})();
