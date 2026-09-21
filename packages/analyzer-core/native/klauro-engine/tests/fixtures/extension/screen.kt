package app.demo

import androidx.compose.runtime.collectAsState

fun render(state: ScreenState): Int = state.collectAsState()
