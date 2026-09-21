package app.demo.ui

import app.demo.text.slugify

fun page(title: Any): String = title.slugify()
