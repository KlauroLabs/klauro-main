plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.fixture.flatapp"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.fixture.flatapp"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
    }
}

dependencies {
    implementation(project(":core"))
}
