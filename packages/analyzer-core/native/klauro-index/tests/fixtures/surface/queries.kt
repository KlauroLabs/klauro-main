package app.demo

class ShowRepository(
  private val db: Database,
) {
  fun page(): List<String> = db.showQueries.entriesInPage(1)
}
