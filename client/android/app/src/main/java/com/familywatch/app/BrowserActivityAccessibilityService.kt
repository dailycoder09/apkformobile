package com.familywatch.app

import android.accessibilityservice.AccessibilityService
import android.view.accessibility.AccessibilityEvent
import org.json.JSONObject
import java.net.URI
import java.util.UUID

// Reads Chrome's address bar only (enforced twice — once by packageNames in
// accessibility_service_config.xml, again here) to capture browsing activity without the
// persistent system indicator a VpnService approach requires. Reads nothing else: no other
// package's content, no other view within Chrome besides the url bar node.
//
// Known limitations (see project plan): Chrome only; when the address bar is unfocused,
// Chrome often shows a shortened/domain-level display rather than the full path, so most
// captures are domain-level with occasional full URLs when the user taps the bar; depends on
// Chrome's internal view ID staying "com.android.chrome:id/url_bar", which could change in a
// future Chrome update.
class BrowserActivityAccessibilityService : AccessibilityService() {

    companion object {
        private const val CHROME_PACKAGE = "com.android.chrome"
        private const val URL_BAR_VIEW_ID = "com.android.chrome:id/url_bar"
        private const val DEDUP_WINDOW_MS = 60_000L
        private var lastText: String? = null
        private var lastSeenAt = 0L
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event == null || event.packageName != CHROME_PACKAGE) return

        val root = rootInActiveWindow ?: return
        try {
            val nodes = root.findAccessibilityNodeInfosByViewId(URL_BAR_VIEW_ID)
            val text = nodes.firstOrNull()?.text?.toString()?.trim()
            nodes.forEach { it.recycle() }
            if (text.isNullOrBlank()) return

            val now = System.currentTimeMillis()
            if (text == lastText && now - lastSeenAt < DEDUP_WINDOW_MS) return
            lastText = text
            lastSeenAt = now

            reportVisit(text, now)
        } catch (ignored: Exception) {
        } finally {
            root.recycle()
        }
    }

    private fun reportVisit(raw: String, now: Long) {
        val domain = extractDomain(raw) ?: return
        try {
            val entry = JSONObject().apply {
                put("id", UUID.randomUUID().toString())
                put("domain", domain)
                put("url", raw)
                put("timestamp", now)
            }
            KeepAliveService.sendBrowsingEvent(applicationContext, entry)
        } catch (ignored: Exception) {
        }
    }

    // Chrome's url bar text isn't always a well-formed URI (e.g. just "example.com" with no
    // scheme when unfocused) — try parsing as-is, then retry with a scheme prefixed.
    private fun extractDomain(raw: String): String? {
        val candidate = if (raw.contains("://")) raw else "https://$raw"
        return try {
            URI(candidate).host?.removePrefix("www.")
        } catch (e: Exception) {
            // Fall back to a plain host-looking token (e.g. "example.com/search" -> "example.com")
            raw.trim().substringBefore('/').substringBefore(' ').takeIf { it.contains('.') }
        }
    }

    override fun onInterrupt() {}
}
