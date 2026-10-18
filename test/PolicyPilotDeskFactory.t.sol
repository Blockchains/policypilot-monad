// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PolicyPilotDeskFactory} from "../src/PolicyPilotDeskFactory.sol";
import {PolicyPilotPrimeVault} from "../src/PolicyPilotPrimeVault.sol";
import {PolicyPilotClipVault} from "../src/PolicyPilotClipVault.sol";
import {PolicyPilotSpreadVault} from "../src/PolicyPilotSpreadVault.sol";

/// Constructor that would abuse the factory's admin role if arbitrary code were accepted.
contract Hijack {
    constructor(address prime) {
        PolicyPilotPrimeVault(payable(prime)).setExecutor(address(0xbad));
    }
}

contract PolicyPilotDeskFactoryTest is Test {
    PolicyPilotDeskFactory f;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    function setUp() public {
        vm.chainId(143);
        bytes memory p = type(PolicyPilotPrimeVault).creationCode;
        bytes memory c = type(PolicyPilotClipVault).creationCode;
        bytes memory s = type(PolicyPilotSpreadVault).creationCode;
        f = new PolicyPilotDeskFactory([keccak256(p), keccak256(c), keccak256(s)], [p.length, c.length, s.length]);
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
    }

    function _prime(address who) internal returns (PolicyPilotPrimeVault v) {
        bytes memory init = abi.encodePacked(
            type(PolicyPilotPrimeVault).creationCode,
            abi.encode(who, who, who, uint256(10 ether), uint256(10 ether), uint256(0.15 ether), PolicyPilotPrimeVault.TrancheType.JUNIOR)
        );
        vm.prank(who);
        v = PolicyPilotPrimeVault(payable(f.create(0, init)));
    }

    function testPrimeCreateThenDepositCreditsTheCreator() public {
        PolicyPilotPrimeVault v = _prime(alice);
        assertEq(f.creatorOf(address(v)), alice);
        assertEq(v.admin(), address(f));
        assertEq(v.guardian(), alice);
        assertEq(v.executor(), alice);
        assertEq(address(v).balance, 0);
        vm.prank(alice);
        v.deposit{value: 0.5 ether}(PolicyPilotPrimeVault.TrancheType.JUNIOR);
        assertEq(v.assetsOf(alice, PolicyPilotPrimeVault.TrancheType.JUNIOR), 0.5 ether);
        uint256 sh = v.userShares(alice, PolicyPilotPrimeVault.TrancheType.JUNIOR);
        uint256 before = alice.balance;
        vm.prank(alice);
        v.withdraw(PolicyPilotPrimeVault.TrancheType.JUNIOR, sh);
        assertEq(alice.balance - before, 0.5 ether);
        assertEq(f.vaultsOf(alice).length, 1);
    }

    function testCreatorKeepsPrimeAdminPowers() public {
        PolicyPilotPrimeVault v = _prime(alice);
        vm.prank(bob);
        vm.expectRevert(PolicyPilotDeskFactory.NotCreator.selector);
        f.primeSetExecutor(address(v), bob);
        vm.prank(alice);
        f.primeSetExecutor(address(v), bob);
        assertEq(v.executor(), bob);
        vm.prank(alice);
        v.triggerEmergencyHalt("test");
        vm.prank(alice);
        f.primeResumeTrading(address(v));
        assertFalse(v.isEmergencyHalted());
    }

    function testClipAndSpreadCreate() public {
        vm.startPrank(alice);
        address c = f.create(1, abi.encodePacked(type(PolicyPilotClipVault).creationCode, abi.encode(alice, uint256(10 ether))));
        address s = f.create(2, abi.encodePacked(type(PolicyPilotSpreadVault).creationCode, abi.encode(alice, uint256(10 ether), uint256(0), uint256(10_000))));
        PolicyPilotClipVault(payable(c)).deposit{value: 0.2 ether}();
        PolicyPilotSpreadVault(payable(s)).deposit{value: 0.2 ether}();
        vm.stopPrank();
        assertGt(PolicyPilotClipVault(payable(c)).balanceOf(alice), 0);
        assertGt(PolicyPilotSpreadVault(payable(s)).balanceOf(alice), 0);
        vm.prank(alice);
        vm.expectRevert(PolicyPilotDeskFactory.NotCreator.selector);
        f.primeSetExecutor(c, bob); // not a Prime vault
    }

    function testRejectsUnknownBytecode() public {
        PolicyPilotPrimeVault v = _prime(alice);
        bytes memory evil = abi.encodePacked(type(Hijack).creationCode, abi.encode(address(v)));
        vm.prank(bob);
        vm.expectRevert(PolicyPilotDeskFactory.UnknownBytecode.selector);
        f.create(0, evil);
        vm.expectRevert(PolicyPilotDeskFactory.UnknownKind.selector);
        f.create(3, evil);
        // A truncated known prefix is refused too.
        bytes memory p = type(PolicyPilotPrimeVault).creationCode;
        bytes memory cut = new bytes(p.length - 1);
        for (uint256 i; i < cut.length; i++) cut[i] = p[i];
        vm.expectRevert(PolicyPilotDeskFactory.UnknownBytecode.selector);
        f.create(0, cut);
        assertEq(v.executor(), alice);
    }

    function testCreateRevertsOnBadConstructorArgs() public {
        bytes memory init = abi.encodePacked(
            type(PolicyPilotPrimeVault).creationCode,
            abi.encode(address(0), alice, alice, uint256(10 ether), uint256(10 ether), uint256(0), PolicyPilotPrimeVault.TrancheType.JUNIOR)
        );
        vm.prank(alice);
        vm.expectRevert(PolicyPilotDeskFactory.DeployFailed.selector);
        f.create(0, init);
    }
}
