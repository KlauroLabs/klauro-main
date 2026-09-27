package app

interface Preference<T> {
  suspend fun set(value: T)
  suspend fun get(): T
}

suspend fun Preference<Boolean>.toggle() = set(!get())

interface TiviPreferences {
  val useDynamicColors: Preference<Boolean>
}

class SettingsScreen(
  preferences: Lazy<TiviPreferences>,
) {
  private val preferences by preferences

  fun present() {
    val sink: (String) -> Unit = { event ->
      launchOrThrow { preferences.useDynamicColors.toggle() }
    }
  }
}
