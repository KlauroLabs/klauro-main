package app

class KeepBook(private val dao: ShelfDao) : Interactor<Long>() {
    override suspend fun doWork(params: Long) {
        dao.keep(params)
    }
}
