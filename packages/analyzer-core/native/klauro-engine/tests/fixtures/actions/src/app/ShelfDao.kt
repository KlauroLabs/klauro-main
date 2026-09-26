package app

interface ShelfDao {
    fun keep(bookId: Long)
}

class SqlShelfDao(private val db: Database) : ShelfDao {
    override fun keep(bookId: Long) {
        db.shelfQueries.insert(bookId)
    }
}
