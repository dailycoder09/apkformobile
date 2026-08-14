package com.familywatch.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony

// Live capture of bank transaction SMS — complements TransactionNotificationListener rather
// than replacing it. Cross-source duplicate suppression (the same transaction arriving via
// both an SMS and a UPI app's notification) happens centrally in
// KeepAliveService.sendTransaction(), not here.
class BankSmsReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
        if (context == null || intent == null) return
        val messages = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return
        for (msg in messages) {
            val sender = msg.originatingAddress ?: continue
            val body = msg.messageBody ?: continue
            val txn = SmsTransactionParser.parse(sender, body, msg.timestampMillis) ?: continue
            KeepAliveService.sendTransaction(context.applicationContext, txn)
        }
    }
}
