// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";
import {ShowcaseRefiller} from "../src/ShowcaseRefiller.sol";
import {KeeperRefillerConfig as C} from "../script/DeployKeeperRefiller.s.sol";

contract KeeperRefillerTest is Test {
    ShowcaseRefiller r;
    function setUp() public {
        (ShowcaseRefiller.Slot[] memory s, address[] memory c) = C.slots();
        vm.prank(C.DEPLOYER); r = new ShowcaseRefiller(s, c, C.PER_CALL_CAP, C.DAILY_CAP, C.COOLDOWN);
        vm.deal(address(r), 15 ether); vm.deal(C.KEEPER, 0);
    }
    function test_config() public view {
        assertEq(r.owner(), C.DEPLOYER); assertEq(r.slotCount(), 1);
        (address to, uint96 mn, uint96 tg) = r.slot(0); assertEq(to, C.KEEPER); assertEq(mn, 2 ether); assertEq(tg, 4 ether);
        assertTrue(r.isCaller(C.KEEPER)); assertTrue(r.isRecipient(C.KEEPER));
    }
    function test_keeper_refills_itself_to_target_only() public {
        vm.deal(C.KEEPER, 1.5 ether);
        vm.prank(C.KEEPER); uint256 sent = r.refill(false);
        assertEq(sent, 2.5 ether); assertEq(C.KEEPER.balance, 4 ether);
        vm.warp(block.timestamp + 31 minutes); vm.prank(C.KEEPER); assertEq(r.refill(false), 0); // at target: nothing
    }
    function test_caps_bound_a_leaked_key() public {
        uint256 moved;
        for (uint256 i; i < 10; ++i) { vm.deal(C.KEEPER, 0); vm.warp(block.timestamp + 31 minutes); vm.prank(C.KEEPER); moved += r.refill(false); }
        assertLe(moved, C.DAILY_CAP); // 10 drains in under 24 h: never more than the daily cap, and only to the keeper
    }
    function test_strangers_and_withdraw() public {
        vm.expectRevert(ShowcaseRefiller.NotCaller.selector); vm.prank(address(0xBEEF)); r.refill(true);
        vm.expectRevert(ShowcaseRefiller.NotOwner.selector); vm.prank(C.KEEPER); r.withdraw(1 ether);
        vm.prank(C.DEPLOYER); r.withdrawAll(); assertEq(address(r).balance, 0);
    }
}
