package app.demo

interface Runner {
  fun start(): Int
}

abstract class BaseJob : Runner {
  override fun start(): Int = 1
}

class Job : BaseJob()

class Screen(
  private val job: Lazy<Job>,
) {
  fun open(): Int = job.value.start()
}
