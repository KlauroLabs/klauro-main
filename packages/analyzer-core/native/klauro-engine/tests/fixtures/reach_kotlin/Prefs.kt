package app

import com.russhwolf.settings.ObservableSettings
import com.russhwolf.settings.set

class Prefs(private val settings: ObservableSettings) {
  private inner class BooleanPreference(private val key: String) {
    suspend fun set(value: Boolean) = withContext(io) {
      settings[key] = value
    }

    suspend fun get(): Boolean = withContext(io) {
      settings.getBoolean(key, false)
    }
  }
}
