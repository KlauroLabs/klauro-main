package fixture

import java.io.File

class Session {
    val identifier: String = ""
    var started: Long = 0

    fun close(force: Boolean): Boolean {
        if (force) {
            return false
        }
        return persist(identifier)
    }

    fun persist(id: String): Boolean {
        return File(id).exists()
    }
}
