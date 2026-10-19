// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Script, console} from "forge-std/Script.sol";
import {ShowcaseRefiller} from "../src/ShowcaseRefiller.sol";

/// MonaDefi Momentum keeper gas refiller (operated by the team). ALPHA / UNAUDITED.
/// A second instance of the existing ShowcaseRefiller contract (no new contract code) with ONE fixed recipient: the
/// Momentum keeper gas wallet. The keeper (GitHub Actions, its own key) calls refill(false) when it is below 2 MON and
/// gets topped to 4 MON. The deployer key stays on the box: it only deploys and funds this float.
/// Worst case if the keeper key leaks: at most 6 MON per 24 h moves from this float to the keeper itself (nowhere else).
library KeeperRefillerConfig {
    address internal constant DEPLOYER = 0xc0c4E411e41bECAD6DA860F67063C2D6363a6113;
    address internal constant KEEPER = 0xDC079c2c18e5AA4844fB4a62b522962205ac7ad7;
    uint256 internal constant PER_CALL_CAP = 3 ether;
    uint256 internal constant DAILY_CAP = 6 ether;
    uint256 internal constant COOLDOWN = 30 minutes;

    function slots() internal pure returns (ShowcaseRefiller.Slot[] memory s, address[] memory callers) {
        s = new ShowcaseRefiller.Slot[](1);
        s[0] = ShowcaseRefiller.Slot(payable(KEEPER), 2 ether, 4 ether);
        callers = new address[](1);
        callers[0] = KEEPER;
    }
}

/// Usage (key never on the command line): set -a; . ~/.policypilot/mainnet-wallet.env; set +a;
///   forge script script/DeployKeeperRefiller.s.sol --rpc-url https://rpc.monad.xyz [--broadcast]
/// Deploys with zero float; fund it afterwards with a plain transfer (anyone can fund, only the owner can withdraw).
contract DeployKeeperRefiller is Script {
    function run() external returns (ShowcaseRefiller r) {
        uint256 pk = vm.envUint("MONAD_MAINNET_PRIVATE_KEY");
        require(vm.addr(pk) == KeeperRefillerConfig.DEPLOYER, "key is not the team deployer");
        (ShowcaseRefiller.Slot[] memory s, address[] memory c) = KeeperRefillerConfig.slots();
        vm.startBroadcast(pk);
        r = new ShowcaseRefiller(s, c, KeeperRefillerConfig.PER_CALL_CAP, KeeperRefillerConfig.DAILY_CAP, KeeperRefillerConfig.COOLDOWN);
        vm.stopBroadcast();
        console.log("KeeperRefiller", address(r));
    }
}
