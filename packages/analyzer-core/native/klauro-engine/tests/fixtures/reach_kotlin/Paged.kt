package app

class Feed {
  fun load() = Unit
}

class FeedScreen(private val feed: Lazy<Feed>) {
  fun present() {
    val kept = remember { feed.value }
    kept.load()
  }
}
