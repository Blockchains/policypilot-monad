// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {EpochAllowanceVault} from "../src/EpochAllowanceVault.sol";
import {SessionVault} from "../src/SessionVault.sol";
import {VetoDelayVault} from "../src/VetoDelayVault.sol";
import {NovelVaultFactory} from "../src/NovelVaultFactory.sol";

contract Rejector {
    receive() external payable {
        revert();
    }
}

contract ReenterEpoch {
    EpochAllowanceVault public v;
    bytes32 public id;

    function set(EpochAllowanceVault v_, bytes32 id_) external {
        v = v_;
        id = id_;
    }

    receive() external payable {
        try v.execute(keccak256(abi.encode(id, gasleft())), payable(address(this)), 1) {} catch {}
    }
}

contract ReenterRelease {
    VetoDelayVault public v;
    bytes32 public id;

    function set(VetoDelayVault v_, bytes32 id_) external {
        v = v_;
        id = id_;
    }

    receive() external payable {
        try v.release(id) {} catch {}
    }
}

contract EpochVaultTest is Test {
    NovelVaultFactory f;
    EpochAllowanceVault v;
    address owner = address(0xA11CE);
    address agent = address(0xA6E7);
    address bob = address(0xB0B);
    address eve = address(0xE7E);

    function setUp() public {
        f = new NovelVaultFactory(2 ether, 5 ether);
        address[] memory r = new address[](1);
        r[0] = bob;
        vm.deal(owner, 10 ether);
        vm.prank(owner);
        v = f.createEpochVault{value: 1 ether}(agent, 0.2 ether, 0.3 ether, 1 hours, 0.4 ether, r);
    }

    function test_create_state() public view {
        assertEq(v.owner(), owner);
        assertEq(v.executor(), agent);
        assertEq(v.factory(), address(f));
        assertEq(address(v).balance, 1 ether);
        assertEq(f.totalDeposited(), 1 ether);
        assertEq(address(f).balance, 0);
        assertEq(f.kindOf(address(v)), f.KIND_EPOCH());
        assertEq(f.vaultsOf(owner)[0], address(v));
        assertEq(v.reserveFloor(), 0.4 ether);
        assertEq(v.remainingEpochAllowance(), 0.3 ether);
    }

    function test_naked_transfer_reverts() public {
        vm.deal(eve, 1 ether);
        vm.prank(eve);
        (bool ok,) = address(v).call{value: 1 ether}("");
        assertFalse(ok);
        assertEq(address(v).balance, 1 ether);
        assertEq(f.totalDeposited(), 1 ether);
    }

    function test_execute_within_epoch_and_reserve() public {
        vm.prank(agent);
        v.execute("r1", payable(bob), 0.2 ether);
        assertEq(bob.balance, 0.2 ether);
        assertEq(v.currentEpochSpent(), 0.2 ether);
        assertEq(address(v).balance, 0.8 ether);
        assertEq(f.totalDeposited(), 0.8 ether);
        vm.prank(agent);
        v.execute("r2", payable(bob), 0.1 ether);
        assertEq(v.remainingEpochAllowance(), 0);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(EpochAllowanceVault.EpochAllowanceExceeded.selector, 1, 0));
        v.execute("r3", payable(bob), 1);
    }

    function test_unspent_allowance_does_not_roll() public {
        vm.prank(agent);
        v.execute("r1", payable(bob), 0.01 ether);
        assertEq(v.epochSpent(), 0.01 ether);
        vm.warp(block.timestamp + 2 hours);
        assertEq(v.currentEpochSpent(), 0);
        assertEq(v.epochSpent(), 0.01 ether);
        assertEq(v.remainingEpochAllowance(), 0.3 ether);
        vm.prank(owner);
        v.setPerPaymentCap(0.3 ether);
        vm.prank(agent);
        v.execute("r2", payable(bob), 0.3 ether);
        assertEq(bob.balance, 0.31 ether);
        assertEq(v.currentEpochSpent(), 0.3 ether);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(EpochAllowanceVault.EpochAllowanceExceeded.selector, 1, 0));
        v.execute("r3", payable(bob), 1);
    }

    function test_reserve_blocks_agent_not_owner() public {
        vm.startPrank(agent);
        v.execute("a", payable(bob), 0.2 ether);
        v.execute("b", payable(bob), 0.1 ether);
        vm.stopPrank();
        assertEq(address(v).balance, 0.7 ether);
        vm.prank(owner);
        v.setEpochAllowance(1 ether);
        vm.warp(block.timestamp + 1 hours);
        vm.prank(agent);
        v.execute("c", payable(bob), 0.2 ether);
        assertEq(address(v).balance, 0.5 ether);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(EpochAllowanceVault.ReserveBreached.selector, 0.3 ether, 0.4 ether));
        v.execute("d", payable(bob), 0.2 ether);
        uint256 before = owner.balance;
        vm.prank(owner);
        v.withdraw(payable(owner), 0.5 ether);
        assertEq(address(v).balance, 0);
        assertEq(owner.balance, before + 0.5 ether);
    }

    function test_guards() public {
        vm.prank(eve);
        vm.expectRevert(EpochAllowanceVault.NotExecutor.selector);
        v.execute("r", payable(bob), 1);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(EpochAllowanceVault.RecipientNotAllowed.selector, eve));
        v.execute("r", payable(eve), 1);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(EpochAllowanceVault.PerPaymentCapExceeded.selector, 0.3 ether, 0.2 ether));
        v.execute("r", payable(bob), 0.3 ether);
        vm.prank(agent);
        vm.expectRevert(EpochAllowanceVault.ZeroAmount.selector);
        v.execute("r", payable(bob), 0);
        vm.prank(agent);
        v.execute("r", payable(bob), 0.1 ether);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(EpochAllowanceVault.RequestAlreadyExecuted.selector, bytes32("r")));
        v.execute("r", payable(bob), 0.1 ether);
        vm.prank(owner);
        v.setPaused(true);
        vm.prank(agent);
        vm.expectRevert(EpochAllowanceVault.Paused.selector);
        v.execute("p", payable(bob), 1);
        vm.prank(owner);
        v.withdraw(payable(owner), 0.1 ether);
    }

    function test_only_owner_config_and_factory_auth() public {
        vm.startPrank(agent);
        vm.expectRevert(EpochAllowanceVault.NotOwner.selector);
        v.withdraw(payable(agent), 1);
        vm.expectRevert(EpochAllowanceVault.NotOwner.selector);
        v.setEpochAllowance(1);
        vm.expectRevert(EpochAllowanceVault.NotOwner.selector);
        v.setReserveFloor(0);
        vm.stopPrank();
        vm.expectRevert(NovelVaultFactory.NotVault.selector);
        f.noteIn(1);
        vm.expectRevert(NovelVaultFactory.NotVault.selector);
        f.noteOut(1);
    }

    function test_failed_recipient_reverts_all() public {
        Rejector rj = new Rejector();
        vm.prank(owner);
        v.setRecipient(address(rj), true);
        vm.prank(agent);
        vm.expectRevert(EpochAllowanceVault.TransferFailed.selector);
        v.execute("x", payable(address(rj)), 0.1 ether);
        assertEq(v.currentEpochSpent(), 0);
        assertFalse(v.executed("x"));
        assertEq(f.totalDeposited(), 1 ether);
    }

    function test_reentrancy_blocked() public {
        ReenterEpoch re = new ReenterEpoch();
        re.set(v, "z");
        vm.startPrank(owner);
        v.setRecipient(address(re), true);
        v.setExecutor(address(re));
        vm.stopPrank();
        vm.prank(address(re));
        v.execute("z0", payable(address(re)), 0.01 ether);
        assertEq(v.currentEpochSpent(), 0.01 ether);
        assertEq(address(re).balance, 0.01 ether);
    }

    function test_short_epoch_and_cap_rejected() public {
        address[] memory r = new address[](0);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(EpochAllowanceVault.EpochTooShort.selector, 1 hours - 1, 1 hours));
        f.createEpochVault(agent, 1, 1, 1 hours - 1, 0, r);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(EpochAllowanceVault.ReserveAboveCap.selector, 3 ether, 2 ether));
        f.createEpochVault(agent, 1, 1, 1 hours, 3 ether, r);
    }

    function test_global_cap_shared_across_kinds() public {
        vm.startPrank(owner);
        f.createSessionVault{value: 2 ether}(1 ether, 0);
        f.createSessionVault{value: 2 ether}(1 ether, 0);
        vm.expectRevert(abi.encodeWithSelector(NovelVaultFactory.GlobalCapExceeded.selector, 5 ether + 1, 5 ether));
        f.createEpochVault{value: 1}(agent, 1, 1, 1 hours, 0, new address[](0));
        vm.stopPrank();
        assertEq(f.vaultCount(), 3);
    }

    function testFuzz_execute_bounds(uint256 amt) public {
        amt = bound(amt, 1, 1 ether);
        vm.prank(agent);
        if (amt > 0.2 ether) {
            vm.expectRevert(abi.encodeWithSelector(EpochAllowanceVault.PerPaymentCapExceeded.selector, amt, 0.2 ether));
            v.execute("f", payable(bob), amt);
        } else {
            v.execute("f", payable(bob), amt);
            assertEq(bob.balance, amt);
            assertGe(address(v).balance, v.reserveFloor());
        }
    }
}

contract SessionVaultTest is Test {
    NovelVaultFactory f;
    SessionVault v;
    address owner = address(0xA11CE);
    address agent = address(0xA6E7);
    address other = address(0x0E);
    address bob = address(0xB0B);
    address eve = address(0xE7E);

    function setUp() public {
        vm.warp(1_000_000);
        f = new NovelVaultFactory(2 ether, 5 ether);
        vm.deal(owner, 10 ether);
        vm.prank(owner);
        v = f.createSessionVault{value: 1 ether}(0.25 ether, 0.2 ether);
    }

    function _open(address key, address payee, uint256 allowance, uint64 span) internal returns (uint256 id) {
        address[] memory r = new address[](1);
        r[0] = payee;
        uint64 start = uint64(block.timestamp);
        vm.prank(owner);
        id = v.openSession(key, start, start + span, allowance, r);
    }

    function test_sessions_are_isolated() public {
        uint256 a = _open(agent, bob, 0.2 ether, 1 days);
        uint256 b = _open(other, eve, 0.2 ether, 1 days);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(SessionVault.RecipientNotAllowed.selector, eve));
        v.execute(a, "a1", payable(eve), 0.1 ether);
        vm.prank(other);
        vm.expectRevert(abi.encodeWithSelector(SessionVault.RecipientNotAllowed.selector, bob));
        v.execute(b, "b1", payable(bob), 0.1 ether);
        vm.prank(agent);
        v.execute(a, "a1", payable(bob), 0.2 ether);
        vm.prank(other);
        v.execute(b, "b1", payable(eve), 0.05 ether);
        (, , , , uint256 spentA,) = v.sessions(a);
        (, , , , uint256 spentB,) = v.sessions(b);
        assertEq(spentA, 0.2 ether);
        assertEq(spentB, 0.05 ether);
        assertEq(bob.balance, 0.2 ether);
        assertEq(eve.balance, 0.05 ether);
    }

    function test_key_cannot_widen_or_outlive_session() public {
        uint256 id = _open(agent, bob, 0.1 ether, 1 days);
        address[] memory r = new address[](1);
        r[0] = eve;
        vm.startPrank(agent);
        vm.expectRevert(SessionVault.NotOwner.selector);
        v.openSession(agent, uint64(block.timestamp), uint64(block.timestamp) + 1 days, 10 ether, r);
        vm.expectRevert(SessionVault.NotOwner.selector);
        v.revokeSession(id);
        vm.expectRevert(SessionVault.NotOwner.selector);
        v.withdraw(payable(agent), 1);
        v.execute(id, "p", payable(bob), 0.1 ether);
        vm.expectRevert(abi.encodeWithSelector(SessionVault.SessionAllowanceExceeded.selector, 1, 0));
        v.execute(id, "q", payable(bob), 1);
        vm.stopPrank();
        vm.warp(block.timestamp + 1 days);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(SessionVault.SessionExpired.selector, id, uint64(1_000_000 + 1 days)));
        v.execute(id, "late", payable(bob), 1);
    }

    function test_future_session_and_revoke() public {
        address[] memory r = new address[](1);
        r[0] = bob;
        uint64 start = uint64(block.timestamp + 1 hours);
        vm.prank(owner);
        uint256 id = v.openSession(agent, start, start + 1 hours, 0.1 ether, r);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(SessionVault.SessionNotStarted.selector, id, start));
        v.execute(id, "early", payable(bob), 1);
        vm.prank(owner);
        v.revokeSession(id);
        vm.warp(start);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(SessionVault.AlreadyRevoked.selector, id));
        v.execute(id, "early", payable(bob), 1);
    }

    function test_window_cap_and_replay_is_vault_global() public {
        address[] memory r = new address[](1);
        r[0] = bob;
        uint64 start = uint64(block.timestamp);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(SessionVault.WindowTooLong.selector, 30 days + 1, 30 days));
        v.openSession(agent, start, start + uint64(30 days) + 1, 1, r);
        uint256 a = _open(agent, bob, 1 ether, 1 days);
        uint256 b = _open(other, bob, 1 ether, 1 days);
        vm.prank(agent);
        v.execute(a, "same", payable(bob), 0.01 ether);
        vm.prank(other);
        vm.expectRevert(abi.encodeWithSelector(SessionVault.RequestAlreadyExecuted.selector, bytes32("same")));
        v.execute(b, "same", payable(bob), 0.01 ether);
    }

    function test_reserve_and_pause() public {
        uint256 id = _open(agent, bob, 1 ether, 1 days);
        vm.startPrank(agent);
        v.execute(id, "1", payable(bob), 0.25 ether);
        v.execute(id, "2", payable(bob), 0.25 ether);
        v.execute(id, "3", payable(bob), 0.25 ether);
        vm.expectRevert(abi.encodeWithSelector(SessionVault.ReserveBreached.selector, 0.19 ether, 0.2 ether));
        v.execute(id, "4", payable(bob), 0.06 ether);
        vm.stopPrank();
        assertEq(address(v).balance, 0.25 ether);
        vm.prank(owner);
        v.setPaused(true);
        vm.prank(agent);
        vm.expectRevert(SessionVault.Paused.selector);
        v.execute(id, "p", payable(bob), 1);
        vm.prank(owner);
        v.emergencyWithdrawAll();
        assertTrue(v.paused());
        assertEq(address(v).balance, 0);
        assertEq(f.totalDeposited(), 0);
    }

    function testFuzz_only_inside_window(uint256 delta) public {
        uint256 id = _open(agent, bob, 0.1 ether, 1 days);
        delta = bound(delta, 0, 2 days);
        vm.warp(1_000_000 + delta);
        vm.prank(agent);
        if (delta < 1 days) {
            v.execute(id, "f", payable(bob), 0.1 ether);
            assertEq(bob.balance, 0.1 ether);
        } else {
            vm.expectRevert(abi.encodeWithSelector(SessionVault.SessionExpired.selector, id, uint64(1_000_000 + 1 days)));
            v.execute(id, "f", payable(bob), 0.1 ether);
        }
    }
}

contract VetoVaultTest is Test {
    NovelVaultFactory f;
    VetoDelayVault v;
    address owner = address(0xA11CE);
    address agent = address(0xA6E7);
    address guard = address(0x6A2D);
    address bob = address(0xB0B);
    address eve = address(0xE7E);

    function setUp() public {
        f = new NovelVaultFactory(2 ether, 5 ether);
        address[] memory r = new address[](1);
        r[0] = bob;
        vm.deal(owner, 10 ether);
        vm.prank(owner);
        v = f.createVetoVault{value: 1 ether}(agent, guard, 15 minutes, 0.3 ether, 0.5 ether, 0.2 ether, r);
    }

    function test_release_waits_and_anyone_can_finalize() public {
        vm.prank(agent);
        v.propose("p", payable(bob), 0.2 ether);
        (, , uint64 readyAt,,,) = v.proposals("p");
        assertEq(readyAt, uint64(block.timestamp + 15 minutes));
        vm.prank(eve);
        vm.expectRevert(abi.encodeWithSelector(VetoDelayVault.TooEarly.selector, readyAt));
        v.release("p");
        vm.warp(readyAt - 1);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(VetoDelayVault.TooEarly.selector, readyAt));
        v.release("p");
        vm.warp(readyAt);
        vm.prank(eve);
        v.release("p");
        assertEq(bob.balance, 0.2 ether);
        assertEq(v.totalSpent(), 0.2 ether);
        assertEq(v.remainingBudget(), 0.3 ether);
        assertEq(f.totalDeposited(), 0.8 ether);
    }

    function test_guardian_can_cancel_but_cannot_take_funds() public {
        vm.prank(agent);
        v.propose("p", payable(bob), 0.2 ether);
        vm.prank(agent);
        vm.expectRevert(VetoDelayVault.NotGuardian.selector);
        v.cancel("p");
        vm.prank(guard);
        v.cancel("p");
        vm.warp(block.timestamp + 15 minutes);
        vm.prank(eve);
        vm.expectRevert(abi.encodeWithSelector(VetoDelayVault.ProposalCancelled.selector, bytes32("p")));
        v.release("p");
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(VetoDelayVault.RequestAlreadyUsed.selector, bytes32("p")));
        v.propose("p", payable(bob), 0.1 ether);
        vm.startPrank(guard);
        vm.expectRevert(VetoDelayVault.NotOwner.selector);
        v.withdraw(payable(guard), 1);
        vm.expectRevert(VetoDelayVault.NotOwner.selector);
        v.setRecipient(guard, true);
        vm.expectRevert(VetoDelayVault.NotOwner.selector);
        v.setBudget(100 ether);
        vm.expectRevert(VetoDelayVault.NotOwner.selector);
        v.setExecutor(guard);
        vm.stopPrank();
        assertEq(address(v).balance, 1 ether);
    }

    function test_owner_cancel_after_ready_and_pause_blocks_release() public {
        vm.prank(agent);
        v.propose("p", payable(bob), 0.1 ether);
        (, , uint64 readyAt,,,) = v.proposals("p");
        vm.warp(readyAt);
        vm.prank(owner);
        v.cancel("p");
        vm.expectRevert(abi.encodeWithSelector(VetoDelayVault.ProposalCancelled.selector, bytes32("p")));
        v.release("p");
        vm.prank(agent);
        v.propose("q", payable(bob), 0.1 ether);
        vm.prank(owner);
        v.setPaused(true);
        (, , uint64 readyQ,,,) = v.proposals("q");
        vm.warp(readyQ);
        vm.expectRevert(VetoDelayVault.Paused.selector);
        v.release("q");
        vm.prank(guard);
        v.cancel("q");
    }

    function test_release_rechecks_budget_recipient_and_reserve() public {
        vm.prank(agent);
        v.propose("a", payable(bob), 0.3 ether);
        vm.prank(agent);
        v.propose("b", payable(bob), 0.3 ether);
        (, , uint64 readyA,,,) = v.proposals("a");
        vm.warp(readyA);
        v.release("a");
        vm.expectRevert(abi.encodeWithSelector(VetoDelayVault.BudgetExceeded.selector, 0.3 ether, 0.2 ether));
        v.release("b");
        vm.prank(agent);
        v.propose("c", payable(bob), 0.1 ether);
        vm.prank(owner);
        v.setRecipient(bob, false);
        vm.warp(block.timestamp + 15 minutes);
        vm.expectRevert(abi.encodeWithSelector(VetoDelayVault.RecipientNotAllowed.selector, bob));
        v.release("c");
    }

    function test_delay_is_immutable_minimum() public {
        address[] memory r = new address[](0);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(VetoDelayVault.DelayTooShort.selector, 15 minutes - 1, 15 minutes));
        f.createVetoVault(agent, guard, 15 minutes - 1, 1, 1, 0, r);
        vm.prank(owner);
        vm.expectRevert(VetoDelayVault.GuardianIsExecutor.selector);
        f.createVetoVault(agent, agent, 15 minutes, 1, 1, 0, r);
        assertEq(v.delay(), 15 minutes);
    }

    function test_reentrancy_on_release_pays_once() public {
        ReenterRelease re = new ReenterRelease();
        vm.prank(owner);
        v.setRecipient(address(re), true);
        vm.prank(agent);
        v.propose("z", payable(address(re)), 0.1 ether);
        re.set(v, "z");
        vm.warp(block.timestamp + 15 minutes);
        v.release("z");
        assertEq(address(re).balance, 0.1 ether);
        assertEq(v.totalSpent(), 0.1 ether);
    }

    function test_failed_release_keeps_proposal() public {
        Rejector rj = new Rejector();
        vm.prank(owner);
        v.setRecipient(address(rj), true);
        vm.prank(agent);
        v.propose("x", payable(address(rj)), 0.1 ether);
        vm.warp(block.timestamp + 15 minutes);
        vm.expectRevert(VetoDelayVault.TransferFailed.selector);
        v.release("x");
        assertEq(v.totalSpent(), 0);
        (,,, bool exists, bool cancelled, bool released) = v.proposals("x");
        assertTrue(exists);
        assertFalse(cancelled);
        assertFalse(released);
        assertEq(f.totalDeposited(), 1 ether);
    }

    function testFuzz_release_only_after_delay(uint256 delta) public {
        vm.prank(agent);
        v.propose("f", payable(bob), 0.1 ether);
        (, , uint64 readyAt,,,) = v.proposals("f");
        delta = bound(delta, 0, 1 hours);
        vm.warp(block.timestamp + delta);
        if (block.timestamp < readyAt) {
            vm.expectRevert(abi.encodeWithSelector(VetoDelayVault.TooEarly.selector, readyAt));
            v.release("f");
        } else {
            v.release("f");
            assertEq(bob.balance, 0.1 ether);
        }
    }
}

contract EpochHandler is Test {
    EpochAllowanceVault public v;
    address public owner;
    address public agent;
    address public bob;
    uint256 public deposited;
    uint256 public withdrawn;
    uint256 public paid;
    uint256 public n;
    bool public stole;
    bool public agentBreached;

    constructor(EpochAllowanceVault v_, address o, address a, address b, uint256 init) {
        v = v_;
        owner = o;
        agent = a;
        bob = b;
        deposited = init;
    }

    function deposit(uint256 x) external {
        x = bound(x, 1, 0.5 ether);
        if (address(v).balance + x > v.vaultCap()) return;
        vm.deal(owner, x);
        vm.prank(owner);
        v.deposit{value: x}();
        deposited += x;
    }

    function withdraw(uint256 x) external {
        if (address(v).balance == 0) return;
        x = bound(x, 1, address(v).balance);
        vm.prank(owner);
        v.withdraw(payable(owner), x);
        withdrawn += x;
    }

    function pay(uint256 x) external {
        x = bound(x, 1, 0.4 ether);
        vm.prank(agent);
        try v.execute(bytes32(++n), payable(bob), x) {
            paid += x;
            if (address(v).balance < v.reserveFloor()) agentBreached = true;
        } catch {}
    }

    function warpEpochs(uint256 k) external {
        k = bound(k, 1, 4);
        vm.warp(block.timestamp + k * v.epochLength());
    }

    function attackerWithdraw(address who, uint256 x) external {
        if (who == owner) return;
        vm.prank(who);
        try v.withdraw(payable(who), x) {
            stole = true;
        } catch {}
    }

    function togglePause(bool p) external {
        vm.prank(owner);
        v.setPaused(p);
    }
}

contract EpochAllowanceInvariant is Test {
    NovelVaultFactory f;
    EpochAllowanceVault v;
    EpochHandler h;
    address owner = address(0xA11CE);
    address agent = address(0xA6E7);
    address bob = address(0xB0B);

    function setUp() public {
        f = new NovelVaultFactory(2 ether, 20 ether);
        address[] memory r = new address[](1);
        r[0] = bob;
        vm.deal(owner, 2 ether);
        vm.prank(owner);
        v = f.createEpochVault{value: 1 ether}(agent, 0.2 ether, 0.5 ether, 1 hours, 0.25 ether, r);
        h = new EpochHandler(v, owner, agent, bob, 1 ether);
        targetContract(address(h));
    }

    function invariant_conservation() public view {
        assertEq(h.deposited(), address(v).balance + h.paid() + h.withdrawn());
    }

    function invariant_factory_accounting() public view {
        assertEq(f.totalDeposited(), address(v).balance);
    }

    function invariant_epoch_and_reserve() public view {
        assertLe(address(v).balance, v.vaultCap());
        assertLe(v.currentEpochSpent(), v.epochAllowance());
        assertEq(bob.balance, h.paid());
        assertFalse(h.agentBreached());
        assertFalse(h.stole());
    }
}
