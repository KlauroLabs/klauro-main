package com.fixture.app

import android.app.Activity
import android.os.Bundle
import com.fixture.lib.Greeter

class MainActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Greeter().greet()
    }
}
