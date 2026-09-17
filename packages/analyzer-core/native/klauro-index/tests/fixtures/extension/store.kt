package app.demo

class ShowStore(
  private val showDao: ShowDao,
) {
  fun load(id: Long): String = showDao.orPlaceholder(id)
}
