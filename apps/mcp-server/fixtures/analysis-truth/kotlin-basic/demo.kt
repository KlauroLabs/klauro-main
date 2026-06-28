package demo
interface Repo { fun find(): String }
class UserService {
    fun load() { fetch() }
    private fun fetch() {}
}
data class User(val id: Int)
fun main() { }
