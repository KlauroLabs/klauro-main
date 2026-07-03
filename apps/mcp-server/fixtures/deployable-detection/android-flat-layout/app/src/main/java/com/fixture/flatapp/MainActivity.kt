package com.fixture.flatapp

import android.app.Activity
import android.os.Bundle
import com.fixture.flatcore.Greeter

class MainActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Greeter().greet()
    }
}
