plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.maranics.flowvoice"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.maranics.flowvoice"
        minSdk = 26
        targetSdk = 34
        versionCode = 5
        versionName = "0.2.0"
    }

    signingConfigs {
        // A checked-in debug keystore so every machine produces an installable APK with the same signature.
        getByName("debug") {
            storeFile = file("debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
    }

    buildTypes {
        getByName("debug") {
            signingConfig = signingConfigs.getByName("debug")
        }
        getByName("release") {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // release builds are signed with the debug keystore until a Maranics release key is provided
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        buildConfig = true
    }
    packaging {
        resources.excludes += setOf("META-INF/AL2.0", "META-INF/LGPL2.1")
    }
    // the English Vosk model ships in the APK (~40 MB); other languages download on demand (VoskStt.kt)
    sourceSets.getByName("main").assets.srcDir(layout.buildDirectory.dir("vosk-assets"))
}

/** Fetch the bundled offline model once (kept out of git; see .gitignore). */
val fetchVoskModel by tasks.registering {
    val out = layout.buildDirectory.file("vosk-assets/vosk/en.zip")
    outputs.file(out)
    doLast {
        val f = out.get().asFile
        if (!f.exists() || f.length() < 1_000_000) {
            f.parentFile.mkdirs()
            val url = "https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip"
            logger.lifecycle("downloading $url")
            ant.invokeMethod("get", mapOf("src" to url, "dest" to f.absolutePath))
        }
    }
}
tasks.named("preBuild") { dependsOn(fetchVoskModel) }

dependencies {
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.webkit:webkit:1.11.0")
    implementation("androidx.activity:activity-ktx:1.9.1")
    // QR scanner for the hub address (offline; no Play Services needed on vessel devices)
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    // grammar-restricted offline recognition (Apache-2.0); the models are fetched at build / run time
    implementation("com.alphacephei:vosk-android:0.3.47")
    implementation("net.java.dev.jna:jna:5.13.0@aar")
}
