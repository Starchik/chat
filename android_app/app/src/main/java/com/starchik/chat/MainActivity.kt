package com.starchik.chat

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.ArrowBack
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.MoreVert
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material.icons.rounded.Web
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.starchik.chat.ui.theme.AccentBlue
import com.starchik.chat.ui.theme.AccentCyan
import com.starchik.chat.ui.theme.ChatTheme
import com.starchik.chat.ui.theme.GlassBorder
import com.starchik.chat.ui.theme.Night0
import com.starchik.chat.ui.theme.Night1
import com.starchik.chat.ui.theme.Night2
import com.starchik.chat.ui.theme.TextPrimary
import kotlinx.coroutines.launch

private const val PREFS_NAME = "chat_android_prefs"
private const val KEY_SERVER_URL = "server_url"
private const val DEFAULT_SERVER_URL = "https://nextnas.pp.ua"

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            ChatTheme {
                MessengerApp()
            }
        }
    }
}

@Composable
private fun MessengerApp() {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val prefs = remember {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    }
    val scope = rememberCoroutineScope()

    var serverUrl by rememberSaveable {
        mutableStateOf(
            prefs.getString(KEY_SERVER_URL, DEFAULT_SERVER_URL)
                ?.takeIf { it.isNotBlank() }
                ?: DEFAULT_SERVER_URL
        )
    }
    var urlInput by rememberSaveable { mutableStateOf(serverUrl) }
    var isSettingsOpen by rememberSaveable { mutableStateOf(false) }
    var menuExpanded by rememberSaveable { mutableStateOf(false) }
    var loading by rememberSaveable { mutableStateOf(true) }
    var hasLoadError by rememberSaveable { mutableStateOf(false) }
    var canGoBack by rememberSaveable { mutableStateOf(false) }
    var currentPageUrl by rememberSaveable { mutableStateOf(serverUrl) }

    var fileChooserCallback by remember { mutableStateOf<ValueCallback<Array<Uri>>?>(null) }
    var pendingWebPermission by remember { mutableStateOf<PermissionRequest?>(null) }

    val webViewHolder = remember { mutableStateOf<WebView?>(null) }

    val filePickerLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenMultipleDocuments()
    ) { uris ->
        val callback = fileChooserCallback
        fileChooserCallback = null
        if (callback == null) return@rememberLauncherForActivityResult
        if (uris.isNullOrEmpty()) {
            callback.onReceiveValue(null)
        } else {
            callback.onReceiveValue(uris.toTypedArray())
        }
    }

    val permissionsLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { grants ->
        val request = pendingWebPermission
        pendingWebPermission = null
        if (request == null) return@rememberLauncherForActivityResult

        val grantedResources = mutableListOf<String>()
        if (request.resources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE) &&
            grants[Manifest.permission.CAMERA] == true
        ) {
            grantedResources += PermissionRequest.RESOURCE_VIDEO_CAPTURE
        }
        if (request.resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE) &&
            grants[Manifest.permission.RECORD_AUDIO] == true
        ) {
            grantedResources += PermissionRequest.RESOURCE_AUDIO_CAPTURE
        }

        if (grantedResources.isNotEmpty()) {
            request.grant(grantedResources.toTypedArray())
        } else {
            request.deny()
        }
    }

    fun saveServerUrl(rawUrl: String) {
        val normalized = normalizeServerUrl(rawUrl)
        serverUrl = normalized
        urlInput = normalized
        scope.launch {
            prefs.edit().putString(KEY_SERVER_URL, normalized).apply()
        }
    }

    BackHandler(enabled = canGoBack && !isSettingsOpen) {
        webViewHolder.value?.goBack()
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(
                brush = Brush.linearGradient(
                    colors = listOf(Night0, Night1, Night2),
                )
            )
    ) {
        key(serverUrl) {
            MessengerWebContainer(
                url = serverUrl,
                loading = loading,
                hasLoadError = hasLoadError,
                onLoadingChange = { loading = it },
                onLoadErrorChange = { hasLoadError = it },
                onCanGoBackChange = { canGoBack = it },
                onCurrentUrlChange = { currentPageUrl = it },
                onProvideWebView = { webViewHolder.value = it },
                onAskFileChooser = { callback, mimeTypes ->
                    if (callback == null) return@MessengerWebContainer
                    fileChooserCallback?.onReceiveValue(null)
                    fileChooserCallback = callback
                    filePickerLauncher.launch(mimeTypes)
                },
                onWebPermissionRequest = { request, androidPermissions ->
                    if (androidPermissions.isEmpty()) {
                        request.grant(request.resources)
                        return@MessengerWebContainer
                    }
                    pendingWebPermission = request
                    permissionsLauncher.launch(androidPermissions.toTypedArray())
                }
            )
        }

        AnimatedVisibility(
            visible = loading,
            enter = fadeIn(),
            exit = fadeOut(),
            modifier = Modifier.align(Alignment.Center)
        ) {
            Surface(
                shape = RoundedCornerShape(24.dp),
                color = Color(0x8A101C3B),
                tonalElevation = 0.dp,
                modifier = Modifier
                    .border(1.dp, GlassBorder, RoundedCornerShape(24.dp))
                    .padding(1.dp)
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                    modifier = Modifier.padding(horizontal = 18.dp, vertical = 14.dp)
                ) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(20.dp),
                        strokeWidth = 2.4.dp,
                        color = AccentCyan
                    )
                    Text(text = context.getString(R.string.loading), color = TextPrimary)
                }
            }
        }

        AnimatedVisibility(
            visible = hasLoadError && !loading,
            enter = fadeIn(),
            exit = fadeOut(),
            modifier = Modifier
                .align(Alignment.Center)
                .padding(horizontal = 24.dp)
        ) {
            OfflineCard(
                onRetry = {
                    loading = true
                    hasLoadError = false
                    webViewHolder.value?.reload()
                }
            )
        }

        val showTopControls = isSettingsOpen || isAuthorizationPage(currentPageUrl)
        if (showTopControls) {
            TopControls(
                title = extractHost(serverUrl),
                canGoBack = canGoBack,
                onBack = { webViewHolder.value?.goBack() },
                onReload = { webViewHolder.value?.reload() },
                onOpenSettings = {
                    urlInput = serverUrl
                    isSettingsOpen = true
                },
                onDisconnect = {
                    webViewHolder.value?.loadUrl("about:blank")
                    loading = false
                },
                menuExpanded = menuExpanded,
                onMenuExpandedChange = { menuExpanded = it },
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .statusBarsPadding()
                    .padding(top = 8.dp, end = 16.dp)
            )
        }

        if (isSettingsOpen) {
            SettingsSheet(
                urlValue = urlInput,
                onUrlChange = { urlInput = it },
                onSave = {
                    saveServerUrl(urlInput)
                    isSettingsOpen = false
                    loading = true
                    hasLoadError = false
                },
                onCancel = {
                    urlInput = serverUrl
                    isSettingsOpen = false
                },
                modifier = Modifier.align(Alignment.BottomCenter)
            )
        }
    }

    DisposableEffect(Unit) {
        onDispose {
            webViewHolder.value?.destroy()
            webViewHolder.value = null
            fileChooserCallback?.onReceiveValue(null)
            fileChooserCallback = null
            pendingWebPermission?.deny()
            pendingWebPermission = null
        }
    }

    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            val webView = webViewHolder.value ?: return@LifecycleEventObserver
            when (event) {
                Lifecycle.Event.ON_RESUME -> {
                    webView.onResume()
                    webView.resumeTimers()
                    webView.evaluateJavascript(
                        "window.dispatchEvent(new Event('focus'));window.dispatchEvent(new Event('chatapp:presence-ping'));",
                        null
                    )
                }

                Lifecycle.Event.ON_PAUSE -> {
                    webView.onPause()
                    webView.pauseTimers()
                }

                else -> Unit
            }
        }

        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose {
            lifecycleOwner.lifecycle.removeObserver(observer)
        }
    }
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
private fun MessengerWebContainer(
    url: String,
    loading: Boolean,
    hasLoadError: Boolean,
    onLoadingChange: (Boolean) -> Unit,
    onLoadErrorChange: (Boolean) -> Unit,
    onCanGoBackChange: (Boolean) -> Unit,
    onCurrentUrlChange: (String) -> Unit,
    onProvideWebView: (WebView) -> Unit,
    onAskFileChooser: (ValueCallback<Array<Uri>>?, Array<String>) -> Unit,
    onWebPermissionRequest: (PermissionRequest, List<String>) -> Unit,
) {
    val context = LocalContext.current
    val activity = context as? ComponentActivity

    AndroidView(
        factory = { viewContext ->
            WebView(viewContext).apply {
                layoutParams = ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT
                )
                overScrollMode = WebView.OVER_SCROLL_NEVER
                isVerticalScrollBarEnabled = false
                isHorizontalScrollBarEnabled = false

                val cookieManager = CookieManager.getInstance()
                cookieManager.setAcceptCookie(true)
                cookieManager.setAcceptThirdPartyCookies(this, true)

                settings.apply {
                    javaScriptEnabled = true
                    domStorageEnabled = true
                    databaseEnabled = true
                    allowFileAccess = true
                    allowContentAccess = true
                    mediaPlaybackRequiresUserGesture = false
                    cacheMode = WebSettings.LOAD_DEFAULT
                    mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
                    userAgentString = "${userAgentString} ChatAndroid/1.0"
                }

                webViewClient = object : WebViewClient() {
                    override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                        onLoadingChange(true)
                        onLoadErrorChange(false)
                        onCurrentUrlChange(url ?: this@apply.url.orEmpty())
                    }

                    override fun onPageFinished(view: WebView?, url: String?) {
                        onLoadingChange(false)
                        onCanGoBackChange(view?.canGoBack() == true)
                        onCurrentUrlChange(url ?: view?.url.orEmpty())
                        view?.evaluateJavascript(
                            "(function(){if(document.getElementById('__android_no_scrollbar'))return;var s=document.createElement('style');s.id='__android_no_scrollbar';s.textContent='*::-webkit-scrollbar{width:0!important;height:0!important}';document.head&&document.head.appendChild(s);})();",
                            null
                        )
                    }

                    override fun shouldOverrideUrlLoading(
                        view: WebView?,
                        request: WebResourceRequest?
                    ): Boolean {
                        val target = request?.url?.toString().orEmpty()
                        if (target.startsWith("http://") || target.startsWith("https://")) {
                            return false
                        }
                        runCatching {
                            context.startActivity(Intent(Intent.ACTION_VIEW, request?.url))
                        }
                        return true
                    }

                    override fun onReceivedError(
                        view: WebView?,
                        request: WebResourceRequest?,
                        error: WebResourceError?
                    ) {
                        if (request?.isForMainFrame == true) {
                            onLoadingChange(false)
                            onLoadErrorChange(true)
                        }
                    }

                    override fun onReceivedHttpError(
                        view: WebView?,
                        request: WebResourceRequest?,
                        errorResponse: WebResourceResponse?
                    ) {
                        if (request?.isForMainFrame == true && (errorResponse?.statusCode ?: 200) >= 400) {
                            onLoadErrorChange(true)
                            onLoadingChange(false)
                        }
                    }
                }

                webChromeClient = object : WebChromeClient() {
                    override fun onPermissionRequest(request: PermissionRequest?) {
                        if (request == null) return
                        val hostActivity = activity ?: run {
                            request.deny()
                            return
                        }

                        hostActivity.runOnUiThread {
                            val requiredPermissions = mapWebResourcesToAndroidPermissions(
                                context = hostActivity,
                                resources = request.resources
                            )
                            if (requiredPermissions.isEmpty()) {
                                request.grant(request.resources)
                            } else {
                                onWebPermissionRequest(request, requiredPermissions)
                            }
                        }
                    }

                    override fun onShowFileChooser(
                        webView: WebView?,
                        filePathCallback: ValueCallback<Array<Uri>>?,
                        fileChooserParams: FileChooserParams?
                    ): Boolean {
                        val accept = fileChooserParams
                            ?.acceptTypes
                            ?.mapNotNull { type -> type?.trim()?.takeIf { it.isNotBlank() } }
                            ?.toTypedArray()
                            ?.takeIf { it.isNotEmpty() }
                            ?: arrayOf("*/*")

                        onAskFileChooser(filePathCallback, accept)
                        return true
                    }
                }

                setDownloadListener { downloadUrl, _, _, _, _ ->
                    runCatching {
                        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(downloadUrl)))
                    }
                }

                loadUrl(url)
                onCurrentUrlChange(url)
                onProvideWebView(this)
            }
        },
        update = { view ->
            onProvideWebView(view)
            if (!hasLoadError && !loading && view.url.isNullOrBlank()) {
                view.loadUrl(url)
            }
            onCanGoBackChange(view.canGoBack())
            onCurrentUrlChange(view.url.orEmpty())
        },
        modifier = Modifier
            .fillMaxSize()
            .statusBarsPadding()
            .navigationBarsPadding()
    )
}

@Composable
private fun TopControls(
    title: String,
    canGoBack: Boolean,
    onBack: () -> Unit,
    onReload: () -> Unit,
    onOpenSettings: () -> Unit,
    onDisconnect: () -> Unit,
    menuExpanded: Boolean,
    onMenuExpandedChange: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
) {
    Surface(
        modifier = modifier,
        shape = RoundedCornerShape(20.dp),
        color = Color(0x73122145),
        tonalElevation = 0.dp
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            modifier = Modifier
                .border(1.dp, GlassBorder, RoundedCornerShape(20.dp))
                .padding(horizontal = 10.dp, vertical = 6.dp)
        ) {
            if (canGoBack) {
                IconButton(onClick = onBack) {
                    Icon(
                        imageVector = Icons.Rounded.ArrowBack,
                        contentDescription = stringResourceSafe(R.string.back),
                        tint = TextPrimary
                    )
                }
            }
            Text(
                text = title,
                color = TextPrimary,
                fontSize = 13.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false)
            )
            Box {
                IconButton(onClick = { onMenuExpandedChange(true) }) {
                    Icon(
                        imageVector = Icons.Rounded.MoreVert,
                        contentDescription = stringResourceSafe(R.string.menu),
                        tint = TextPrimary
                    )
                }
                DropdownMenu(
                    expanded = menuExpanded,
                    onDismissRequest = { onMenuExpandedChange(false) }
                ) {
                    DropdownMenuItem(
                        text = { Text(stringResourceSafe(R.string.reload)) },
                        leadingIcon = { Icon(Icons.Rounded.Refresh, null) },
                        onClick = {
                            onMenuExpandedChange(false)
                            onReload()
                        }
                    )
                    DropdownMenuItem(
                        text = { Text(stringResourceSafe(R.string.open_settings)) },
                        leadingIcon = { Icon(Icons.Rounded.Settings, null) },
                        onClick = {
                            onMenuExpandedChange(false)
                            onOpenSettings()
                        }
                    )
                    DropdownMenuItem(
                        text = { Text(stringResourceSafe(R.string.disconnect)) },
                        leadingIcon = { Icon(Icons.Rounded.Close, null) },
                        onClick = {
                            onMenuExpandedChange(false)
                            onDisconnect()
                        }
                    )
                }
            }
        }
    }
}

@Composable
private fun SettingsSheet(
    urlValue: String,
    onUrlChange: (String) -> Unit,
    onSave: () -> Unit,
    onCancel: () -> Unit,
    modifier: Modifier = Modifier
) {
    Surface(
        modifier = modifier
            .fillMaxWidth()
            .navigationBarsPadding()
            .imePadding()
            .padding(horizontal = 12.dp, vertical = 12.dp),
        shape = RoundedCornerShape(26.dp),
        color = Color(0xCC101E40),
        tonalElevation = 0.dp
    ) {
        Column(
            modifier = Modifier
                .border(1.dp, GlassBorder, RoundedCornerShape(26.dp))
                .padding(16.dp)
        ) {
            Text(
                text = stringResourceSafe(R.string.open_settings),
                style = MaterialTheme.typography.titleMedium,
                color = TextPrimary
            )
            Spacer(modifier = Modifier.height(12.dp))
            OutlinedTextField(
                value = urlValue,
                onValueChange = onUrlChange,
                modifier = Modifier.fillMaxWidth(),
                label = { Text(stringResourceSafe(R.string.server_address)) },
                placeholder = { Text(stringResourceSafe(R.string.server_address_hint)) },
                maxLines = 1
            )
            Spacer(modifier = Modifier.height(16.dp))
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.fillMaxWidth()
            ) {
                GlassActionButton(
                    icon = Icons.Rounded.Close,
                    label = stringResourceSafe(R.string.cancel),
                    onClick = onCancel,
                    modifier = Modifier.weight(1f)
                )
                GlassActionButton(
                    icon = Icons.Rounded.Check,
                    label = stringResourceSafe(R.string.save),
                    onClick = onSave,
                    modifier = Modifier.weight(1f),
                    accent = true
                )
            }
        }
    }
}

@Composable
private fun OfflineCard(onRetry: () -> Unit) {
    Surface(
        shape = RoundedCornerShape(24.dp),
        color = Color(0xBF101E40),
        tonalElevation = 0.dp,
        modifier = Modifier.fillMaxWidth()
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(12.dp),
            modifier = Modifier
                .border(1.dp, GlassBorder, RoundedCornerShape(24.dp))
                .padding(20.dp)
        ) {
            Icon(
                imageVector = Icons.Rounded.Web,
                contentDescription = null,
                tint = AccentBlue,
                modifier = Modifier.size(34.dp)
            )
            Text(
                text = stringResourceSafe(R.string.offline_message),
                color = TextPrimary,
                style = MaterialTheme.typography.titleMedium
            )
            GlassActionButton(
                icon = Icons.Rounded.Refresh,
                label = stringResourceSafe(R.string.retry),
                onClick = onRetry,
                accent = true
            )
        }
    }
}

@Composable
private fun GlassActionButton(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    accent: Boolean = false
) {
    val shape = RoundedCornerShape(16.dp)
    val bgBrush = if (accent) {
        Brush.horizontalGradient(colors = listOf(AccentBlue, AccentCyan))
    } else {
        Brush.horizontalGradient(colors = listOf(Color(0x66254074), Color(0x66304B7E)))
    }

    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.Center,
        modifier = modifier
            .clip(shape)
            .background(bgBrush)
            .border(1.dp, GlassBorder, shape)
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
                onClick = onClick
            )
            .padding(horizontal = 14.dp, vertical = 10.dp)
    ) {
        Icon(icon, contentDescription = null, tint = if (accent) Night0 else TextPrimary)
        Spacer(modifier = Modifier.size(8.dp))
        Text(
            text = label,
            color = if (accent) Night0 else TextPrimary,
            fontWeight = FontWeight.SemiBold
        )
    }
}

private fun normalizeServerUrl(raw: String): String {
    val trimmed = raw.trim()
    if (trimmed.isBlank()) return DEFAULT_SERVER_URL
    val withProtocol = if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
        trimmed
    } else {
        "https://$trimmed"
    }
    return withProtocol.trimEnd('/')
}

private fun extractHost(url: String): String {
    return runCatching { Uri.parse(url).host.orEmpty() }
        .getOrElse { "" }
        .ifBlank { url }
}

private fun isAuthorizationPage(rawUrl: String): Boolean {
    if (rawUrl.isBlank()) return false
    val path = runCatching { Uri.parse(rawUrl).path.orEmpty().lowercase() }
        .getOrDefault("")
    return path == "/login" || path == "/register" || path.startsWith("/auth")
}

private fun mapWebResourcesToAndroidPermissions(
    context: Context,
    resources: Array<String>
): List<String> {
    val needed = mutableSetOf<String>()
    if (resources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE) &&
        ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED
    ) {
        needed += Manifest.permission.CAMERA
    }
    if (resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE) &&
        ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED
    ) {
        needed += Manifest.permission.RECORD_AUDIO
    }
    return needed.toList()
}

@Composable
private fun stringResourceSafe(id: Int): String {
    return LocalContext.current.getString(id)
}
