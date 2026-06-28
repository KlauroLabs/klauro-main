// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;
import "./Logger.sol";
contract LogUser {
    function logIt(Logger l) public {
        l.save();
    }
}
