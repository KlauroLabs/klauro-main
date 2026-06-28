// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;
import "./Account.sol";
contract Archiver {
    function archive(Account a) public {
        a.save();
    }
}
