package shows

class ShowsRepository {
    fun trending(): List<String> = cached()

    fun followShow(id: String): Boolean = id.isNotEmpty()

    private fun cached(): List<String> = listOf("a", "b")
}

internal fun hiddenHelper(): Int = 1
