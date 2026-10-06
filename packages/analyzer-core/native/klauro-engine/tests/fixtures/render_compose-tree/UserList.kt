package com.example.app

import androidx.compose.runtime.Composable
import androidx.compose.material3.Text

@Composable
fun UserList(users: List<User>) {
    for (u in users) {
        UserCard(user = u)
    }
}

@Composable
fun UserCard(user: User) {
    Text(text = user.name)
}
