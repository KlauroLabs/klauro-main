package com.example.app

import androidx.compose.runtime.Composable
import androidx.compose.material3.Text

data class User(val name: String)

// Decoy: an ordinary (non-@Composable) function. Its call to Header() must NOT
// produce a renders edge, and it must NOT become a component node.
fun formatTitle(raw: String): String {
    return raw.trim()
}

@Composable
fun App() {
    val users = listOf(User("Ada"), User("Alan"))
    Header(title = formatTitle("Hi"))
    UserList(users = users)
    Footer()
}

@Composable
fun Header(title: String) {
    // Non-composable Capitalized call: Text is a Compose built-in, NOT declared
    // in these sources, so it must NOT yield a renders edge (precision proof).
    Text(text = title)
}

@Composable
fun Footer() {
    Text(text = "© 2026")
}
