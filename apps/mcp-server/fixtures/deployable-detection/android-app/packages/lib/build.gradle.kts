plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.fixture.lib"
    compileSdk = 34

    defaultConfig {
        minSdk = 24
        targetSdk = 34
    }
}
