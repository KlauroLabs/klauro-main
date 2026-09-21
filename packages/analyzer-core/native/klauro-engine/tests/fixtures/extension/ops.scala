package app.demo.ops

object Conversions {
  implicit class TextOps(private val source: String) {
    def slugified: String = source.trim.toLowerCase
  }
}

extension (value: Int)
  def doubled: Int = value * 2
