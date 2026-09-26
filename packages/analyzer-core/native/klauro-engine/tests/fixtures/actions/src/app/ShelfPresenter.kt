package app

sealed interface ShelfUiEvent {
    data class Keep(val bookId: Long) : ShelfUiEvent
    data object Close : ShelfUiEvent
}

class ShelfPresenter(keepBook: Lazy<KeepBook>, private val navigator: Navigator) {
    private val keepBook by keepBook

    fun present() {
        val eventSink: (ShelfUiEvent) -> Unit = { event ->
            when (event) {
                is ShelfUiEvent.Keep -> {
                    launch {
                        keepBook(event.bookId)
                    }
                }
                ShelfUiEvent.Close -> navigator.pop()
            }
        }
    }
}
