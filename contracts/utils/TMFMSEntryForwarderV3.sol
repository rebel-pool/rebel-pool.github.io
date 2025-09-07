// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

interface ITMFMSRelayManager {
    function preflight(
        address relayer,
        address user,
        address target,
        bytes4 selector,
        uint256 fid
    ) external;

    function afterExecute(
        address relayer,
        uint256 fid,
        address target,
        bytes4 selector,
        bool success,
        uint256 gasUsed
    ) external;

    function creditsOf(address dapp) external view returns (uint256);
}

/// @title The Monad Fantastic — Entry Forwarder (Meta-transactions, V3)
/// @notice EIP-2771 style forwarder with relayer/target allowlists + RelayManager V2 hooks.
///         Appends the original `from` (20 bytes) to calldata so targets can recover msgSender.
contract TMFMSEntryForwarderV3 is Ownable {
    using ECDSA for bytes32;

    // ----------------------------- Types -----------------------------

    struct ForwardRequest {
        address from;   // end user (signer)
        address to;     // target contract (must be allowlisted)
        uint256 value;  // ETH value to forward
        uint256 gas;    // gas stipend for the call (optional; can be 0 to forward all)
        uint256 nonce;  // per-user monotonic
        bytes data;     // calldata for target function (selector + args)
    }

    // EIP-712 typed struct hash
    bytes32 private constant _TYPEHASH =
        keccak256("ForwardRequest(address from,address to,uint256 value,uint256 gas,uint256 nonce,bytes data)");

    // ---------------------------- Storage ----------------------------

    mapping(address => uint256) public nonces;            // user => next nonce
    mapping(address => bool) public isRelayer;            // relayer allowlist
    mapping(address => bool) public isTargetAllowed;      // target allowlist

    ITMFMSRelayManager public relayManager;               // policy/quota contract

    // EIP-712 domain cache
    bytes32 private _domainSeparator;
    uint256 private _domainChainId;

    // ----------------------------- Events ----------------------------

    event RelayerSet(address indexed relayer, bool allowed);
    event TargetAllowed(address indexed target, bool allowed);
    event RelayManagerSet(address indexed manager);
    event DomainSeparatorRefreshed(uint256 chainId, bytes32 domainSeparator);

    // ---------------------------- Constructor ------------------------

    constructor(address owner_) Ownable(owner_) {
        _setDomainSeparator();
    }

    // ------------------------------ Admin ----------------------------

    function setRelayer(address relayer, bool ok) external onlyOwner {
        isRelayer[relayer] = ok;
        emit RelayerSet(relayer, ok);
    }

    function setAllowedTarget(address target, bool ok) external onlyOwner {
        isTargetAllowed[target] = ok;
        emit TargetAllowed(target, ok);
    }

    function setRelayManager(address manager) external onlyOwner {
        relayManager = ITMFMSRelayManager(manager);
        emit RelayManagerSet(manager);
    }

    /// @notice Manually refresh the EIP-712 domain separator (defensive; rarely needed).
    function refreshDomainSeparator() external onlyOwner {
        _setDomainSeparator();
        emit DomainSeparatorRefreshed(_domainChainId, _domainSeparator);
    }

    // --------------------------- EIP-712 Domain ----------------------

    function domainSeparator() public view returns (bytes32) {
        // If the chain id changed (unlikely), re-derive on-the-fly for reads.
        if (block.chainid == _domainChainId) return _domainSeparator;
        return _deriveDomainSeparator(block.chainid);
    }

    function _setDomainSeparator() internal {
        _domainChainId = block.chainid;
        _domainSeparator = _deriveDomainSeparator(_domainChainId);
    }

    function _deriveDomainSeparator(uint256 chainId) private view returns (bytes32) {
        return keccak256(
            abi.encode(
                // EIP-712 Domain: name, version, chainId, verifyingContract
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("TMFMSEntryForwarder")),
                keccak256(bytes("2")),
                chainId,
                address(this)
            )
        );
    }

    // --------------------------- Forwarder API -----------------------

    function getNonce(address from) external view returns (uint256) {
        return nonces[from];
    }

    /// @notice Verifies signature and basic constraints (target allowlist, nonce).
    function verify(ForwardRequest calldata req, bytes calldata signature) public view returns (bool) {
        require(isTargetAllowed[req.to], "target not allowed");

        // Use current (or derived) domain for robustness
        bytes32 dom = domainSeparator();

        bytes32 structHash = keccak256(
            abi.encode(_TYPEHASH, req.from, req.to, req.value, req.gas, req.nonce, keccak256(req.data))
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", dom, structHash));
        address signer = ECDSA.recover(digest, signature);

        return signer == req.from && req.nonce == nonces[req.from];
    }

    /// @notice Execute user-signed call; must be sent by an allowlisted relayer.
    /// @param fid The user's Fantastic ID (RelayManager V2 will bind it to Passport).
    function execute(ForwardRequest calldata req, bytes calldata signature, uint256 fid)
        external
        payable
        returns (bool success, bytes memory returndata)
    {
        require(isRelayer[msg.sender], "unauthorized relayer");
        require(verify(req, signature), "invalid signature");

        // Preflight quota/policy checks (may revert)
        if (address(relayManager) != address(0)) {
            relayManager.preflight(msg.sender, req.from, req.to, _selector(req.data), fid);
        }

        // Consume nonce before the call to prevent replays even if target reverts
        nonces[req.from]++;

        // Snapshot gas (best-effort accounting)
        uint256 startGas = gasleft();

        // Forward the call: append the original sender (20 bytes) to calldata.
        // Targets can recover end-user via a Context2771 helper or manual trailing-bytes read.
        // Gas policy: if req.gas == 0, forward all remaining gas; else pass req.gas (clamped by EVM).
        uint256 callGas = req.gas == 0 ? gasleft() : req.gas;

        (success, returndata) = req.to.call{gas: callGas, value: req.value}(
            abi.encodePacked(req.data, req.from)
        );

        uint256 gasUsed = startGas - gasleft();

        if (address(relayManager) != address(0)) {
            relayManager.afterExecute(msg.sender, fid, req.to, _selector(req.data), success, gasUsed);
        }
    }

    // --------------------------- Utils -------------------------------

    function _selector(bytes calldata data) internal pure returns (bytes4 sel) {
        if (data.length >= 4) {
            assembly { sel := calldataload(data.offset) }
        }
    }

    receive() external payable {}
}
