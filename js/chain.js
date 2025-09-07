// js/chain.js
const NETWORKS = {
  "monad-testnet": {
    label: "Monad Testnet",
    rpc: "https://testnet-rpc.monad.xyz",
    explorer: "https://testnet.monadscan.com",
    pool: "0x25E24c54e65a51aa74087B8EE44398Bb4AB231Dd",
    wmon: "0x0f19e23E213F40Cd1dB36AA2486f2DA76586b010",
    aquamon: "0xd4522Ed884254008C04008E3b561dFCF4eFC0306",
    arcmon: "0x19157c7b66Af91083431D616cbD023Cfda3264bd",
    coin: {
      native: { name: "Monad", symbol: "MON" },
      wrapped: { name: "Wrapped Monad", symbol: "WMON" },
      aqua: { name: "AquaMON", symbol: "stMON" },
      arc: { name: "ArcMON", symbol: "wstMON" }
    },
    apr: 11.1,     // % demo
    disabled: false
  },
  "monad-mainnet": {
    label: "Monad Mainnet (soon)",
    rpc: "",
    explorer: "",
    pool: "",
    wmon: "",
    aquamon: "",
    coin: {
      native: { name: "Monad", symbol: "MON" },
      wrapped: { name: "Wrapped Monad", symbol: "WMON" },
      aqua: { name: "AquaMON", symbol: "stMON" },
      arc: { name: "ArcMON", symbol: "wstMON" }
    },
    apr: 8.3,     
    disabled: true
  },
  "sepolia": {
    label: "Optimism Sepolia (demo)",
    rpc: "",
    explorer: "",
    pool: "",
    wmon: "",
    aquamon: "",
    coin: {
      native: { name: "Sepolia ETH", symbol: "ETH" },
      wrapped: { name: "Wrapped ETH", symbol: "WETH" },
      aqua: { name: "AquaETH", symbol: "stETH" },
      arc: { name: "ArcETH", symbol: "wstETH" }
    },
    apr: 4.2,   // // no clue need to look up  
    disabled: true
  }
};

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

function getNetConfig() {
  let key = localStorage.getItem("rebel_network");
  if (!key || NETWORKS[key]?.disabled) {
    key = Object.entries(NETWORKS).find(([k, v]) => !v.disabled)?.[0];
  }
  return NETWORKS[key];
}
