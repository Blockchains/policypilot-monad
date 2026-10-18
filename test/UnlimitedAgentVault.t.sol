// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";
import {UnlimitedAgentVault, UnlimitedAgentVaultFactory} from "../src/UnlimitedAgentVault.sol";
import {AgentVault, CallRuleInit, TokenCapInit} from "../src/AgentVault.sol";
import {AgentVaultFactory} from "../src/AgentVaultFactory.sol";
import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

contract UWMON is ERC20 {
    constructor() ERC20("WMON", "WMON") {}
    function deposit() external payable { _mint(msg.sender, msg.value); }
    function withdraw(uint256 a) external { _burn(msg.sender, a); payable(msg.sender).transfer(a); } // 2300-gas transfer
}
contract UToken is ERC20 { constructor() ERC20("USD", "USD") {} function mint(address t, uint256 a) external { _mint(t, a); } }
contract USpender { function pull(IERC20 t, address from, uint256 a) external { t.transferFrom(from, address(this), a); } }
contract UReenter {
    UnlimitedAgentVault public v;
    function set(UnlimitedAgentVault v_) external { v = v_; }
    receive() external payable { try v.execute(keccak256(abi.encode(gasleft())), payable(address(this)), 1) {} catch {} }
}

contract UnlimitedAgentVaultTest is Test {
    UnlimitedAgentVaultFactory f; UnlimitedAgentVault v; UWMON w; UToken usd;
    address owner = address(0xA11CE); address agent = address(0xA6E7); address eve = address(0xE7E); address stranger = address(0x5157);
    UnlimitedAgentVault.CallOpts none;

    function setUp() public {
        f = new UnlimitedAgentVaultFactory(); w = new UWMON(); usd = new UToken();
        vm.deal(owner, 5000 ether);
        vm.prank(owner);
        v = f.createVault{value: 2 ether}(agent);
    }

    function test_create_state_and_unlimited_views() public view {
        assertEq(v.owner(), owner); assertEq(v.executor(), agent); assertEq(v.factory(), address(f));
        assertEq(address(v).balance, 2 ether); assertTrue(v.unlimited()); assertTrue(f.unlimited());
        assertEq(v.perPaymentCap(), type(uint256).max); assertEq(v.budget(), type(uint256).max); assertEq(v.vaultCap(), type(uint256).max);
        assertEq(v.remainingBudget(), type(uint256).max); assertEq(v.tokenCap(address(usd)), type(uint256).max);
        assertTrue(v.allowedRecipient(stranger));
        (bool ok, uint8 word) = v.callRule(address(w), UWMON.deposit.selector); assertTrue(ok); assertEq(word, 255);
        assertEq(f.vaultsOf(owner)[0], address(v)); assertTrue(f.isVault(address(v))); assertEq(f.vaultCount(), 1);
    }

    function test_no_vault_cap_any_deposit_amount() public {
        vm.startPrank(owner);
        v.deposit{value: 1500 ether}(); // above the old 1000 MON vault cap
        UnlimitedAgentVault v2 = f.createVault{value: 0.0123 ether}(agent); // any starter amount
        UnlimitedAgentVault v3 = f.createVault(agent); // or none
        vm.stopPrank();
        assertEq(address(v).balance, 1502 ether); assertEq(address(v2).balance, 0.0123 ether); assertEq(address(v3).balance, 0);
    }

    function test_agent_pays_anyone_any_amount_whole_balance() public {
        vm.prank(owner); v.deposit{value: 1200 ether}();
        vm.prank(agent); v.execute("big", payable(stranger), 1100 ether); // > old 1000 MON cap, stranger not allowlisted
        assertEq(stranger.balance, 1100 ether);
        vm.prank(agent); v.execute("rest", payable(eve), address(v).balance); // drains the rest
        assertEq(address(v).balance, 0); assertEq(v.totalSpent(), 1202 ether);
    }

    function test_agent_calls_any_contract_including_token_transfer() public {
        vm.startPrank(agent);
        v.executeCall("wrap", address(w), 1 ether, abi.encodeCall(UWMON.deposit, ()), UnlimitedAgentVault.CallOpts(address(0), 0, address(w), 1 ether));
        assertEq(w.balanceOf(address(v)), 1 ether);
        v.executeCall("unwrap", address(w), 0, abi.encodeCall(UWMON.withdraw, (0.4 ether)), none); // 2300-gas transfer back in
        v.executeCall("xfer", address(w), 0, abi.encodeCall(IERC20.transfer, (stranger, 0.6 ether)), none); // was ForbiddenSelector
        vm.stopPrank();
        assertEq(w.balanceOf(stranger), 0.6 ether); assertEq(address(v).balance, 1.4 ether);
    }

    function test_unlimited_exact_approval_reset() public {
        usd.mint(address(v), 1e30); USpender s = new USpender();
        vm.prank(agent);
        v.executeCall("ap", address(s), 0, abi.encodeCall(USpender.pull, (IERC20(address(usd)), address(v), 1e30)), UnlimitedAgentVault.CallOpts(address(usd), 1e30, address(0), 0));
        assertEq(usd.balanceOf(address(s)), 1e30); assertEq(usd.allowance(address(v), address(s)), 0);
    }

    function test_min_out_is_optional_agent_guard() public {
        vm.prank(agent); vm.expectRevert(abi.encodeWithSelector(UnlimitedAgentVault.MinOutNotMet.selector, 1 ether, 2 ether));
        v.executeCall("w", address(w), 1 ether, abi.encodeCall(UWMON.deposit, ()), UnlimitedAgentVault.CallOpts(address(0), 0, address(w), 2 ether));
    }

    function test_owner_controls_kept() public {
        vm.startPrank(eve);
        vm.expectRevert(UnlimitedAgentVault.NotExecutor.selector); v.execute("r", payable(eve), 1);
        vm.expectRevert(UnlimitedAgentVault.NotOwner.selector); v.withdraw(payable(eve), 1);
        vm.expectRevert(UnlimitedAgentVault.NotOwner.selector); v.emergencyWithdrawAll();
        vm.expectRevert(UnlimitedAgentVault.NotOwner.selector); v.setExecutor(eve);
        vm.expectRevert(UnlimitedAgentVault.NotOwner.selector); v.setPaused(true);
        vm.expectRevert(UnlimitedAgentVault.NotOwner.selector); v.withdrawToken(address(usd), eve, 0);
        vm.deal(eve, 1 ether); vm.expectRevert(UnlimitedAgentVault.NotOwner.selector); v.deposit{value: 1}();
        vm.stopPrank();
        vm.prank(owner); v.setPaused(true);
        vm.prank(agent); vm.expectRevert(UnlimitedAgentVault.Paused.selector); v.execute("r", payable(eve), 1);
        vm.prank(agent); vm.expectRevert(UnlimitedAgentVault.Paused.selector); v.executeCall("r", address(w), 0, "", none);
        vm.prank(owner); v.emergencyWithdrawAll();
        assertEq(address(v).balance, 0); assertEq(owner.balance, 4998 ether + 2 ether);
        vm.prank(owner); v.setExecutor(eve); assertEq(v.executor(), eve);
    }

    function test_replay_and_balance_guards() public {
        vm.startPrank(agent);
        v.execute("r", payable(eve), 1);
        vm.expectRevert(abi.encodeWithSelector(UnlimitedAgentVault.RequestAlreadyExecuted.selector, bytes32("r"))); v.execute("r", payable(eve), 1);
        vm.expectRevert(abi.encodeWithSelector(UnlimitedAgentVault.InsufficientBalance.selector, 3 ether, 2 ether - 1)); v.execute("x", payable(eve), 3 ether);
        vm.expectRevert(UnlimitedAgentVault.ZeroAmount.selector); v.execute("z", payable(eve), 0);
        vm.stopPrank();
    }

    function test_reentrancy_blocked() public {
        UReenter re = new UReenter(); re.set(v);
        vm.prank(owner); v.setExecutor(address(re));
        vm.prank(address(re)); v.execute("r", payable(address(re)), 1 ether);
        assertEq(address(re).balance, 1 ether); assertEq(v.totalSpent(), 1 ether);
    }

    /// The "Remove limits" owner action for v1-v3 AgentVaults: caps and budget to max, token caps to max.
    /// The immutable vaultCap and the recipient / call allowlists stay (no switch exists in that bytecode).
    function test_legacy_owner_remove_limits() public {
        AgentVaultFactory lf = new AgentVaultFactory(1000 ether, 100_000 ether);
        address[] memory r = new address[](1); r[0] = owner;
        vm.startPrank(owner);
        AgentVault lv = lf.createVault{value: 900 ether}(agent, 0.1 ether, 0.3 ether, r, new CallRuleInit[](0), new TokenCapInit[](0));
        lv.setPerPaymentCap(type(uint256).max); lv.setBudget(type(uint256).max); lv.setTokenCap(address(usd), type(uint256).max);
        vm.stopPrank();
        vm.prank(agent); lv.execute("big", payable(owner), 800 ether);
        assertEq(lv.remainingBudget(), type(uint256).max - 800 ether);
        vm.prank(agent); vm.expectRevert(abi.encodeWithSelector(AgentVault.RecipientNotAllowed.selector, stranger)); lv.execute("s", payable(stranger), 1);
    }
}
