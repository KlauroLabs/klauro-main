contract Vault is Base { uint public total; function send(address dest) public returns (bool) { return pay(dest); } }
