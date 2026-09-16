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
class VoskStt(private val context: Context, private val callbacks: Callbacks) {
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
                val conn = URL("$MODEL_BASE$name.zip").openConnection() as HttpURLConnection
                conn.connectTimeout = 15000
                conn.readTimeout = 60000
                if (conn.responseCode != 200) throw IllegalStateException("HTTP ${conn.responseCode} for $name")
                conn.inputStream.use { input -> FileOutputStream(tmp).use { input.copyTo(it) } }
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

    /** Listen for `grammar` (a JSON array of phrases) until an utterance ends, `maxMs` passes, or stop() is called. */
    @SuppressLint("MissingPermission")
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
        val minBuf = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val record = try {
            AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(minBuf, SAMPLE_RATE / 2))
        } catch (e: Exception) {
            rec.close()
            callbacks.onError("microphone: ${e.message}")
            return false
        }
        if (record.state != AudioRecord.STATE_INITIALIZED) {
            record.release()
            rec.close()
            callbacks.onError("microphone not available")
            return false
        }
        val s = Session(rec, record, maxMs.toLong())
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

    private inner class Session(val rec: Recognizer, val record: AudioRecord, val maxMs: Long) {
        @Volatile var stopping = false
        val thread = Thread({ run() }, "vosk-listen")

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
                if (!delivered) deliver(rec.finalResult)
            } catch (e: Exception) {
                Log.w(TAG, "listen failed", e)
                main.post { callbacks.onError("grammar recogniser: ${e.message}") }
            } finally {
                runCatching { record.stop() }
                record.release()
                rec.close()
                if (session === this) session = null
            }
        }

        private fun deliver(json: String) {
            val o = JSONObject(json)
            val text = clean(o.optString("text"))
            if (text.isEmpty()) {
                main.post { callbacks.onSilence() }
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
