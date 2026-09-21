package app.demo

interface ShowDao {
  fun byId(id: Long): String
}

fun ShowDao.orPlaceholder(id: Long): String = byId(id)
