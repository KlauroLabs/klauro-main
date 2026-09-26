package app

abstract class Interactor<P> {
    suspend operator fun invoke(params: P) {
        withTimeout(1000) {
            doWork(params)
        }
    }

    protected abstract suspend fun doWork(params: P)
}
