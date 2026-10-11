package com.maranics.flowvoice

import android.Manifest
import android.app.ActivityManager
import android.app.admin.DevicePolicyManager
import android.bluetooth.BluetoothManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.hardware.input.InputManager
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import android.os.BatteryManager
import android.os.Build
import android.os.Environment
import android.os.PowerManager
import android.os.StatFs
import android.os.SystemClock
import android.provider.Settings
import android.speech.RecognitionService
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.util.DisplayMetrics
import android.view.InputDevice
import android.webkit.WebView
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.Locale
import java.util.TimeZone

/**
 * Everything technical about this device that helps support a station from the office: make / model / Android
 * version, screen, memory, storage, battery, network, Bluetooth, audio routes, speech recognisers and voices,
 * WebView, permissions, kiosk state, input devices. Grouped by topic; every topic is best effort (a missing
 * API or a denied permission leaves a hole, never a crash).
 *
 * Sent to the hub in `hello.capabilities.device` (web/src/audio.ts → `Bridge.deviceInfo()`), shown in
 * Admin → Stations, and in the app's long-press menu "Device info…". Deliberately **no identifiers**: no
 * serial, IMEI, Android id, MAC, Wi-Fi name, account or phone number — the office needs to know *what kind*
 * of device this is, not *which one*.
 */
class DeviceInfo(private val ctx: Context) {

    fun collect(extra: JSONObject.() -> Unit = {}): JSONObject {
        val o = JSONObject()
        topic(o, "app") { app(it) }
        topic(o, "device") { device(it) }
        topic(o, "os") { os(it) }
        topic(o, "screen") { screen(it) }
        topic(o, "memory") { memory(it) }
        topic(o, "storage") { storage(it) }
        topic(o, "cpu") { cpu(it) }
        topic(o, "battery") { battery(it) }
        topic(o, "network") { network(it) }
        topic(o, "bluetooth") { bluetooth(it) }
        topic(o, "audio") { audio(it) }
        topic(o, "speech") { speech(it) }
        topic(o, "webview") { webview(it) }
        topic(o, "permissions") { permissions(it) }
        topic(o, "management") { management(it) }
        topic(o, "input") { input(it) }
        topic(o, "features") { features(it) }
        runCatching { o.extra() }
        return o
    }

    private fun topic(root: JSONObject, name: String, fill: (JSONObject) -> Unit) {
        val t = JSONObject()
        runCatching { fill(t) }.onFailure { t.put("error", it.toString().take(200)) }
        root.put(name, t)
    }

    private fun app(t: JSONObject) {
        val pm = ctx.packageManager
        val pi = pm.getPackageInfo(ctx.packageName, 0)
        t.put("package", ctx.packageName)
        t.put("version", BuildConfig.VERSION_NAME)
        t.put("versionCode", BuildConfig.VERSION_CODE)
        t.put("buildType", BuildConfig.BUILD_TYPE)
        t.put("debug", BuildConfig.DEBUG)
        t.put("targetSdk", ctx.applicationInfo.targetSdkVersion)
        t.put("minSdk", ctx.applicationInfo.minSdkVersion)
        t.put("firstInstall", iso(pi.firstInstallTime))
        t.put("lastUpdate", iso(pi.lastUpdateTime))
        val installer = runCatching {
            if (Build.VERSION.SDK_INT >= 30) pm.getInstallSourceInfo(ctx.packageName).installingPackageName
            else @Suppress("DEPRECATION") pm.getInstallerPackageName(ctx.packageName)
        }.getOrNull()
        t.put("installer", installer ?: "sideloaded")
        t.put("processUptimeMs", SystemClock.elapsedRealtime() - android.os.Process.getStartElapsedRealtime())
    }

    private fun device(t: JSONObject) {
        t.put("manufacturer", Build.MANUFACTURER)
        t.put("brand", Build.BRAND)
        t.put("model", Build.MODEL)
        t.put("device", Build.DEVICE)
        t.put("product", Build.PRODUCT)
        t.put("board", Build.BOARD)
        t.put("hardware", Build.HARDWARE)
        t.put("bootloader", Build.BOOTLOADER)
        t.put("display", Build.DISPLAY)
        t.put("buildId", Build.ID)
        t.put("buildType", Build.TYPE)
        t.put("buildTags", Build.TAGS)
        t.put("fingerprint", Build.FINGERPRINT)
        t.put("abis", JSONArray(Build.SUPPORTED_ABIS.toList()))
        if (Build.VERSION.SDK_INT >= 31) {
            t.put("socManufacturer", Build.SOC_MANUFACTURER)
            t.put("socModel", Build.SOC_MODEL)
        }
        val emulator = Build.FINGERPRINT.contains("generic") || Build.MODEL.contains("Emulator") || Build.MODEL.contains("Android SDK") || Build.HARDWARE.contains("goldfish") || Build.HARDWARE.contains("ranchu")
        t.put("emulator", emulator)
    }

    private fun os(t: JSONObject) {
        t.put("name", "Android")
        t.put("version", Build.VERSION.RELEASE)
        t.put("sdk", Build.VERSION.SDK_INT)
        t.put("securityPatch", Build.VERSION.SECURITY_PATCH)
        t.put("incremental", Build.VERSION.INCREMENTAL)
        t.put("codename", Build.VERSION.CODENAME)
        t.put("baseOs", Build.VERSION.BASE_OS)
        t.put("previewSdk", Build.VERSION.PREVIEW_SDK_INT)
        t.put("buildTime", iso(Build.TIME))
        t.put("kernel", System.getProperty("os.version") ?: "")
        t.put("uptimeMs", SystemClock.elapsedRealtime())
        t.put("bootedAt", iso(System.currentTimeMillis() - SystemClock.elapsedRealtime()))
        t.put("locale", Locale.getDefault().toLanguageTag())
        val locales = ctx.resources.configuration.locales
        t.put("locales", JSONArray((0 until locales.size()).map { locales[it].toLanguageTag() }))
        t.put("timezone", TimeZone.getDefault().id)
        t.put("timezoneOffsetMin", TimeZone.getDefault().getOffset(System.currentTimeMillis()) / 60000)
        t.put("clock", iso(System.currentTimeMillis()))
        t.put("autoTime", Settings.Global.getInt(ctx.contentResolver, Settings.Global.AUTO_TIME, 0) == 1)
        t.put("developerOptions", Settings.Global.getInt(ctx.contentResolver, Settings.Global.DEVELOPMENT_SETTINGS_ENABLED, 0) == 1)
        t.put("adb", Settings.Global.getInt(ctx.contentResolver, Settings.Global.ADB_ENABLED, 0) == 1)
        t.put("airplaneMode", Settings.Global.getInt(ctx.contentResolver, Settings.Global.AIRPLANE_MODE_ON, 0) == 1)
        t.put("screenOffTimeoutMs", Settings.System.getInt(ctx.contentResolver, Settings.System.SCREEN_OFF_TIMEOUT, -1))
        t.put("stayAwake", Settings.Global.getInt(ctx.contentResolver, Settings.Global.STAY_ON_WHILE_PLUGGED_IN, 0))
    }

    private fun screen(t: JSONObject) {
        val dm: DisplayMetrics = ctx.resources.displayMetrics
        val cfg: Configuration = ctx.resources.configuration
        t.put("widthPx", dm.widthPixels)
        t.put("heightPx", dm.heightPixels)
        t.put("densityDpi", dm.densityDpi)
        t.put("density", dm.density)
        t.put("xdpi", dm.xdpi)
        t.put("ydpi", dm.ydpi)
        t.put("widthDp", cfg.screenWidthDp)
        t.put("heightDp", cfg.screenHeightDp)
        t.put("smallestWidthDp", cfg.smallestScreenWidthDp)
        t.put("fontScale", cfg.fontScale)
        t.put("orientation", if (cfg.orientation == Configuration.ORIENTATION_LANDSCAPE) "landscape" else "portrait")
        t.put("darkMode", (cfg.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES)
        val size = when (cfg.screenLayout and Configuration.SCREENLAYOUT_SIZE_MASK) {
            Configuration.SCREENLAYOUT_SIZE_XLARGE -> "xlarge"; Configuration.SCREENLAYOUT_SIZE_LARGE -> "large"
            Configuration.SCREENLAYOUT_SIZE_NORMAL -> "normal"; Configuration.SCREENLAYOUT_SIZE_SMALL -> "small"; else -> "?"
        }
        t.put("sizeClass", size)
        val display = if (Build.VERSION.SDK_INT >= 30) ctx.display else @Suppress("DEPRECATION") (ctx.getSystemService(Context.WINDOW_SERVICE) as android.view.WindowManager).defaultDisplay
        display?.let { d ->
            t.put("refreshRateHz", d.refreshRate)
            t.put("displayName", d.name)
            t.put("rotation", d.rotation * 90)
        }
        t.put("brightness", Settings.System.getInt(ctx.contentResolver, Settings.System.SCREEN_BRIGHTNESS, -1))
        t.put("brightnessAuto", Settings.System.getInt(ctx.contentResolver, Settings.System.SCREEN_BRIGHTNESS_MODE, 0) == 1)
    }

    private fun memory(t: JSONObject) {
        val am = ctx.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val mi = ActivityManager.MemoryInfo().also { am.getMemoryInfo(it) }
        t.put("totalMb", mi.totalMem / MB)
        t.put("availableMb", mi.availMem / MB)
        t.put("lowMemory", mi.lowMemory)
        t.put("lowMemoryThresholdMb", mi.threshold / MB)
        t.put("lowRamDevice", am.isLowRamDevice)
        t.put("appHeapLimitMb", am.memoryClass)
        t.put("appLargeHeapLimitMb", am.largeMemoryClass)
        val rt = Runtime.getRuntime()
        t.put("javaHeapMaxMb", rt.maxMemory() / MB)
        t.put("javaHeapUsedMb", (rt.totalMemory() - rt.freeMemory()) / MB)
        t.put("backgroundProcessLimit", runCatching { am.runningAppProcesses?.size ?: -1 }.getOrDefault(-1))
    }

    private fun storage(t: JSONObject) {
        fun fs(dir: File?, name: String) {
            if (dir == null) return
            val s = StatFs(dir.path)
            t.put("${name}TotalMb", s.totalBytes / MB)
            t.put("${name}FreeMb", s.availableBytes / MB)
        }
        fs(ctx.filesDir, "internal")
        fs(ctx.cacheDir, "cache")
        fs(Environment.getExternalStorageDirectory(), "external")
        t.put("externalState", Environment.getExternalStorageState())
        t.put("appDataMb", runCatching { dirSize(ctx.filesDir) / MB }.getOrDefault(-1L))
        t.put("appCacheMb", runCatching { dirSize(ctx.cacheDir) / MB }.getOrDefault(-1L))
        val vosk = File(ctx.filesDir, "vosk")
        if (vosk.isDirectory) t.put("voskModels", JSONArray(vosk.listFiles()?.filter { it.isDirectory }?.map { "${it.name} (${dirSize(it) / MB} MB)" } ?: emptyList<String>()))
    }

    private fun cpu(t: JSONObject) {
        t.put("cores", Runtime.getRuntime().availableProcessors())
        t.put("abi", Build.SUPPORTED_ABIS.firstOrNull() ?: "")
        t.put("is64bit", Build.SUPPORTED_64_BIT_ABIS.isNotEmpty())
        runCatching {
            val lines = File("/proc/cpuinfo").readLines().take(60)
            lines.firstOrNull { it.startsWith("Hardware") }?.substringAfter(":")?.trim()?.let { t.put("hardware", it) }
            lines.firstOrNull { it.startsWith("model name") }?.substringAfter(":")?.trim()?.let { t.put("modelName", it) }
            lines.firstOrNull { it.startsWith("Features") || it.startsWith("flags") }?.substringAfter(":")?.trim()?.let { t.put("features", it.take(300)) }
        }
        runCatching { File("/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq").readText().trim().toLongOrNull()?.let { t.put("maxMhz", it / 1000) } }
        runCatching { File("/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq").readText().trim().toLongOrNull()?.let { t.put("currentMhz", it / 1000) } }
        runCatching {
            val load = File("/proc/loadavg").readText().trim().split(" ")
            t.put("loadAvg1", load.getOrNull(0)?.toDoubleOrNull() ?: -1.0)
            t.put("loadAvg5", load.getOrNull(1)?.toDoubleOrNull() ?: -1.0)
        }
        runCatching {
            val zones = File("/sys/class/thermal").listFiles()?.filter { it.name.startsWith("thermal_zone") }?.take(12)
            val temps = JSONObject()
            zones?.forEach { z ->
                val type = runCatching { File(z, "type").readText().trim() }.getOrNull() ?: z.name
                val temp = runCatching { File(z, "temp").readText().trim().toLongOrNull() }.getOrNull() ?: return@forEach
                temps.put(type, if (temp > 1000) temp / 1000.0 else temp.toDouble())
            }
            if (temps.length() > 0) t.put("thermalC", temps)
        }
        if (Build.VERSION.SDK_INT >= 29) runCatching {
            val pm = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
            t.put("thermalStatus", when (pm.currentThermalStatus) {
                PowerManager.THERMAL_STATUS_NONE -> "none"; PowerManager.THERMAL_STATUS_LIGHT -> "light"; PowerManager.THERMAL_STATUS_MODERATE -> "moderate"
                PowerManager.THERMAL_STATUS_SEVERE -> "severe"; PowerManager.THERMAL_STATUS_CRITICAL -> "critical"; PowerManager.THERMAL_STATUS_EMERGENCY -> "emergency"
                PowerManager.THERMAL_STATUS_SHUTDOWN -> "shutdown"; else -> "?"
            })
        }
    }

    private fun battery(t: JSONObject) {
        val bm = ctx.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        t.put("percent", bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY))
        t.put("charging", bm.isCharging)
        val i: Intent? = ctx.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        if (i != null) {
            t.put("status", when (i.getIntExtra(BatteryManager.EXTRA_STATUS, -1)) {
                BatteryManager.BATTERY_STATUS_CHARGING -> "charging"; BatteryManager.BATTERY_STATUS_DISCHARGING -> "discharging"
                BatteryManager.BATTERY_STATUS_FULL -> "full"; BatteryManager.BATTERY_STATUS_NOT_CHARGING -> "not charging"; else -> "unknown"
            })
            t.put("plugged", when (i.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0)) {
                BatteryManager.BATTERY_PLUGGED_AC -> "ac"; BatteryManager.BATTERY_PLUGGED_USB -> "usb"; BatteryManager.BATTERY_PLUGGED_WIRELESS -> "wireless"
                0 -> "none"; else -> "other"
            })
            t.put("health", when (i.getIntExtra(BatteryManager.EXTRA_HEALTH, -1)) {
                BatteryManager.BATTERY_HEALTH_GOOD -> "good"; BatteryManager.BATTERY_HEALTH_OVERHEAT -> "overheat"; BatteryManager.BATTERY_HEALTH_DEAD -> "dead"
                BatteryManager.BATTERY_HEALTH_OVER_VOLTAGE -> "over voltage"; BatteryManager.BATTERY_HEALTH_COLD -> "cold"; BatteryManager.BATTERY_HEALTH_UNSPECIFIED_FAILURE -> "failure"; else -> "unknown"
            })
            t.put("temperatureC", i.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, -1) / 10.0)
            t.put("voltageMv", i.getIntExtra(BatteryManager.EXTRA_VOLTAGE, -1))
            t.put("technology", i.getStringExtra(BatteryManager.EXTRA_TECHNOLOGY) ?: "")
            t.put("present", i.getBooleanExtra(BatteryManager.EXTRA_PRESENT, true))
        }
        val pm = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
        t.put("powerSaveMode", pm.isPowerSaveMode)
        t.put("batteryOptimisationExempt", pm.isIgnoringBatteryOptimizations(ctx.packageName))
        t.put("interactive", pm.isInteractive)
        if (Build.VERSION.SDK_INT >= 28) t.put("appStandbyBucket", (ctx.getSystemService(Context.USAGE_STATS_SERVICE) as android.app.usage.UsageStatsManager).appStandbyBucket)
    }

    private fun network(t: JSONObject) {
        val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val n = cm.activeNetwork
        val caps = n?.let { cm.getNetworkCapabilities(it) }
        if (caps == null) {
            t.put("type", "none")
            return
        }
        val type = when {
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_BLUETOOTH) -> "bluetooth"
            else -> "other"
        }
        t.put("type", type)
        t.put("vpn", caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN))
        t.put("internet", caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET))
        t.put("validated", caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED))
        t.put("metered", cm.isActiveNetworkMetered)
        t.put("captivePortal", caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_CAPTIVE_PORTAL))
        t.put("downKbps", caps.linkDownstreamBandwidthKbps)
        t.put("upKbps", caps.linkUpstreamBandwidthKbps)
        if (Build.VERSION.SDK_INT >= 29) t.put("signalStrength", caps.signalStrength)
        cm.getLinkProperties(n)?.let { lp ->
            t.put("interface", lp.interfaceName ?: "")
            t.put("dns", JSONArray(lp.dnsServers.map { it.hostAddress ?: "" }))
            t.put("ipv4", lp.linkAddresses.any { it.address is java.net.Inet4Address })
            t.put("ipv6", lp.linkAddresses.any { it.address is java.net.Inet6Address && !it.address.isLinkLocalAddress })
            if (Build.VERSION.SDK_INT >= 29) t.put("mtu", lp.mtu)
            t.put("proxy", lp.httpProxy != null)
        }
        if (type == "wifi") runCatching {
            // signal and link speed only: the network name needs the location permission and says where the ship is
            @Suppress("DEPRECATION") val wm = ctx.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            @Suppress("DEPRECATION") val wi = wm.connectionInfo
            val w = JSONObject()
            w.put("rssiDbm", wi.rssi)
            w.put("linkMbps", wi.linkSpeed)
            if (Build.VERSION.SDK_INT >= 29) { w.put("txMbps", wi.txLinkSpeedMbps); w.put("rxMbps", wi.rxLinkSpeedMbps) }
            w.put("frequencyMhz", wi.frequency)
            w.put("band", if (wi.frequency > 5900) "6 GHz" else if (wi.frequency > 4900) "5 GHz" else "2.4 GHz")
            if (Build.VERSION.SDK_INT >= 30) w.put("standard", when (wi.wifiStandard) { 4 -> "802.11n"; 5 -> "802.11ac"; 6 -> "802.11ax"; 7 -> "802.11ad"; 8 -> "802.11be"; 1 -> "legacy"; else -> "?" })
            @Suppress("DEPRECATION") w.put("signalLevel", WifiManager.calculateSignalLevel(wi.rssi, 5))
            t.put("wifi", w)
        }
    }

    private fun bluetooth(t: JSONObject) {
        val bm = ctx.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
        val adapter = bm?.adapter
        t.put("supported", adapter != null)
        t.put("leSupported", ctx.packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE))
        if (adapter == null) return
        t.put("enabled", runCatching { adapter.isEnabled }.getOrDefault(false))
        val connectOk = Build.VERSION.SDK_INT < 31 || ContextCompat.checkSelfPermission(ctx, Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED
        t.put("permission", connectOk)
        if (connectOk) runCatching {
            t.put("bondedDevices", adapter.bondedDevices.size)
            t.put("bondedNames", JSONArray(adapter.bondedDevices.map { runCatching { it.name }.getOrNull() ?: "?" }.take(20)))
            t.put("scanMode", adapter.scanMode)
        }
        if (Build.VERSION.SDK_INT >= 26) runCatching {
            t.put("le2MPhy", adapter.isLe2MPhySupported)
            t.put("leCodedPhy", adapter.isLeCodedPhySupported)
            t.put("leExtendedAdvertising", adapter.isLeExtendedAdvertisingSupported)
        }
        t.put("multipleAdvertisement", runCatching { adapter.isMultipleAdvertisementSupported }.getOrDefault(false))
        t.put("offloadedFiltering", runCatching { adapter.isOffloadedFilteringSupported }.getOrDefault(false))
    }

    private fun audio(t: JSONObject) {
        val am = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        t.put("mode", when (am.mode) { AudioManager.MODE_NORMAL -> "normal"; AudioManager.MODE_RINGTONE -> "ringtone"; AudioManager.MODE_IN_CALL -> "in call"; AudioManager.MODE_IN_COMMUNICATION -> "in communication"; else -> "?" })
        t.put("micMuted", am.isMicrophoneMute)
        t.put("musicActive", am.isMusicActive)
        t.put("speakerphone", @Suppress("DEPRECATION") am.isSpeakerphoneOn)
        t.put("bluetoothScoAvailable", am.isBluetoothScoAvailableOffCall)
        t.put("bluetoothScoOn", @Suppress("DEPRECATION") am.isBluetoothScoOn)
        t.put("bluetoothA2dpOn", @Suppress("DEPRECATION") am.isBluetoothA2dpOn)
        t.put("wiredHeadsetOn", @Suppress("DEPRECATION") am.isWiredHeadsetOn)
        t.put("ringerMode", when (am.ringerMode) { AudioManager.RINGER_MODE_SILENT -> "silent"; AudioManager.RINGER_MODE_VIBRATE -> "vibrate"; else -> "normal" })
        fun vol(stream: Int, name: String) {
            t.put("${name}Volume", am.getStreamVolume(stream))
            t.put("${name}VolumeMax", am.getStreamMaxVolume(stream))
            if (Build.VERSION.SDK_INT >= 23) t.put("${name}Muted", am.isStreamMute(stream))
        }
        vol(AudioManager.STREAM_MUSIC, "media")
        vol(AudioManager.STREAM_NOTIFICATION, "notification")
        vol(AudioManager.STREAM_RING, "ring")
        vol(AudioManager.STREAM_VOICE_CALL, "call")
        vol(AudioManager.STREAM_SYSTEM, "system")
        t.put("nativeSampleRate", am.getProperty(AudioManager.PROPERTY_OUTPUT_SAMPLE_RATE) ?: "")
        t.put("nativeFramesPerBuffer", am.getProperty(AudioManager.PROPERTY_OUTPUT_FRAMES_PER_BUFFER) ?: "")
        t.put("micNearUltrasound", am.getProperty(AudioManager.PROPERTY_SUPPORT_MIC_NEAR_ULTRASOUND) ?: "")
        t.put("lowLatency", ctx.packageManager.hasSystemFeature(PackageManager.FEATURE_AUDIO_LOW_LATENCY))
        t.put("proAudio", ctx.packageManager.hasSystemFeature(PackageManager.FEATURE_AUDIO_PRO))
        t.put("outputs", JSONArray(am.getDevices(AudioManager.GET_DEVICES_OUTPUTS).map { audioDevice(it) }.take(20)))
        t.put("inputs", JSONArray(am.getDevices(AudioManager.GET_DEVICES_INPUTS).map { audioDevice(it) }.take(20)))
        if (Build.VERSION.SDK_INT >= 31) runCatching {
            t.put("communicationDevice", am.communicationDevice?.let { audioDevice(it) } ?: "")
        }
        if (Build.VERSION.SDK_INT >= 28) runCatching {
            t.put("microphones", JSONArray(am.microphones.map { m -> "${m.description} (${micLocation(m.location)}${if (m.channelMapping.isNotEmpty()) ", ${m.channelMapping.size} ch" else ""})" }.take(10)))
        }
        t.put("echoCanceler", android.media.audiofx.AcousticEchoCanceler.isAvailable())
        t.put("noiseSuppressor", android.media.audiofx.NoiseSuppressor.isAvailable())
        t.put("automaticGain", android.media.audiofx.AutomaticGainControl.isAvailable())
    }

    private fun micLocation(l: Int): String = when (l) { android.media.MicrophoneInfo.LOCATION_MAINBODY -> "main body"; android.media.MicrophoneInfo.LOCATION_MAINBODY_MOVABLE -> "movable"; android.media.MicrophoneInfo.LOCATION_PERIPHERAL -> "peripheral"; else -> "unknown" }

    private fun audioDevice(d: AudioDeviceInfo): String {
        val type = when (d.type) {
            AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "earpiece"; AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "speaker"; AudioDeviceInfo.TYPE_WIRED_HEADSET -> "wired headset"
            AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> "wired headphones"; AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "bluetooth sco"; AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> "bluetooth a2dp"
            AudioDeviceInfo.TYPE_HDMI -> "hdmi"; AudioDeviceInfo.TYPE_USB_DEVICE -> "usb device"; AudioDeviceInfo.TYPE_USB_ACCESSORY -> "usb accessory"; AudioDeviceInfo.TYPE_USB_HEADSET -> "usb headset"
            AudioDeviceInfo.TYPE_BUILTIN_MIC -> "built-in mic"; AudioDeviceInfo.TYPE_TELEPHONY -> "telephony"; AudioDeviceInfo.TYPE_LINE_ANALOG -> "line analog"; AudioDeviceInfo.TYPE_LINE_DIGITAL -> "line digital"
            AudioDeviceInfo.TYPE_FM -> "fm"; AudioDeviceInfo.TYPE_FM_TUNER -> "fm tuner"; AudioDeviceInfo.TYPE_TV_TUNER -> "tv tuner"; AudioDeviceInfo.TYPE_DOCK -> "dock"; AudioDeviceInfo.TYPE_AUX_LINE -> "aux"
            AudioDeviceInfo.TYPE_IP -> "ip"; AudioDeviceInfo.TYPE_BUS -> "bus"; AudioDeviceInfo.TYPE_HEARING_AID -> "hearing aid"; 26 -> "ble headset"; 27 -> "ble speaker"; 30 -> "ble broadcast"; else -> "type ${d.type}"
        }
        val name = d.productName?.toString()?.takeIf { it.isNotBlank() && it != Build.MODEL } ?: ""
        val rates = d.sampleRates.takeIf { it.isNotEmpty() }?.let { r -> " ${r.minOrNull()}–${r.maxOrNull()} Hz" } ?: ""
        return "$type${if (name.isNotEmpty()) " \"$name\"" else ""}$rates"
    }

    private fun speech(t: JSONObject) {
        val pm = ctx.packageManager
        t.put("recognitionAvailable", SpeechRecognizer.isRecognitionAvailable(ctx))
        if (Build.VERSION.SDK_INT >= 31) t.put("onDeviceRecognitionAvailable", SpeechRecognizer.isOnDeviceRecognitionAvailable(ctx))
        val services = pm.queryIntentServices(Intent(RecognitionService.SERVICE_INTERFACE), 0)
        t.put("recognisers", JSONArray(services.map { s -> "${s.serviceInfo.packageName} ${versionOf(s.serviceInfo.packageName)}" }.take(10)))
        val defaultRecogniser = Settings.Secure.getString(ctx.contentResolver, "voice_recognition_service") ?: ""
        t.put("defaultRecogniser", defaultRecogniser)
        t.put("googleApp", versionOf("com.google.android.googlequicksearchbox"))
        t.put("speechServices", versionOf("com.google.android.tts"))
        t.put("ttsEngines", JSONArray(pm.queryIntentServices(Intent(TextToSpeech.Engine.INTENT_ACTION_TTS_SERVICE), 0).map { s -> "${s.serviceInfo.packageName} ${versionOf(s.serviceInfo.packageName)}" }.take(10)))
        t.put("defaultTtsEngine", Settings.Secure.getString(ctx.contentResolver, "tts_default_synth") ?: "")
        t.put("ttsRate", Settings.Secure.getInt(ctx.contentResolver, "tts_default_rate", -1))
    }

    /** What the engine in use knows: its name, the voices for our languages, which languages it has at all. Needs a ready TextToSpeech. */
    fun tts(t: JSONObject, tts: TextToSpeech?, ready: Boolean) {
        t.put("ready", ready)
        if (tts == null || !ready) return
        runCatching { t.put("engine", tts.defaultEngine ?: "") }
        runCatching { t.put("engineVersion", versionOf(tts.defaultEngine ?: "")) }
        runCatching { t.put("engines", JSONArray(tts.engines.map { "${it.name} (${it.label})" })) }
        runCatching { t.put("defaultVoice", tts.defaultVoice?.let { "${it.name} ${it.locale.toLanguageTag()}" } ?: "") }
        runCatching { t.put("voice", tts.voice?.let { "${it.name} ${it.locale.toLanguageTag()}" } ?: "") }
        runCatching {
            val voices = tts.voices ?: emptySet()
            t.put("voiceCount", voices.size)
            val perLang = JSONObject()
            for (lang in listOf("en", "sv", "nb", "no", "fr", "de", "da")) {
                val vs = voices.filter { it.locale.language == lang || (lang == "no" && it.locale.language == "nb") }
                if (vs.isEmpty()) continue
                perLang.put(lang, JSONArray(vs.map { v -> "${v.name} (${qualityName(v.quality)}${if (v.isNetworkConnectionRequired) ", online" else ", offline"})" }.take(12)))
            }
            t.put("voices", perLang)
        }
        runCatching {
            val avail = JSONObject()
            for ((lang, loc) in listOf("en" to Locale.UK, "sv" to Locale("sv", "SE"), "no" to Locale("nb", "NO"), "fr" to Locale.FRANCE, "de" to Locale.GERMANY)) {
                avail.put(lang, when (tts.isLanguageAvailable(loc)) {
                    TextToSpeech.LANG_COUNTRY_VAR_AVAILABLE -> "country+variant"; TextToSpeech.LANG_COUNTRY_AVAILABLE -> "country"; TextToSpeech.LANG_AVAILABLE -> "language"
                    TextToSpeech.LANG_MISSING_DATA -> "missing data"; TextToSpeech.LANG_NOT_SUPPORTED -> "not supported"; else -> "?"
                })
            }
            t.put("languages", avail)
        }
    }

    private fun qualityName(q: Int): String = when {
        q >= android.speech.tts.Voice.QUALITY_VERY_HIGH -> "very high"; q >= android.speech.tts.Voice.QUALITY_HIGH -> "high"
        q >= android.speech.tts.Voice.QUALITY_NORMAL -> "normal"; q >= android.speech.tts.Voice.QUALITY_LOW -> "low"; else -> "very low"
    }

    private fun webview(t: JSONObject) {
        val p = runCatching { WebView.getCurrentWebViewPackage() }.getOrNull()
        t.put("package", p?.packageName ?: "")
        t.put("version", p?.versionName ?: "")
        t.put("chromeVersion", p?.versionName?.substringBefore('.') ?: "")
        t.put("chrome", versionOf("com.android.chrome"))
    }

    private fun permissions(t: JSONObject) {
        fun granted(p: String) = ContextCompat.checkSelfPermission(ctx, p) == PackageManager.PERMISSION_GRANTED
        t.put("microphone", granted(Manifest.permission.RECORD_AUDIO))
        t.put("camera", granted(Manifest.permission.CAMERA))
        t.put("bluetoothConnect", Build.VERSION.SDK_INT < 31 || granted(Manifest.permission.BLUETOOTH_CONNECT))
        t.put("notifications", NotificationManagerCompat.from(ctx).areNotificationsEnabled())
        if (Build.VERSION.SDK_INT >= 33) t.put("postNotifications", granted(Manifest.permission.POST_NOTIFICATIONS))
        t.put("modifyAudio", granted(Manifest.permission.MODIFY_AUDIO_SETTINGS))
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
        t.put("doNotDisturb", nm.currentInterruptionFilter != android.app.NotificationManager.INTERRUPTION_FILTER_ALL)
    }

    private fun management(t: JSONObject) {
        val am = ctx.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        t.put("lockTaskMode", when (am.lockTaskModeState) { ActivityManager.LOCK_TASK_MODE_LOCKED -> "locked"; ActivityManager.LOCK_TASK_MODE_PINNED -> "pinned"; else -> "none" })
        val dpm = ctx.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
        t.put("deviceOwner", dpm.isDeviceOwnerApp(ctx.packageName))
        t.put("profileOwner", runCatching { dpm.isProfileOwnerApp(ctx.packageName) }.getOrDefault(false))
        t.put("managed", runCatching { dpm.activeAdmins?.isNotEmpty() ?: false }.getOrDefault(false))
        t.put("adminApps", JSONArray(runCatching { dpm.activeAdmins?.map { it.packageName } ?: emptyList() }.getOrDefault(emptyList<String>()).take(10)))
        t.put("keyguardLocked", (ctx.getSystemService(Context.KEYGUARD_SERVICE) as android.app.KeyguardManager).isKeyguardLocked)
        t.put("secureKeyguard", (ctx.getSystemService(Context.KEYGUARD_SERVICE) as android.app.KeyguardManager).isDeviceSecure)
        t.put("accessibilityOn", Settings.Secure.getInt(ctx.contentResolver, Settings.Secure.ACCESSIBILITY_ENABLED, 0) == 1)
        t.put("touchExploration", (ctx.getSystemService(Context.ACCESSIBILITY_SERVICE) as android.view.accessibility.AccessibilityManager).isTouchExplorationEnabled)
    }

    private fun input(t: JSONObject) {
        val im = ctx.getSystemService(Context.INPUT_SERVICE) as InputManager
        val list = JSONArray()
        for (id in im.inputDeviceIds) {
            val d: InputDevice = im.getInputDevice(id) ?: continue
            if (d.isVirtual) continue
            val sources = mutableListOf<String>()
            if (d.sources and InputDevice.SOURCE_KEYBOARD == InputDevice.SOURCE_KEYBOARD) sources.add("keyboard")
            if (d.sources and InputDevice.SOURCE_TOUCHSCREEN == InputDevice.SOURCE_TOUCHSCREEN) sources.add("touchscreen")
            if (d.sources and InputDevice.SOURCE_MOUSE == InputDevice.SOURCE_MOUSE) sources.add("mouse")
            if (d.sources and InputDevice.SOURCE_GAMEPAD == InputDevice.SOURCE_GAMEPAD) sources.add("gamepad")
            if (d.sources and InputDevice.SOURCE_DPAD == InputDevice.SOURCE_DPAD) sources.add("dpad")
            if (d.sources and InputDevice.SOURCE_STYLUS == InputDevice.SOURCE_STYLUS) sources.add("stylus")
            val o = JSONObject()
            o.put("name", d.name)
            o.put("sources", JSONArray(sources))
            o.put("external", if (Build.VERSION.SDK_INT >= 29) d.isExternal else false)
            o.put("keyboardType", when (d.keyboardType) { InputDevice.KEYBOARD_TYPE_ALPHABETIC -> "alphabetic"; InputDevice.KEYBOARD_TYPE_NON_ALPHABETIC -> "non-alphabetic"; else -> "none" })
            if (d.vendorId != 0 || d.productId != 0) o.put("vidPid", String.format(Locale.ROOT, "%04x:%04x", d.vendorId, d.productId))
            o.put("hasMicrophone", d.hasMicrophone())
            list.put(o)
            if (list.length() >= 20) break
        }
        t.put("devices", list)
        t.put("hardKeyboard", ctx.resources.configuration.keyboard == Configuration.KEYBOARD_QWERTY)
        t.put("touchscreen", ctx.resources.configuration.touchscreen != Configuration.TOUCHSCREEN_NOTOUCH)
    }

    private fun features(t: JSONObject) {
        val pm = ctx.packageManager
        for ((name, f) in listOf(
            "microphone" to PackageManager.FEATURE_MICROPHONE, "bluetoothLe" to PackageManager.FEATURE_BLUETOOTH_LE, "bluetooth" to PackageManager.FEATURE_BLUETOOTH,
            "cameraAny" to PackageManager.FEATURE_CAMERA_ANY, "wifi" to PackageManager.FEATURE_WIFI, "ethernet" to PackageManager.FEATURE_ETHERNET,
            "telephony" to PackageManager.FEATURE_TELEPHONY, "nfc" to PackageManager.FEATURE_NFC, "usbHost" to PackageManager.FEATURE_USB_HOST,
            "usbAccessory" to PackageManager.FEATURE_USB_ACCESSORY, "gps" to PackageManager.FEATURE_LOCATION_GPS, "touchscreen" to PackageManager.FEATURE_TOUCHSCREEN,
            "multitouch" to PackageManager.FEATURE_TOUCHSCREEN_MULTITOUCH, "companionDeviceSetup" to PackageManager.FEATURE_COMPANION_DEVICE_SETUP,
            "webview" to PackageManager.FEATURE_WEBVIEW, "pip" to PackageManager.FEATURE_PICTURE_IN_PICTURE, "vulkan" to PackageManager.FEATURE_VULKAN_HARDWARE_LEVEL,
        )) t.put(name, pm.hasSystemFeature(f))
        t.put("playServices", versionOf("com.google.android.gms"))
        t.put("playStore", versionOf("com.android.vending"))
    }

    private fun versionOf(pkg: String): String = if (pkg.isEmpty()) "" else runCatching { ctx.packageManager.getPackageInfo(pkg, 0).versionName ?: "?" }.getOrDefault("not installed")

    private fun dirSize(f: File): Long = if (f.isFile) f.length() else f.listFiles()?.sumOf { dirSize(it) } ?: 0L

    private fun iso(ms: Long): String = if (ms <= 0) "" else java.time.Instant.ofEpochMilli(ms).toString()

    private companion object {
        const val MB = 1024L * 1024L
    }
}
