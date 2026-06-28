// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;
import "./Account.sol";
contract Service {
    function persist(Account a) public {
        a.save();
    }
}
