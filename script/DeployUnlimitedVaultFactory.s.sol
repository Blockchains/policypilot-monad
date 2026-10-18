// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {UnlimitedAgentVaultFactory} from "../src/UnlimitedAgentVault.sol";

/// PolicyPilot v4: vaults with no spending limits and no allowlists. ALPHA / UNAUDITED.
/// forge script script/DeployUnlimitedVaultFactory.s.sol --rpc-url https://rpc.monad.xyz --broadcast   (MONAD_MAINNET_PRIVATE_KEY in env)
contract DeployUnlimitedVaultFactory is Script {
    function run() external returns (UnlimitedAgentVaultFactory f) {
        uint256 pk = vm.envUint("MONAD_MAINNET_PRIVATE_KEY");
        vm.startBroadcast(pk);
        f = new UnlimitedAgentVaultFactory();
        vm.stopBroadcast();
        console.log("UnlimitedAgentVaultFactory", address(f));
    }
}
