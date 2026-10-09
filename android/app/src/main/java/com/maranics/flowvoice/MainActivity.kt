package com.maranics.flowvoice

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.text.InputType
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.view.View
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale

/** Hub used until another one is picked on the device. */
const val DEFAULT_HUB_URL = "https://flowvoice.operationcentric.com"

/**
 * Flow Voice Android agent (spec 21, profile C). The app stays thin: it owns the microphone,
 * the speaker, the foreground service and the session cookie; the hub owns everything else.
 * The UI is the hub's PWA loaded in a WebView; `window.FlowVoiceAndroid` gives the page
 * on-device TTS (TextToSpeech) and STT (SpeechRecognizer), and the page calls back through
 * `window.flowVoiceBridge` — the same contract as web/src/audio.ts.
 */
class MainActivity : AppCompatActivity() {
    private lateinit var web: WebView
    private var tts: TextToSpeech? = null
    private var ttsReady = false
    private var recognizer: SpeechRecognizer? = null
    private var listening = false
    /**
     * End of the open platform-recogniser window (elapsedRealtime). The system recogniser gives up after a few seconds
     * of quiet whatever the page asked for; until this deadline it is restarted here instead, so the page (and the hub)
     * see one window instead of the mic going on and off every few seconds. 0 = no window.
     */
    private var listenUntil = 0L
    /** Bumped by every new window / stop / speak, so a restart queued for an old window is dropped. */
    private var listenGen = 0

    private fun openWindow(maxMs: Int) {
        listenGen++
        listenUntil = android.os.SystemClock.elapsedRealtime() + maxMs.coerceAtLeast(0)
    }

    private fun closeWindow() {
        listenGen++
        listenUntil = 0L
    }

    /** Enough of the window left for another try? (The recogniser needs a moment to start and hear something.) */
    private fun windowLeft(): Boolean = listenUntil - android.os.SystemClock.elapsedRealtime() > 1500

    private fun restartListening(fresh: Boolean) {
        val gen = listenGen
        if (fresh) { recognizer?.destroy(); recognizer = null }
        web.postDelayed({
            if (gen == listenGen && windowLeft()) beginListening(listenLanguage, preferOffline = listenLanguage !in offlineUnavailable)
        }, 250)
    }
    /** Grammar-restricted offline recogniser; used when the hub sends a vocabulary and a model for the language is loaded. */
    private val vosk by lazy { VoskStt(this, voskCallbacks) { hubUrl } }
    private val packsRequested = HashSet<String>()

    /**
     * Languages without a grammar model (Norwegian) use the system recogniser. On Android 13+ ask it to fetch the
     * offline language pack when it is missing, so recognition keeps working without internet. Older versions have
     * no API for this: the pack is installed in Settings → Google → Voice → Offline speech recognition.
     */
    private fun ensureSystemLanguagePack(language: String) {
        if (Build.VERSION.SDK_INT < 33 || !packsRequested.add(language)) return
        runCatching {
            if (!SpeechRecognizer.isOnDeviceRecognitionAvailable(this)) return
            val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).putExtra(RecognizerIntent.EXTRA_LANGUAGE, localeOf(language).toLanguageTag())
            val r = SpeechRecognizer.createOnDeviceSpeechRecognizer(this)
            r.checkRecognitionSupport(intent, ContextCompat.getMainExecutor(this), object : android.speech.RecognitionSupportCallback {
                override fun onSupportResult(support: android.speech.RecognitionSupport) {
                    val tag = localeOf(language).toLanguageTag()
                    if (support.installedOnDeviceLanguages.none { it.equals(tag, true) }) runCatching { r.triggerModelDownload(intent) }
                    r.destroy()
                }
                override fun onError(error: Int) { r.destroy() }
            })
        }
    }
    private var voskListening = false
    private var pttDown = false
    private var micGranted = false

    private val prefs by lazy { getSharedPreferences("flowvoice", Context.MODE_PRIVATE) }
    /** The hub this app talks to: the one picked on this device (scan / "Change hub"), else the Flow Voice server. */
    private val hubUrl: String? get() = prefs.getString("hubUrl", null)?.takeIf { it.isNotBlank() } ?: DEFAULT_HUB_URL

    private val micPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        micGranted = granted
        if (!granted) Toast.makeText(this, R.string.mic_denied, Toast.LENGTH_LONG).show()
    }
    private val notifPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }
    /** "Scan QR": the hub shows its own address as a QR code (Login page / Admin → Status). */
    private val scanQr = registerForActivityResult(ScanContract()) { result ->
        val text = result.contents?.trim()
        if (text.isNullOrEmpty()) return@registerForActivityResult
        val station = stationLinkFromQr(text)
        if (station != null) {
            // station poster: {hub}/client#/join/<token> (older posters: /?mobile=1#/join/<token>) → remember the hub, then let the PWA redeem the token.
            // A changed query string forces a full load (a bare hash change would not re-run the join on boot).
            prefs.edit().putString("hubUrl", station.first).apply()
            web.loadUrl("${station.first}/client?scan=${System.currentTimeMillis()}#/join/${station.second}")
            return@registerForActivityResult
        }
        val url = hubUrlFromQr(text)
        if (url == null) {
            Toast.makeText(this, getString(R.string.qr_not_hub, text.take(60)), Toast.LENGTH_LONG).show()
            askHubUrl(first = hubUrl.isNullOrBlank())
        } else saveHubUrl(url)
    }

    /** Bluetooth push-to-talk buttons that are not keyboards (Zello-type), one per slot 1–3: picked once, remembered, see BleButton.kt. */
    private val bleButtons by lazy {
        (1..3).map { slot ->
            BleButton(
                this, slot,
                onKey = { key, down -> js("window.flowVoiceButton&&window.flowVoiceButton(${q(key)},$down)") },
                onState = { js("window.flowVoiceButtonState&&window.flowVoiceButtonState(${q(buttonStateJson())})") },
                onError = { message -> runOnUiThread { Toast.makeText(this, getString(R.string.button_failed, message), Toast.LENGTH_LONG).show() } },
            )
        }
    }
    private fun buttonStateJson(): String = JSONArray(bleButtons.map { JSONObject().put("slot", it.slot).put("name", it.name).put("connected", it.connected) }).toString()

    /** The slot the open chooser is picking for. */
    private var choosingSlot = 0
    private val buttonChooser = registerForActivityResult(ActivityResultContracts.StartIntentSenderForResult()) { result ->
        val button = bleButtons.getOrNull(choosingSlot - 1) ?: return@registerForActivityResult
        if (result.resultCode == RESULT_OK) button.onChosen(result.data) { mac -> bleButtons.any { it !== button && it.sameDevice(mac) } }
    }
    /** What to do once "Nearby devices" is granted: open the chooser (asked from the menu) or just reconnect (app start). */
    private var buttonPermissionThen: (() -> Unit)? = null
    private val buttonPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) buttonPermissionThen?.invoke() else Toast.makeText(this, R.string.button_denied, Toast.LENGTH_LONG).show()
        buttonPermissionThen = null
    }

    private fun withButtonPermission(then: () -> Unit) {
        if (bleButtons[0].allowed()) then()
        else {
            buttonPermissionThen = then
            buttonPermission.launch(Manifest.permission.BLUETOOTH_CONNECT)
        }
    }

    private fun chooseButton(slot: Int, all: Boolean) = withButtonPermission {
        val button = bleButtons.getOrNull(slot - 1) ?: return@withButtonPermission
        choosingSlot = slot
        button.choose(all) { sender -> buttonChooser.launch(IntentSenderRequest.Builder(sender).build()) }
    }

    /** Menu "Bluetooth buttons…": the three slots, then what to do with the one tapped. */
    private fun showButtons() {
        val items = bleButtons.map { b -> getString(R.string.button_slot, b.slot, if (b.name.isEmpty()) getString(R.string.button_none) else if (b.connected) getString(R.string.button_connected, b.name) else getString(R.string.button_away, b.name)) }.toTypedArray()
        AlertDialog.Builder(this).setTitle(R.string.menu_button).setItems(items) { _, which ->
            val b = bleButtons[which]
            val actions = mutableListOf(getString(R.string.button_find), getString(R.string.button_find_all))
            if (b.name.isNotEmpty()) actions.add(getString(R.string.button_forget))
            AlertDialog.Builder(this).setTitle(items[which]).setItems(actions.toTypedArray()) { _, a ->
                when (a) {
                    0 -> chooseButton(b.slot, all = false)
                    1 -> chooseButton(b.slot, all = true)
                    2 -> b.forget()
                }
            }.show()
        }.show()
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        web = WebView(this)
        setContentView(web)
        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            // honour the PWA's <meta name="viewport" width=device-width>; without these the page lays out wider than the phone
            useWideViewPort = true
            loadWithOverviewMode = true
            allowFileAccess = false
            userAgentString = "$userAgentString FlowVoiceAndroid/${BuildConfig.VERSION_NAME}"
        }
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true)
        web.addJavascriptInterface(Bridge(), "FlowVoiceAndroid")
        web.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                // the PWA streams PCM to the hub when STT runs server-side (STT_ENDPOINT); grant the mic
                runOnUiThread {
                    if (request.resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE) && micGranted) request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
                    else request.deny()
                }
            }
        }
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val u = request.url
                // keep the hub (and the identity provider it redirects to) inside the WebView; hand everything else to the system
                if (u.scheme == "flowvoice") {
                    view.loadUrl(hubUrl ?: return true)
                    return true
                }
                return false
            }
        }
        web.setBackgroundColor(ContextCompat.getColor(this, R.color.bg))
        web.setOnLongClickListener { showMenu(); true }

        tts = TextToSpeech(this) { status ->
            ttsReady = status == TextToSpeech.SUCCESS
            tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                override fun onStart(utteranceId: String?) {}
                override fun onDone(utteranceId: String?) = spoken(utteranceId)
                override fun onStop(utteranceId: String?, interrupted: Boolean) = spoken(utteranceId)
                @Deprecated("Deprecated in Java")
                override fun onError(utteranceId: String?) = spoken(utteranceId)
                override fun onError(utteranceId: String?, errorCode: Int) = spoken(utteranceId)
            })
        }

        micGranted = ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        if (!micGranted) micPermission.launch(Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) notifPermission.launch(Manifest.permission.POST_NOTIFICATIONS)

        // a button picked earlier is connected again by itself (the permission was granted when it was picked)
        for (b in bleButtons) if (b.name.isNotEmpty()) b.connect()

        if (savedInstanceState == null) load() else web.restoreState(savedInstanceState)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (intent.data?.scheme == "flowvoice") hubUrl?.let { web.loadUrl(it) }
    }

    private fun load() {
        val url = hubUrl
        if (url.isNullOrBlank()) askHubUrl(first = true) else web.loadUrl(url)
    }

    /** Accepts a plain http(s) URL or a flowvoice://hub?url=… link; anything else is not a hub. */
    private fun hubUrlFromQr(text: String): String? {
        val u = runCatching { Uri.parse(text) }.getOrNull() ?: return null
        val candidate = if (u.scheme == "flowvoice") u.getQueryParameter("url") ?: return null else text
        val c = runCatching { Uri.parse(candidate) }.getOrNull() ?: return null
        if (c.scheme != "http" && c.scheme != "https" || c.host.isNullOrBlank()) return null
        return candidate.trimEnd('/')
    }

    /** A station poster link → (hub origin, join token); null for anything else. */
    private fun stationLinkFromQr(text: String): Pair<String, String>? {
        val u = runCatching { Uri.parse(text) }.getOrNull() ?: return null
        if (u.scheme != "http" && u.scheme != "https" || u.host.isNullOrBlank()) return null
        val token = Regex("^/?join/(fvj_[A-Za-z0-9_-]+)$").find(u.fragment ?: return null)?.groupValues?.get(1) ?: return null
        val origin = "${u.scheme}://${u.host}${if (u.port > 0) ":${u.port}" else ""}"
        return origin to token
    }

    private fun saveHubUrl(v: String) {
        prefs.edit().putString("hubUrl", v).apply()
        if (v.isNotEmpty()) web.loadUrl(v)
    }

    private fun startScan() {
        scanQr.launch(
            ScanOptions()
                .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                .setPrompt(getString(R.string.scan_prompt))
                .setBeepEnabled(false)
                .setOrientationLocked(false)
        )
    }

    private fun askHubUrl(first: Boolean) {
        val layout = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(48, 24, 48, 0) }
        val input = EditText(this).apply {
            inputType = InputType.TYPE_TEXT_VARIATION_URI
            hint = getString(R.string.hub_url_hint)
            setText(hubUrl ?: "")
        }
        layout.addView(input)
        layout.addView(TextView(this).apply { text = getString(R.string.hub_url_help); setPadding(0, 16, 0, 0) })
        AlertDialog.Builder(this)
            .setTitle(R.string.hub_url_title)
            .setView(layout)
            .setCancelable(!first)
            .setPositiveButton(R.string.save) { _, _ ->
                var v = input.text.toString().trim()
                if (v.isNotEmpty() && !v.startsWith("http")) v = "http://$v"
                saveHubUrl(v)
            }
            .setNeutralButton(R.string.scan_qr) { _, _ -> startScan() }
            .apply { if (!first) setNegativeButton(R.string.cancel, null) }
            .show()
    }

    /** "Enter station code": the six digits on the poster, typed instead of scanned (the hub address must already be known). */
    private fun askStationCode() {
        val hub = hubUrl?.trimEnd('/')
        if (hub.isNullOrBlank()) {
            askHubUrl(first = true)
            return
        }
        val layout = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(48, 24, 48, 0) }
        val input = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_NUMBER
            hint = getString(R.string.code_hint)
            textSize = 28f
            letterSpacing = 0.3f
            gravity = android.view.Gravity.CENTER
        }
        layout.addView(input)
        layout.addView(TextView(this).apply { text = getString(R.string.code_help); setPadding(0, 16, 0, 0) })
        AlertDialog.Builder(this)
            .setTitle(R.string.code_title)
            .setView(layout)
            .setPositiveButton(R.string.join) { _, _ ->
                val code = input.text.toString().filter { it.isDigit() }
                if (code.length != 6) {
                    Toast.makeText(this, R.string.code_bad, Toast.LENGTH_LONG).show()
                    return@setPositiveButton
                }
                // same route as a scanned poster: the PWA redeems `#/join/<code>` on boot; the query string forces a full load
                web.loadUrl("$hub/client?scan=${System.currentTimeMillis()}#/join/$code")
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun showMenu() {
        val items = arrayOf(getString(R.string.menu_hub), getString(R.string.menu_scan), getString(R.string.menu_code), getString(R.string.menu_button), getString(R.string.menu_reload), getString(R.string.menu_ptt_hint))
        AlertDialog.Builder(this).setItems(items) { _, which ->
            when (which) {
                0 -> askHubUrl(first = false)
                1 -> startScan()
                2 -> askStationCode()
                3 -> showButtons()
                4 -> web.reload()
            }
        }.show()
    }

    // ---- station buttons (Admin → Stations → Buttons): a Bluetooth / USB button is a keyboard to Android.
    /** Keys the station bound to an action, by DOM `code` name; set by the page (`setButtonKeys`). */
    @Volatile private var buttonKeys: Set<String> = emptySet()

    /**
     * Bound keys go to the page as button presses before the WebView (Enter, arrows) or the push-to-talk keys below
     * (volume-up) can take them. The on-screen keyboard is left alone, and so is everything while no key is bound.
     */
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (buttonKeys.isEmpty() || event.deviceId == KeyCharacterMap.VIRTUAL_KEYBOARD) return super.dispatchKeyEvent(event)
        val name = buttonKeyName(event.keyCode)
        // "*" = a button is being set up on this device (Home → Buttons): every hardware key goes to the page
        if (name == null || (name !in buttonKeys && "*" !in buttonKeys)) return super.dispatchKeyEvent(event)
        if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) js("window.flowVoiceButton&&window.flowVoiceButton(${q(name)},true)")
        else if (event.action == KeyEvent.ACTION_UP) js("window.flowVoiceButton&&window.flowVoiceButton(${q(name)},false)")
        return true
    }

    /** Android key code → the name a browser gives the same key (`KeyboardEvent.code`), so one station setting fits both. */
    private fun buttonKeyName(keyCode: Int): String? = when (keyCode) {
        KeyEvent.KEYCODE_BACK, KeyEvent.KEYCODE_HOME, KeyEvent.KEYCODE_POWER, KeyEvent.KEYCODE_UNKNOWN -> null
        KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_DPAD_CENTER -> "Enter"
        KeyEvent.KEYCODE_NUMPAD_ENTER -> "NumpadEnter"
        KeyEvent.KEYCODE_SPACE -> "Space"
        KeyEvent.KEYCODE_TAB -> "Tab"
        KeyEvent.KEYCODE_ESCAPE -> "Escape"
        KeyEvent.KEYCODE_DEL -> "Backspace"
        KeyEvent.KEYCODE_FORWARD_DEL -> "Delete"
        KeyEvent.KEYCODE_DPAD_UP -> "ArrowUp"
        KeyEvent.KEYCODE_DPAD_DOWN -> "ArrowDown"
        KeyEvent.KEYCODE_DPAD_LEFT -> "ArrowLeft"
        KeyEvent.KEYCODE_DPAD_RIGHT -> "ArrowRight"
        KeyEvent.KEYCODE_PAGE_UP -> "PageUp"
        KeyEvent.KEYCODE_PAGE_DOWN -> "PageDown"
        KeyEvent.KEYCODE_MOVE_HOME -> "Home"
        KeyEvent.KEYCODE_MOVE_END -> "End"
        KeyEvent.KEYCODE_VOLUME_UP -> "AudioVolumeUp"
        KeyEvent.KEYCODE_VOLUME_DOWN -> "AudioVolumeDown"
        KeyEvent.KEYCODE_VOLUME_MUTE -> "AudioVolumeMute"
        KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE -> "MediaPlayPause"
        KeyEvent.KEYCODE_MEDIA_PLAY -> "MediaPlay"
        KeyEvent.KEYCODE_MEDIA_PAUSE -> "MediaPause"
        KeyEvent.KEYCODE_MEDIA_STOP -> "MediaStop"
        KeyEvent.KEYCODE_MEDIA_NEXT -> "MediaTrackNext"
        KeyEvent.KEYCODE_MEDIA_PREVIOUS -> "MediaTrackPrevious"
        KeyEvent.KEYCODE_HEADSETHOOK -> "HeadsetHook"
        KeyEvent.KEYCODE_CAMERA -> "Camera"
        in KeyEvent.KEYCODE_A..KeyEvent.KEYCODE_Z -> "Key${'A' + (keyCode - KeyEvent.KEYCODE_A)}"
        in KeyEvent.KEYCODE_0..KeyEvent.KEYCODE_9 -> "Digit${keyCode - KeyEvent.KEYCODE_0}"
        in KeyEvent.KEYCODE_NUMPAD_0..KeyEvent.KEYCODE_NUMPAD_9 -> "Numpad${keyCode - KeyEvent.KEYCODE_NUMPAD_0}"
        in KeyEvent.KEYCODE_F1..KeyEvent.KEYCODE_F12 -> "F${keyCode - KeyEvent.KEYCODE_F1 + 1}"
        else -> "Android$keyCode"
    }

    // ---- hardware push-to-talk: volume-up or a headset button, held while speaking
    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        if (isPttKey(keyCode)) {
            if (event.repeatCount == 0 && !pttDown) {
                pttDown = true
                js("window.flowVoiceBridge&&window.flowVoiceBridge.onPtt(true)")
            }
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onKeyUp(keyCode: Int, event: KeyEvent): Boolean {
        if (isPttKey(keyCode)) {
            pttDown = false
            js("window.flowVoiceBridge&&window.flowVoiceBridge.onPtt(false)")
            return true
        }
        return super.onKeyUp(keyCode, event)
    }

    private fun isPttKey(keyCode: Int) = keyCode == KeyEvent.KEYCODE_VOLUME_UP || keyCode == KeyEvent.KEYCODE_HEADSETHOOK || keyCode == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE

    override fun onBackPressed() {
        if (web.canGoBack()) web.goBack() else super.onBackPressed()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    override fun onDestroy() {
        for (b in bleButtons) b.close()
        vosk.shutdown()
        recognizer?.destroy()
        tts?.shutdown()
        VoiceService.stop(this)
        super.onDestroy()
    }

    private fun js(code: String) = runOnUiThread { web.evaluateJavascript(code, null) }
    /** Tell the page an utterance is over (done, flushed, failed) so the hub can open the mic. */
    private fun spoken(utteranceId: String?) = js("window.flowVoiceBridge&&window.flowVoiceBridge.onSpoken(${q(utteranceId ?: "")})")
    private fun q(s: String): String = JSONObject.quote(s)

    private fun localeOf(language: String): Locale = when (language.lowercase().take(2)) {
        "no", "nb" -> Locale("nb", "NO")
        "sv" -> Locale("sv", "SE")
        "de" -> Locale.GERMANY
        "fr" -> Locale.FRANCE
        "da" -> Locale("da", "DK")
        else -> Locale.UK
    }

    /** Called by the PWA (web/src/audio.ts). Every method runs on a WebView thread; hop to the UI thread for Android APIs. */
    inner class Bridge {
        /** The page's theme (light / dark) → status and navigation bar colours follow it. */
        @JavascriptInterface
        fun setTheme(theme: String) = runOnUiThread {
            val dark = theme == "dark"
            val color = ContextCompat.getColor(this@MainActivity, if (dark) R.color.bg_dark else R.color.bg)
            web.setBackgroundColor(color)
            window.statusBarColor = color
            window.navigationBarColor = color
            if (Build.VERSION.SDK_INT >= 30) {
                window.insetsController?.setSystemBarsAppearance(if (dark) 0 else android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS, android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS)
            } else {
                @Suppress("DEPRECATION")
                window.decorView.systemUiVisibility = if (dark) 0 else View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
            }
        }

        /** The station's hardware buttons: the keys (comma-separated DOM `code` names) to hand to the page as `flowVoiceButton(key, down)`. "" = none. */
        @JavascriptInterface
        fun setButtonKeys(keys: String) {
            buttonKeys = keys.split(',').map { it.trim() }.filter { it.isNotEmpty() }.toSet()
        }

        /** Pick the Bluetooth push-to-talk button for a slot (1–3) in the system chooser; it is remembered and reconnected by itself. */
        @JavascriptInterface
        fun connectButtonSlot(slot: Int, all: Boolean) = runOnUiThread { chooseButton(slot, all) }

        /** The remembered Bluetooth buttons, for the page's "Connect button" controls. */
        @JavascriptInterface
        fun buttonState(): String = buttonStateJson()

        @JavascriptInterface
        fun version(): String = BuildConfig.VERSION_NAME

        @JavascriptInterface
        fun hasLocalStt(): Boolean = SpeechRecognizer.isRecognitionAvailable(this@MainActivity)

        @JavascriptInterface
        fun speak(text: String, language: String, promptId: String) = runOnUiThread {
            closeWindow()
            val t = tts
            if (t == null || !ttsReady) {
                js("window.flowVoiceBridge&&window.flowVoiceBridge.onSpoken(${q(promptId)})")
                return@runOnUiThread
            }
            t.language = localeOf(language)
            t.setSpeechRate(0.95f)
            if (t.speak(text, TextToSpeech.QUEUE_FLUSH, null, promptId) != TextToSpeech.SUCCESS) spoken(promptId)
        }

        @JavascriptInterface
        fun stopSpeaking() = runOnUiThread { tts?.stop() }

        @JavascriptInterface
        fun startListening(language: String, maxMs: Int, promptId: String) = runOnUiThread {
            if (!micGranted) {
                js("window.flowVoiceBridge&&window.flowVoiceBridge.onListenEnd('cancel')")
                return@runOnUiThread
            }
            openWindow(maxMs)
            beginListening(language, preferOffline = language !in offlineUnavailable)
        }

        /** Like startListening, but on Android 14+ the recogniser may switch to any of `extraLanguages` (comma-separated tags). */
        @JavascriptInterface
        fun startListeningIn(language: String, extraLanguages: String, maxMs: Int, promptId: String) = startListeningWith(language, extraLanguages, "", maxMs, promptId)

        /** Like startListeningIn, plus words the hub expects (item name, yes/no, options) as recogniser bias (Android 13+). */
        @JavascriptInterface
        fun startListeningWith(language: String, extraLanguages: String, bias: String, maxMs: Int, promptId: String) = runOnUiThread {
            if (!micGranted) {
                js("window.flowVoiceBridge&&window.flowVoiceBridge.onListenEnd('cancel')")
                return@runOnUiThread
            }
            listenExtraLanguages = extraLanguages.split(',').map { it.trim() }.filter { it.isNotEmpty() }
            listenBias = bias.split(',').map { it.trim() }.filter { it.isNotEmpty() }.take(40)
            openWindow(maxMs)
            beginListening(language, preferOffline = language !in offlineUnavailable)
        }

        @JavascriptInterface
        fun stopListening() = runOnUiThread {
            closeWindow()
            if (voskListening) vosk.stop()
            if (listening) recognizer?.stopListening()
        }

        /** Open the camera to scan a station poster (or a hub QR): the only way to change station on this device. */
        @JavascriptInterface
        fun scanStation() = runOnUiThread { startScan() }

        /** Type the six-digit station code instead of scanning (the PWA shows its own field too; this is the native dialog). */
        @JavascriptInterface
        fun enterStationCode() = runOnUiThread { askStationCode() }

        /** Is the grammar recogniser's model for this language loaded? (web/src/audio.ts decides per window.) */
        @JavascriptInterface
        fun hasGrammarStt(language: String): Boolean = vosk.hasModel(language)

        /** Load or download the model for this language in the background. */
        @JavascriptInterface
        fun prepareGrammarStt(language: String) = runOnUiThread {
            vosk.prepare(language)
            if (!vosk.supports(language)) ensureSystemLanguagePack(language)
        }

        /** Listen for the phrases in `grammarJson` (a JSON array) only; anything else is reported as silence. */
        @JavascriptInterface
        fun startListeningGrammar(language: String, grammarJson: String, maxMs: Int, promptId: String) = runOnUiThread {
            if (!micGranted) {
                js("window.flowVoiceBridge&&window.flowVoiceBridge.onListenEnd('cancel')")
                return@runOnUiThread
            }
            if (listening) recognizer?.cancel()
            listening = false
            tts?.stop()
            openWindow(maxMs)
            voskListening = vosk.start(language, grammarJson, maxMs)
            if (!voskListening) {
                // model gone or mic busy: fall back to the platform recogniser so the window is not lost
                listenBias = emptyList()
                beginListening(language, preferOffline = language !in offlineUnavailable)
            }
        }

        /** The hub offers backup recognition (boot info): windows the phone cannot transcribe may be sent there. */
        @JavascriptInterface
        fun setServerStt(enabled: Boolean) { vosk.serverBackup = enabled }

        /** Is there a grammar model for this language at all? (No → `startListeningServer` when the hub has a backup recogniser.) */
        @JavascriptInterface
        fun supportsGrammarStt(language: String): Boolean = vosk.supports(language)

        /** Record one utterance and let the hub transcribe it (languages without a model on the phone). Falls back to the system recogniser. */
        @JavascriptInterface
        fun startListeningServer(language: String, hintsJson: String, maxMs: Int, promptId: String) = runOnUiThread {
            if (!micGranted) {
                js("window.flowVoiceBridge&&window.flowVoiceBridge.onListenEnd('cancel')")
                return@runOnUiThread
            }
            if (listening) recognizer?.cancel()
            listening = false
            tts?.stop()
            openWindow(maxMs)
            voskListening = vosk.startServer(language, hintsJson, maxMs)
            if (!voskListening) beginListening(language, preferOffline = language !in offlineUnavailable)
        }

        @JavascriptInterface
        fun setForeground(active: Boolean, text: String) = runOnUiThread {
            if (active) VoiceService.start(this@MainActivity, text) else VoiceService.stop(this@MainActivity)
            web.keepScreenOn = active
        }
    }

    /** The language of the open listen window, so a "language unavailable" error can be retried online once. */
    private var listenLanguage = ""
    private var listenRetriedOnline = false
    /** Extra languages the recogniser may switch to (Android 14+ language switch; English for a Norwegian checklist). */
    private var listenExtraLanguages: List<String> = emptyList()
    /** Words the hub expects for the open window; a biased recogniser picks "utført" over "utfor" in noise. */
    private var listenBias: List<String> = emptyList()
    /** Languages this phone has no offline pack for (recogniser error 12/13): go straight to the online recogniser. */
    private val offlineUnavailable = mutableSetOf<String>()

    /**
     * Offline recognition first (fast, works at sea); when the phone has no offline pack for the language the
     * recogniser answers ERROR_LANGUAGE_UNAVAILABLE / NOT_SUPPORTED and we retry once with the online recogniser.
     */
    private fun beginListening(language: String, preferOffline: Boolean) {
        if (recognizer == null) recognizer = SpeechRecognizer.createSpeechRecognizer(this@MainActivity).also { it.setRecognitionListener(listener) }
        tts?.stop()
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, localeOf(language).toLanguageTag())
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, packageName)
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 1200L)
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 1200L)
            if (Build.VERSION.SDK_INT >= 33 && preferOffline) putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
            if (Build.VERSION.SDK_INT >= 33 && listenBias.isNotEmpty()) putStringArrayListExtra(RecognizerIntent.EXTRA_BIASING_STRINGS, ArrayList(listenBias))
            if (Build.VERSION.SDK_INT >= 34 && listenExtraLanguages.isNotEmpty()) {
                // crew may answer a Norwegian checklist in English: let the (on-device) recogniser switch languages
                val allowed = ArrayList(listOf(localeOf(language).toLanguageTag()) + listenExtraLanguages)
                putExtra(RecognizerIntent.EXTRA_ENABLE_LANGUAGE_DETECTION, true)
                putStringArrayListExtra(RecognizerIntent.EXTRA_LANGUAGE_DETECTION_ALLOWED_LANGUAGES, allowed)
                putExtra(RecognizerIntent.EXTRA_ENABLE_LANGUAGE_SWITCH, RecognizerIntent.LANGUAGE_SWITCH_BALANCED)
                putStringArrayListExtra(RecognizerIntent.EXTRA_LANGUAGE_SWITCH_ALLOWED_LANGUAGES, allowed)
            }
        }
        listenLanguage = language
        listenRetriedOnline = !preferOffline
        listening = true
        recognizer?.startListening(intent)
    }

    private fun sttErrorName(error: Int): String = when (error) {
        SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "network timeout"
        SpeechRecognizer.ERROR_NETWORK -> "network"
        SpeechRecognizer.ERROR_AUDIO -> "audio"
        SpeechRecognizer.ERROR_SERVER -> "server"
        SpeechRecognizer.ERROR_CLIENT -> "client"
        SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "speech timeout"
        SpeechRecognizer.ERROR_NO_MATCH -> "no match"
        SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "recognizer busy"
        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "microphone permission"
        SpeechRecognizer.ERROR_TOO_MANY_REQUESTS -> "too many requests"
        SpeechRecognizer.ERROR_SERVER_DISCONNECTED -> "server disconnected"
        SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED -> "language not supported"
        SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE -> "language pack not installed"
        SpeechRecognizer.ERROR_CANNOT_CHECK_SUPPORT -> "cannot check language support"
        else -> "error $error"
    }

    private val voskCallbacks = object : VoskStt.Callbacks {
        override fun onPartial(text: String) {
            js("window.flowVoiceBridge&&window.flowVoiceBridge.onTranscript(${q(text)},0,false)")
        }
        override fun onFinal(text: String, confidence: Float) {
            voskListening = false
            js("window.flowVoiceBridge&&window.flowVoiceBridge.onTranscript(${q(text)},$confidence,true)")
        }
        override fun onSilence() {
            voskListening = false
            js("window.flowVoiceBridge&&window.flowVoiceBridge.onListenEnd('silence')")
        }
        override fun onError(message: String) {
            voskListening = false
            js("window.flowVoiceBridge&&window.flowVoiceBridge.onListenEnd(${q("error:$message")})")
        }
        override fun onModelState(language: String, state: String) {
            if (state == "downloading" || state == "ready" || state.startsWith("error")) {
                Toast.makeText(this@MainActivity, getString(R.string.grammar_model_state, language, state), Toast.LENGTH_SHORT).show()
            }
        }
    }

    private val listener = object : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) {}
        override fun onBeginningOfSpeech() {}
        override fun onRmsChanged(rmsdB: Float) {}
        override fun onBufferReceived(buffer: ByteArray?) {}
        override fun onEndOfSpeech() {}
        override fun onEvent(eventType: Int, params: Bundle?) {}

        override fun onPartialResults(partialResults: Bundle?) {
            val text = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull() ?: return
            if (text.isNotBlank()) js("window.flowVoiceBridge&&window.flowVoiceBridge.onTranscript(${q(text)},0,false)")
        }

        override fun onResults(results: Bundle?) {
            listening = false
            val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()
            val conf = results?.getFloatArray(SpeechRecognizer.CONFIDENCE_SCORES)?.firstOrNull() ?: 0.9f
            if (text.isNullOrBlank() && windowLeft()) restartListening(fresh = false)
            else if (text.isNullOrBlank()) js("window.flowVoiceBridge&&window.flowVoiceBridge.onListenEnd('silence')")
            else js("window.flowVoiceBridge&&window.flowVoiceBridge.onTranscript(${q(text)},${if (conf < 0) 0.9f else conf},true)")
        }

        override fun onError(error: Int) {
            listening = false
            val languageProblem = error == SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE || error == SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED
            if (languageProblem && !listenRetriedOnline && listenLanguage.isNotEmpty()) {
                // no offline pack for this language: try the online recogniser, and skip offline for it from now on
                offlineUnavailable.add(listenLanguage)
                beginListening(listenLanguage, preferOffline = false)
                return
            }
            val quiet = error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT
            if ((quiet || error == SpeechRecognizer.ERROR_RECOGNIZER_BUSY) && windowLeft()) {
                // nobody spoke yet (or the recogniser was still winding down): keep the same window open
                restartListening(fresh = error == SpeechRecognizer.ERROR_RECOGNIZER_BUSY)
                return
            }
            val reason = when (error) {
                SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "silence"
                SpeechRecognizer.ERROR_CLIENT -> "cancel"
                else -> "error:" + sttErrorName(error) // never "silence": the hub would retry and move on without anyone seeing why
            }
            js("window.flowVoiceBridge&&window.flowVoiceBridge.onListenEnd(${q(reason)})")
            if (error == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS) Toast.makeText(this@MainActivity, R.string.mic_denied, Toast.LENGTH_LONG).show()
            else if (reason.startsWith("error:")) Toast.makeText(this@MainActivity, getString(R.string.stt_failed, sttErrorName(error), localeOf(listenLanguage).displayName), Toast.LENGTH_LONG).show()
        }
    }
}
