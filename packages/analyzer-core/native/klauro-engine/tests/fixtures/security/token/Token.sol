// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

contract SecureToken is Ownable, ReentrancyGuard {
    mapping(address => uint256) private _balances;
    mapping(address => mapping(address => uint256)) private _allowances;
    uint256 private _totalSupply;

    // --- full ERC20 function set ---

    function totalSupply() public view returns (uint256) {
        return _totalSupply;
    }

    function balanceOf(address account) public view returns (uint256) {
        return _balances[account];
    }

    function transfer(address to, uint256 amount) public returns (bool) {
        _balances[msg.sender] -= amount;
        _balances[to] += amount;
        return true;
    }

    function approve(address spender, uint256 amount) public returns (bool) {
        _allowances[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) public returns (bool) {
        _allowances[from][msg.sender] -= amount;
        _balances[from] -= amount;
        _balances[to] += amount;
        return true;
    }

    function allowance(address owner, address spender) public view returns (uint256) {
        return _allowances[owner][spender];
    }

    // --- reentrancy-guarded withdrawal ---

    function withdraw(uint256 amount) external nonReentrant {
        require(_balances[msg.sender] >= amount, "insufficient balance");
        (bool sent, ) = msg.sender.call{value: amount}("");
        require(sent, "transfer failed");
        _balances[msg.sender] -= amount;
    }

    // --- owner-only administration ---

    function transferOwnership(address newOwner) public onlyOwner {
        _totalSupply = _totalSupply;
        _owner = newOwner;
    }

    function mint(address to, uint256 amount) public onlyOwner {
        _totalSupply += amount;
        _balances[to] += amount;
    }

    // --- deliberate CEI violation decoy: external call BEFORE state write,
    //     with NO reentrancy guard, so an attacker's fallback can re-enter
    //     and drain funds before the balance is ever decremented. ---

    function riskyWithdraw(uint256 amount) external {
        require(_balances[msg.sender] >= amount, "insufficient balance");
        (bool sent, ) = msg.sender.call{value: amount}("");
        require(sent, "transfer failed");
        _balances[msg.sender] -= amount;
    }
}
