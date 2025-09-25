# Rebel Pool: Smartified

### Liquid Staking and Delegated Automation on Monad

Rebel Pool is a liquid staking protocol built for Monad.  
Our commitment is simple: **99% of yield flows directly to stakers, 1% is reserved for community sustainers.**  
There are no pre-release investors, no hidden backdoors, and no VC capture — only transparent contracts and verifiable code.  

With the addition of the **RuleDelegation module**, Rebel Pool is now **Smartified**:  
- Users register simple rule-based strategies (auto-compound, unstake, delegate stake).  
- Agents execute these rules on-chain under delegated permissions.  
- Executors receive micro-tips, ensuring aligned incentives.  
- Powered by **MetaMask Smart Accounts** and the delegation flow.  

## Ethos

- **Stakers First** — 99% of all rewards flow directly back to stakers.  
- **Community Share** — 1% skim sustains outreach, promotion, and ecosystem growth.  
- **Truth in Code** — open contracts, transparent audits, and deterministic logic.  
- **Bootstrap Discipline** — no VC dependence, no opaque mechanics, only code and execution.  
- **Smartified** — a new layer of delegated automation, bringing AI and rule-based agents into staking.  

## Features

- Liquid staking with AquaMON (stMON) and ArcMON (wstMON).  
- One-click native staking via RebelNativeRouter.  
- Delegated automation through the RuleDelegation contract.  
- MetaMask Smart Accounts integration for delegated execution.  
- Transparent fee structure: capped at 600 bps, auditable on-chain.  

## Technical Stack

- **Solidity 0.8.24** with UUPS upgradeable architecture.  
- **Core Contracts**: StakePoolCore, AquaMON, ArcMON, WMON, RebelNativeRouter, RuleDelegation.  
- **Delegation Layer**: EntryForwarder and RelayManager for EIP-2771 meta-transactions.  
- **Frontend**: GitHub Pages with lightweight UI.  
- **Deployment**: Monad Testnet.  

## Contracts (Monad Testnet)

- WMON Proxy: `0x0f19e23E213F40Cd1dB36AA2486f2DA76586b010`  
- AquaMON Proxy: `0xd4522Ed884254008C04008E3b561dFCF4eFC0306`  
- StakePoolCore Proxy: `0x25E24c54e65a51aa74087B8EE44398Bb4AB231Dd`  
- ArcMON Proxy: `0x19157c7b66Af91083431D616cbD023Cfda3264bd`  
- RebelNativeRouter Proxy: `0x26e245dc47457f0B58E243e0E38F7008f9863175`  
- RuleDelegation Proxy: `0x83a050A961127C1D8968E8DF40DE8310EC786C8A`  

## Demonstration

- Demo Video: *to be published*  
- Pitch Video: *to be published*  
- Live Pro9duct: [rebel-pool.github.io](https://rebel-pool.github.io)  

## Resources

- Source Code: [src/the_rebel_pool](./src/the_rebel_pool)  
- Test Suite: [rebel_pool_tests.sh](./rebel_pool_tests.sh)  
- Manifest: [MANIFEST.md](./MANIFEST.md)  

## Community

- Website: [rebel-pool.github.io](https://rebel-pool.github.io)  
- Twitter/X: [@PoolStakeElite](https://twitter.com/PoolStakeElite)  
- Discord: *invite to be published*  
- Documentation: *in progress*  

## License

Rebel Pool is released under the MIT License.  
See [LICENSE](./LICENSE) for details.  
