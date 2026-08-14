package com.familywatch.app

import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import org.json.JSONObject
import java.util.UUID

// Reads notifications from a whitelist of banking/UPI apps only, extracts completed
// transactions (amount + debit/credit), and hands them to KeepAliveService to be sent
// over the already-authenticated background WebSocket. Everything else is dropped
// immediately without being read further — see targetPackages below.
class TransactionNotificationListener : NotificationListenerService() {

    companion object {
        // package name -> display label used as the transaction's bank/account name
        private val targetPackages = mapOf(
            "com.google.android.apps.nbu.paisa.user" to "Google Pay",
            "com.phonepe.app" to "PhonePe",
            "net.one97.paytm" to "Paytm",
            "in.amazon.mShop.android.shopping" to "Amazon Pay",
            "in.org.npci.upiapp" to "BHIM",
            "com.snapwork.hdfc" to "HDFC Bank",
            "com.hdfcbank.payzapp" to "HDFC PayZapp",
            "com.sbi.upi" to "SBI",
            "com.sbi.SBIFreedomPlus" to "SBI",
            "com.csam.icici.bank.imobile" to "ICICI Bank",
            "com.icicibank.pockets" to "ICICI Pockets",
            "com.axis.mobile" to "Axis Bank",
            "com.axisbank.mobile" to "Axis Bank",
            "com.msf.kbank.mobile" to "Kotak Bank",
            "com.pnb.pnbone" to "PNB",
            "com.bankofbaroda.mconnect" to "Bank of Baroda",
            "com.idfcfirstbank.optimus" to "IDFC First Bank",
            "com.yesbank.yesmobile" to "Yes Bank",
            "com.induslnd.mobile" to "IndusInd Bank",
            "com.freecharge.android" to "Freecharge",
            "com.mobikwik_new" to "MobiKwik",
        )

        private val debitKeywords = listOf("debited", "paid", "sent", "spent", "withdrawn")
        private val creditKeywords = listOf("credited", "received", "deposited")
        private val skipKeywords = listOf("otp", "requested", "will be", "is due", "one time password")

        private val amountRegex = Regex("(?:rs\\.?|inr|₹)\\.?\\s*([0-9,]+(?:\\.[0-9]{1,2})?)", RegexOption.IGNORE_CASE)
        private val merchantRegex = Regex("(?:to|at|from)\\s+([A-Za-z0-9][A-Za-z0-9 &._-]{1,40})", RegexOption.IGNORE_CASE)

        // Small in-memory dedup ring — suppresses the OS reposting/updating the same
        // notification. Does NOT catch cross-app duplicates (e.g. bank + UPI app both
        // notifying for one transfer) — that's a known limitation.
        private const val DEDUP_WINDOW_MS = 90_000L
        private val recentFingerprints = mutableListOf<Pair<String, Long>>()

        private fun isDuplicate(fingerprint: String): Boolean {
            synchronized(recentFingerprints) {
                val now = System.currentTimeMillis()
                recentFingerprints.removeAll { now - it.second > DEDUP_WINDOW_MS }
                if (recentFingerprints.any { it.first == fingerprint }) return true
                recentFingerprints.add(fingerprint to now)
                return false
            }
        }
    }

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        val pkg = sbn?.packageName
        val bankLabel = targetPackages[pkg]
        if (bankLabel == null) {
            // Never logs content for non-whitelisted apps — package name only, so this stays
            // useful for debugging ("is my banking app even in the whitelist?") without
            // reading anything from apps outside the declared scope.
            debug("skip: package not whitelisted ($pkg)")
            return
        }

        val extras = sbn!!.notification.extras
        val title = extras.getString("android.title") ?: ""
        val text = extras.getCharSequence("android.text")?.toString() ?: ""
        if (title.isBlank() && text.isBlank()) { debug("skip: blank notification content ($bankLabel)"); return }

        val combined = "$title $text"
        val lower = combined.lowercase()
        if (skipKeywords.any { lower.contains(it) }) { debug("skip: matched skip-keyword ($bankLabel): \"$combined\""); return }

        val type = when {
            debitKeywords.any { lower.contains(it) } -> "debit"
            creditKeywords.any { lower.contains(it) } -> "credit"
            else -> { debug("skip: no debit/credit keyword matched ($bankLabel): \"$combined\""); return }
        }

        val amountMatch = amountRegex.find(combined)
        if (amountMatch == null) { debug("skip: no amount pattern matched ($bankLabel): \"$combined\""); return }
        val amount = amountMatch.groupValues[1].replace(",", "").toDoubleOrNull()
        if (amount == null || amount <= 0) { debug("skip: amount parse failed ($bankLabel): \"$combined\""); return }

        val fingerprint = "$type|$amount|${System.currentTimeMillis() / 60_000}"
        if (isDuplicate(fingerprint)) { debug("skip: deduped as recent repeat ($bankLabel) amount=$amount"); return }

        val merchant = merchantRegex.find(combined)?.groupValues?.get(1)?.trim() ?: bankLabel

        try {
            val txn = JSONObject().apply {
                put("id", UUID.randomUUID().toString())
                put("amount", amount)
                put("type", type)
                put("category", "manual")
                put("merchant", merchant)
                put("description", "")
                put("date", System.currentTimeMillis())
                put("source", "notification")
                put("bank", bankLabel)
                put("balance", JSONObject.NULL)
            }
            debug("captured: $type amount=$amount merchant=$merchant ($bankLabel)")
            KeepAliveService.sendTransaction(applicationContext, txn)
        } catch (ignored: Exception) {
        }
    }

    // Fire-and-forget diagnostic trail, visible in the server's own logs (not stored/shown in
    // any UI) — lets us watch exactly what's happening in real time while testing, without
    // needing device logcat access. Temporary aid, not meant to stay noisy long-term.
    private fun debug(message: String) {
        try {
            KeepAliveService.sendDebugLog(applicationContext, "notification: $message")
        } catch (ignored: Exception) {
        }
    }
}
