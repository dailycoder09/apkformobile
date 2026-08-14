package com.familywatch.app

import org.json.JSONObject
import java.util.UUID

// Shared bank-SMS parser used by both the live BankSmsReceiver and KeepAliveService's
// historical backfill. Not tied to any Android component lifecycle, so it's callable from
// both a BroadcastReceiver and a plain Java method.
//
// Complements (does not replace) TransactionNotificationListener — banks send their own SMS
// for a debit/credit regardless of which UPI app initiated it, so this catches cases where a
// UPI app's own notification is late or never posted at all. Cross-source duplicates (the same
// real transaction arriving via both SMS and a notification) are handled centrally in
// KeepAliveService.sendTransaction(), not here.
object SmsTransactionParser {

    // Best-effort — matched via "contains" since carrier/DLT sender-ID prefixes vary
    // (e.g. "VM-HDFCBK", "AD-SBIINB"), not exact-matched against a fixed sender string.
    private val bankSenderCodes = listOf(
        "HDFCBK", "HDFCBANK", "ICICIB", "ICICIBANK", "SBIINB", "SBIPSG", "SBIUPI",
        "AXISBK", "AXISBANK", "KOTAKB", "PNBSMS", "BOBIBN", "BARODA", "IDFCFB",
        "YESBNK", "INDUSB", "CANBNK", "UNIONB", "IDBIBK", "RBLBNK", "FEDBNK", "BOIIND", "CENTBK",
    )

    private val debitKeywords = listOf("debited", "paid", "sent", "spent", "withdrawn")
    private val creditKeywords = listOf("credited", "received", "deposited")
    private val skipKeywords = listOf("otp", "requested", "will be", "is due", "one time password")

    private val amountRegex = Regex("(?:rs\\.?|inr|₹)\\.?\\s*([0-9,]+(?:\\.[0-9]{1,2})?)", RegexOption.IGNORE_CASE)
    private val merchantRegex = Regex("(?:to|at|from)\\s+([A-Za-z0-9][A-Za-z0-9 &._-]{1,40})", RegexOption.IGNORE_CASE)
    private val refRegex = Regex("(?:ref(?:erence)?(?:\\s*no)?|txn\\s*id|upi\\s*ref)[:\\s]*([A-Za-z0-9]{6,})", RegexOption.IGNORE_CASE)

    // `date` is required (no default) so both call sites are explicit: the live receiver
    // passes the SMS's own delivery time, the historical backfill passes the SMS's original
    // timestamp from the inbox — never just "now", which would be wrong for backfilled entries.
    @JvmStatic
    fun parse(sender: String, body: String, date: Long): JSONObject? {
        if (bankSenderCodes.none { sender.contains(it, ignoreCase = true) }) return null
        if (body.isBlank()) return null

        val lower = body.lowercase()
        if (skipKeywords.any { lower.contains(it) }) return null

        val type = when {
            debitKeywords.any { lower.contains(it) } -> "debit"
            creditKeywords.any { lower.contains(it) } -> "credit"
            else -> return null
        }

        val amountMatch = amountRegex.find(body) ?: return null
        val amount = amountMatch.groupValues[1].replace(",", "").toDoubleOrNull() ?: return null
        if (amount <= 0) return null

        val merchant = merchantRegex.find(body)?.groupValues?.get(1)?.trim()
        val ref = refRegex.find(body)?.groupValues?.get(1)?.trim()

        return JSONObject().apply {
            put("id", UUID.randomUUID().toString())
            put("amount", amount)
            put("type", type)
            put("category", "manual")
            put("merchant", merchant ?: sender)
            put("description", if (ref != null) "Ref: $ref" else "")
            put("date", date)
            put("source", "sms")
            put("bank", sender)
            put("balance", JSONObject.NULL)
        }
    }
}
