package com.maranics.flowvoice

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Handler
import android.os.Looper
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import org.vosk.Model
import org.vosk.Recognizer
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import java.util.zip.ZipInputStream

/**
 * Grammar-restricted offline recognition (Vosk). The hub sends the vocabulary of each listen window
 * (yes/no, control words, numbers, option titles, the item name); the recogniser can only return those
 * words, so engine-room chatter comes back as nothing instead of as a wrong answer. Free-text items keep
 * using the platform recogniser (MainActivity.beginListening).
 *
 * Models live in filesDir/vosk/<lang>. English ships in the APK (assets/vosk/en.zip, fetched at build
 * time); other languages are downloaded once from alphacephei.com when the crew picks them.
 */
class VoskStt(private val context: Context, private val callbacks: Callbacks, private val hubUrl: () -> String? = { null }) {
    interface Callbacks {
        fun onPartial(text: String)
        fun onFinal(text: String, confidence: Float)
        fun onSilence()
        fun onError(message: String)
        fun onModelState(language: String, state: String)
    }

    companion object {
        private const val TAG = "VoskStt"
        private const val SAMPLE_RATE = 16000
        /** Small models: 40–50 MB each; Swedish is the big one (Rhasspy build, ~290 MB) and only ever downloaded on request. */
        val MODELS: Map<String, String> = mapOf(
            "en" to "vosk-model-small-en-us-0.15",
            "sv" to "vosk-model-small-sv-rhasspy-0.15",
            "de" to "vosk-model-small-de-0.15",
            "fr" to "vosk-model-small-fr-0.22",
        )
        private const val MODEL_BASE = "https://alphacephei.com/vosk/models/"

        fun langKey(language: String): String = language.lowercase().take(2).let { if (it == "nb") "no" else it }
    }

    private val io = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private val models = HashMap<String, Model>()
    private val preparing = HashSet<String>()
    @Volatile private var session: Session? = null

    fun hasModel(language: String): Boolean = models.containsKey(langKey(language))

    /** Is there a grammar model for this language at all (loaded or not)? */
    fun supports(language: String): Boolean = langKey(language) in MODELS

    /** Load (unpack / download first if needed) the model for `language` in the background. Safe to call often. */
    fun prepare(language: String) {
        val key = langKey(language)
        if (models.containsKey(key) || key !in MODELS) return
        synchronized(preparing) { if (!preparing.add(key)) return }
        io.execute {
            try {
                val dir = ensureModelDir(key)
                if (dir == null) {
                    main.post { callbacks.onModelState(key, "unavailable") }
                } else {
                    main.post { callbacks.onModelState(key, "loading") }
                    val m = Model(dir.absolutePath)
                    models[key] = m
                    main.post { callbacks.onModelState(key, "ready") }
                }
            } catch (e: Exception) {
                Log.w(TAG, "model $key failed", e)
                main.post { callbacks.onModelState(key, "error: ${e.message}") }
            } finally {
                synchronized(preparing) { preparing.remove(key) }
            }
        }
    }

    /** filesDir/vosk/<key> with a usable model inside, from assets or the download, or null when there is none. */
    private fun ensureModelDir(key: String): File? {
        val name = MODELS[key] ?: return null
        val root = File(context.filesDir, "vosk")
        val dir = File(root, key)
        if (File(dir, "am").isDirectory || File(dir, "graph").isDirectory) return dir
        root.mkdirs()
        val tmp = File(root, "$key.zip")
        try {
            val fromAssets = runCatching { context.assets.open("vosk/$key.zip") }.getOrNull()
            if (fromAssets != null) {
                fromAssets.use { input -> FileOutputStream(tmp).use { input.copyTo(it) } }
            } else {
                main.post { callbacks.onModelState(key, "downloading") }
                // the hub first (a vessel network has no internet; the hub keeps a copy), then the public mirror
                val sources = listOfNotNull(hubUrl()?.trimEnd('/')?.let { "$it/models/vosk/$key.zip" }, "$MODEL_BASE$name.zip")
                var last: Exception? = null
                var done = false
                for (src in sources) {
                    try {
                        val conn = URL(src).openConnection() as HttpURLConnection
                        conn.connectTimeout = 15000
                        conn.readTimeout = 300000 // the hub may be fetching its own copy first
                        if (conn.responseCode != 200) throw IllegalStateException("HTTP ${conn.responseCode} from $src")
                        conn.inputStream.use { input -> FileOutputStream(tmp).use { input.copyTo(it) } }
                        done = true
                        break
                    } catch (e: Exception) {
                        Log.w(TAG, "model $key: $src failed", e)
                        last = e
                    }
                }
                if (!done) throw last ?: IllegalStateException("no source for $name")
            }
            unzip(tmp, dir, name)
            return dir
        } finally {
            tmp.delete()
        }
    }

    /** The zip has one top-level folder (the model name); flatten it into `dir`. */
    private fun unzip(zip: File, dir: File, top: String) {
        dir.deleteRecursively()
        dir.mkdirs()
        ZipInputStream(zip.inputStream().buffered()).use { z ->
            var e = z.nextEntry
            while (e != null) {
                val rel = e.name.removePrefix("$top/").removePrefix("./")
                if (rel.isNotEmpty() && !rel.contains("..")) {
                    val out = File(dir, rel)
                    if (e.isDirectory) out.mkdirs()
                    else {
                        out.parentFile?.mkdirs()
                        FileOutputStream(out).use { z.copyTo(it) }
                    }
                }
                z.closeEntry()
                e = z.nextEntry
            }
        }
    }

    /** Set by the PWA from the hub's boot info: may a window the phone could not transcribe be sent to the hub? */
    @Volatile var serverBackup = false

    /** Listen for `grammar` (a JSON array of phrases) until an utterance ends, `maxMs` passes, or stop() is called. */
    fun start(language: String, grammarJson: String, maxMs: Int): Boolean {
        val model = models[langKey(language)] ?: return false
        stop()
        val phrases = runCatching { JSONArray(grammarJson) }.getOrElse { JSONArray() }
        if (phrases.length() == 0) return false
        val withUnk = JSONArray().also { arr ->
            for (i in 0 until phrases.length()) arr.put(phrases.getString(i))
            arr.put("[unk]") // out-of-grammar speech maps here instead of to the nearest allowed word
        }
        val rec = try {
            Recognizer(model, SAMPLE_RATE.toFloat(), withUnk.toString()).also { it.setWords(true) }
        } catch (e: Exception) {
            callbacks.onError("grammar recogniser: ${e.message}")
            return false
        }
        return open(rec, language, promptOf(phrases), maxMs)
    }

    /**
     * No model for this language on the phone (Norwegian): record the utterance with a plain energy endpointer
     * (no recogniser running, next to no CPU) and let the hub transcribe it. `hintsJson` = words the hub expects.
     */
    fun startServer(language: String, hintsJson: String, maxMs: Int): Boolean {
        if (!serverBackup || hubUrl().isNullOrBlank()) return false
        stop()
        return open(null, language, promptOf(runCatching { JSONArray(hintsJson) }.getOrElse { JSONArray() }), maxMs)
    }

    private fun promptOf(phrases: JSONArray): String {
        val out = ArrayList<String>()
        for (i in 0 until minOf(phrases.length(), 40)) out.add(phrases.optString(i))
        return out.filter { it.isNotBlank() }.joinToString(", ").take(400)
    }

    @SuppressLint("MissingPermission")
    private fun open(rec: Recognizer?, language: String, prompt: String, maxMs: Int): Boolean {
        val minBuf = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val record = try {
            AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(minBuf, SAMPLE_RATE / 2))
        } catch (e: Exception) {
            rec?.close()
            callbacks.onError("microphone: ${e.message}")
            return false
        }
        if (record.state != AudioRecord.STATE_INITIALIZED) {
            record.release()
            rec?.close()
            callbacks.onError("microphone not available")
            return false
        }
        val s = Session(rec, record, maxMs.toLong(), language, prompt)
        session = s
        s.thread.start()
        return true
    }

    /** Close the window: the utterance so far (if any) is delivered as final. */
    fun stop() {
        val s = session ?: return
        session = null
        s.stopping = true
    }

    fun shutdown() {
        stop()
        io.execute { models.values.forEach { it.close() }; models.clear() }
    }

    /**
     * One listen window. `rec` = the grammar recogniser, or null when the hub transcribes (server mode).
     * The voiced part of the window (plus 300 ms before it) is kept in memory, at most 7.5 s = 240 kB, only so it can be
     * sent to the hub when nothing was recognised here; it is dropped when the window ends.
     */
    private inner class Session(val rec: Recognizer?, val record: AudioRecord, val maxMs: Long, val language: String, val prompt: String) {
        @Volatile var stopping = false
        val thread = Thread({ run() }, "vosk-listen")
        private val keep = serverBackup && !hubUrl().isNullOrBlank()
        private val pcm = java.io.ByteArrayOutputStream(if (keep) 96_000 else 0)
        private val preRoll = java.util.ArrayDeque<ByteArray>()
        private var floor = -1.0
        private var voiced = 0
        private var quiet = 0

        /** Energy gate with a slow noise floor: engine rumble raises the floor, a voice stands out above it. */
        private fun track(buf: ShortArray, n: Int) {
            var sum = 0.0
            for (i in 0 until n) sum += buf[i].toDouble() * buf[i]
            val rms = Math.sqrt(sum / n)
            if (floor < 0) floor = rms
            val loud = rms > maxOf(350.0, floor * 2.2)
            if (loud) { voiced++; quiet = 0 } else { quiet++; floor = floor * 0.95 + rms * 0.05 }
            if (!keep) return
            val bytes = ByteArray(n * 2)
            for (i in 0 until n) { bytes[2 * i] = (buf[i].toInt() and 0xff).toByte(); bytes[2 * i + 1] = (buf[i].toInt() shr 8).toByte() }
            if (voiced == 0) {
                preRoll.addLast(bytes)
                if (preRoll.size > 3) preRoll.removeFirst()
            } else if (pcm.size() < SAMPLE_RATE * 15) { // 7.5 s: what the hub's recogniser takes
                while (preRoll.isNotEmpty()) pcm.write(preRoll.removeFirst())
                pcm.write(bytes)
            }
        }

        private fun run() {
            val buf = ShortArray(SAMPLE_RATE / 10) // 100 ms
            val started = System.currentTimeMillis()
            var lastPartial = ""
            var delivered = false
            try {
                record.startRecording()
                while (!stopping && System.currentTimeMillis() - started < maxMs) {
                    val n = record.read(buf, 0, buf.size)
                    if (n <= 0) continue
                    track(buf, n)
                    if (rec == null) {
                        if (voiced >= 2 && quiet >= 8) break // 0.8 s of quiet after speech: the answer is over
                        continue
                    }
                    if (rec.acceptWaveForm(buf, n)) {
                        deliver(rec.result)
                        delivered = true
                        break
                    }
                    val p = JSONObject(rec.partialResult).optString("partial").trim()
                    if (p.isNotEmpty() && p != lastPartial && !p.all { it == '[' || it == ']' || it.isLetter() && p == "[unk]" }) {
                        lastPartial = p
                        val clean = clean(p)
                        if (clean.isNotEmpty()) main.post { callbacks.onPartial(clean) }
                    }
                }
                runCatching { record.stop() } // free the mic before any upload
                if (!delivered) deliver(rec?.finalResult ?: "{}")
            } catch (e: Exception) {
                Log.w(TAG, "listen failed", e)
                main.post { callbacks.onError("grammar recogniser: ${e.message}") }
            } finally {
                runCatching { record.stop() }
                record.release()
                rec?.close()
                if (session === this) session = null
            }
        }

        /** Ask the hub. Returns true when it delivered a transcript. */
        private fun askHub(): Boolean {
            if (!keep || voiced < 3 || pcm.size() < 6400) return false
            val hub = hubUrl()?.trimEnd('/') ?: return false
            main.post { callbacks.onPartial("…") }
            return try {
                val q = "language=${java.net.URLEncoder.encode(langKey(language), "UTF-8")}&prompt=${java.net.URLEncoder.encode(prompt, "UTF-8")}"
                val conn = URL("$hub/api/stt?$q").openConnection() as HttpURLConnection
                conn.requestMethod = "POST"
                conn.doOutput = true
                conn.connectTimeout = 4000
                conn.readTimeout = 25000
                conn.setRequestProperty("Content-Type", "application/octet-stream")
                android.webkit.CookieManager.getInstance().getCookie(hub)?.let { conn.setRequestProperty("Cookie", it) }
                val body = pcm.toByteArray()
                conn.setFixedLengthStreamingMode(body.size)
                conn.outputStream.use { it.write(body) }
                if (conn.responseCode != 200) throw IllegalStateException("HTTP ${conn.responseCode}")
                val o = JSONObject(conn.inputStream.bufferedReader().use { it.readText() })
                val text = o.optString("text").trim()
                if (text.isEmpty()) false
                else {
                    val conf = o.optDouble("confidence", 0.85).toFloat()
                    main.post { callbacks.onFinal(text, conf) }
                    true
                }
            } catch (e: Exception) {
                Log.w(TAG, "hub stt failed", e)
                false
            } finally {
                pcm.reset()
            }
        }

        private fun deliver(json: String) {
            val o = JSONObject(json)
            val text = clean(o.optString("text"))
            if (text.isEmpty()) {
                // nothing in the grammar matched (or no recogniser here): if somebody did speak, the hub gets one try
                if (!askHub()) main.post { callbacks.onSilence() }
                return
            }
            // per-word confidences when setWords(true) produced them
            val words = o.optJSONArray("result")
            var conf = 0.9f
            if (words != null && words.length() > 0) {
                var sum = 0.0
                var n = 0
                for (i in 0 until words.length()) {
                    val w = words.getJSONObject(i)
                    if (w.optString("word") == "[unk]") continue
                    sum += w.optDouble("conf", 0.9)
                    n++
                }
                if (n > 0) conf = (sum / n).toFloat()
            }
            main.post { callbacks.onFinal(text, conf) }
        }

        private fun clean(t: String): String = t.replace("[unk]", " ").replace(Regex("\\s+"), " ").trim()
    }
}
