package shop

class PriceCalculator {
    fun total(items: List<Int>): Int = items.sum().let { applyTax(it) }
    private fun applyTax(n: Int): Int = n + n / 10
}

class Cart(private val calc: PriceCalculator) {
    fun checkout(items: List<Int>): Int {
        val sum = calc.total(items)
        return finalize(sum)
    }

    private fun finalize(n: Int): Int = n
}

fun main() {
    val cart = Cart(PriceCalculator())
    cart.checkout(listOf(1, 2, 3))
}
