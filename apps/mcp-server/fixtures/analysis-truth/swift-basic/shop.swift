protocol Payable { func pay() }
class Order: Payable {
    func pay() { notify() }
    func notify() { send() }
    func send() {}
}
struct Customer {
    func name() -> String { return "x" }
}
