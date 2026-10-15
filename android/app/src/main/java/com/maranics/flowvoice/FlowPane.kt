package com.maranics.flowvoice

import android.annotation.SuppressLint
import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Environment
import android.provider.MediaStore
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.TextView
import android.widget.Toast
import androidx.core.content.FileProvider
import java.io.File

/**
 * The station's Maranics Flow app (`Station.flowUrl`, set in Admin → Stations) in a second WebView over the voice
 * client. The voice WebView stays underneath, visible to Chromium, so the voice, the mic and the buttons keep working
 * while Flow is on screen. Loaded as soon as the page reports the address (after the station QR), shown with the
 * "Flow" button in the client header or the long-press menu; the floating "Flow Voice" pill and Back go back.
 *
 * Flow's offline queue lives in this WebView's storage: never clear its cache, storage or cookies, never pause it.
 */
class FlowPane(
    private val activity: MainActivity,
    private val root: FrameLayout,
    /** Open a picker / camera intent and hand the result back. */
    private val pick: (Intent, (Int, Intent?) -> Unit) -> Unit,
    /** Ask for an Android permission (camera, microphone), then continue. */
    private val permission: (String, (Boolean) -> Unit) -> Unit,
    private val onShown: (Boolean) -> Unit,
) {
    private var view: WebView? = null
    private var pill: TextView? = null
    var url: String? = null
        private set
    val shown: Boolean get() = view?.visibility == View.VISIBLE

    /** The station's Flow address changed (or the app started with one): load it, or drop the pane when there is none. */
    fun setUrl(next: String?) {
        val clean = next?.trim()?.takeIf { it.startsWith("https://") || it.startsWith("http://") }
        if (clean == url && (clean == null || view != null)) return
        url = clean
        if (clean == null) {
            show(false)
            view?.let { root.removeView(it); it.destroy() }
            view = null
            return
        }
        ensure().loadUrl(clean)
    }

    fun show(on: Boolean) {
        val v = if (on) (view ?: url?.let { u -> ensure().also { it.loadUrl(u) } } ?: return) else view ?: return
        v.visibility = if (on) View.VISIBLE else View.GONE
        pill?.visibility = v.visibility
        if (on) v.requestFocus()
        onShown(on)
    }

    /** Back inside Flow; false = nothing left there (the caller goes back to the voice client). */
    fun back(): Boolean {
        val v = view ?: return false
        if (!shown) return false
        if (v.canGoBack()) v.goBack() else show(false)
        return true
    }

    fun reload() = view?.reload()

    fun destroy() {
        view?.destroy()
        view = null
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun ensure(): WebView {
        view?.let { return it }
        val w = WebView(activity)
        with(w.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            useWideViewPort = true
            loadWithOverviewMode = true
            allowFileAccess = false
            setSupportMultipleWindows(false) // window.open (picture view) opens in place; Back returns
        }
        CookieManager.getInstance().setAcceptThirdPartyCookies(w, true) // sign-in at UserManagement
        w.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                // barcode scan (camera) and audio recording tasks: hand out what Android allows, ask once if needed
                val wanted = request.resources.filter { it == PermissionRequest.RESOURCE_VIDEO_CAPTURE || it == PermissionRequest.RESOURCE_AUDIO_CAPTURE }
                if (wanted.isEmpty()) return request.deny()
                val perms = wanted.map { if (it == PermissionRequest.RESOURCE_VIDEO_CAPTURE) android.Manifest.permission.CAMERA else android.Manifest.permission.RECORD_AUDIO }
                askAll(perms) { granted -> activity.runOnUiThread { if (granted) request.grant(wanted.toTypedArray()) else request.deny() } }
            }

            override fun onShowFileChooser(webView: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                choose(params, callback)
                return true
            }
        }
        w.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val u = request.url
                if (u.scheme == "http" || u.scheme == "https") return false // Flow and its sign-in stay here
                // tel:, mailto:, intent: … go to the system
                runCatching { activity.startActivity(Intent(Intent.ACTION_VIEW, u)) }
                return true
            }
        }
        w.setDownloadListener { link, userAgent, disposition, mime, _ ->
            if (!link.startsWith("http")) {
                Toast.makeText(activity, R.string.flow_download_unsupported, Toast.LENGTH_LONG).show()
                return@setDownloadListener
            }
            val name = URLUtil.guessFileName(link, disposition, mime)
            val req = DownloadManager.Request(Uri.parse(link))
                .setMimeType(mime)
                .addRequestHeader("Cookie", CookieManager.getInstance().getCookie(link) ?: "")
                .addRequestHeader("User-Agent", userAgent)
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
            runCatching { (activity.getSystemService(android.content.Context.DOWNLOAD_SERVICE) as DownloadManager).enqueue(req) }
                .onSuccess { Toast.makeText(activity, activity.getString(R.string.flow_downloading, name), Toast.LENGTH_SHORT).show() }
        }
        w.visibility = View.GONE
        root.addView(w, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        view = w
        addPill()
        return w
    }

    /** "◀ Flow Voice": always reachable over Flow, whatever the page shows. */
    private fun addPill() {
        if (pill != null) return
        val d = activity.resources.displayMetrics.density
        val p = TextView(activity).apply {
            text = activity.getString(R.string.flow_back)
            setTextColor(Color.WHITE)
            textSize = 15f
            setPadding((14 * d).toInt(), (10 * d).toInt(), (16 * d).toInt(), (10 * d).toInt())
            background = GradientDrawable().apply { cornerRadius = 24 * d; setColor(Color.argb(225, 6, 24, 45)) }
            elevation = 8 * d
            visibility = View.GONE
            setOnClickListener { show(false) }
        }
        root.addView(p, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.START).apply {
            setMargins((12 * d).toInt(), 0, 0, (16 * d).toInt())
        })
        pill = p
    }

    private fun askAll(perms: List<String>, then: (Boolean) -> Unit) {
        val left = perms.distinct().toMutableList()
        fun next(ok: Boolean) {
            if (!ok) return then(false)
            val p = left.removeFirstOrNull() ?: return then(true)
            permission(p) { next(it) }
        }
        next(true)
    }

    /** Photo and file inputs: the camera straight away for `capture`, otherwise a picker that also offers the camera. */
    private fun choose(params: WebChromeClient.FileChooserParams, callback: ValueCallback<Array<Uri>>) {
        val images = params.acceptTypes.all { it.isBlank() } || params.acceptTypes.any { it.startsWith("image") || it == "*/*" }
        val go = { camera: Boolean ->
            var photo: Uri? = null
            val cam = if (camera && images) runCatching {
                val dir = File(activity.cacheDir, "flow-camera").apply { mkdirs() }
                val file = File.createTempFile("photo-", ".jpg", dir)
                photo = FileProvider.getUriForFile(activity, "${activity.packageName}.files", file)
                Intent(MediaStore.ACTION_IMAGE_CAPTURE).putExtra(MediaStore.EXTRA_OUTPUT, photo).addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            }.getOrNull() else null
            val content = params.createIntent().apply { if (params.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true) }
            val intent = if (params.isCaptureEnabled && cam != null) cam else Intent.createChooser(content, null).apply { if (cam != null) putExtra(Intent.EXTRA_INITIAL_INTENTS, arrayOf(cam)) }
            try {
                pick(intent) { code, data ->
                    val uris: Array<Uri>? = if (code != android.app.Activity.RESULT_OK) null else {
                        val clip = data?.clipData
                        when {
                            clip != null && clip.itemCount > 0 -> Array(clip.itemCount) { clip.getItemAt(it).uri }
                            data?.data != null -> arrayOf(data.data!!)
                            photo != null -> arrayOf(photo!!)
                            else -> null
                        }
                    }
                    callback.onReceiveValue(uris)
                }
            } catch (_: ActivityNotFoundException) {
                callback.onReceiveValue(null)
            }
        }
        if (images) permission(android.Manifest.permission.CAMERA) { granted -> activity.runOnUiThread { go(granted) } } else go(false)
    }
}
