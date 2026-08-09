package com.familywatch.app

import android.content.Context
import io.livekit.android.LiveKit
import io.livekit.android.room.Room
import io.livekit.android.room.track.LocalVideoTrack
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject

class LiveKitManager(
    private val context: Context,
    private val httpClient: OkHttpClient
) {
    private var room: Room? = null
    private val scope = CoroutineScope(Dispatchers.Main + SupervisorJob())

    fun startCamera(httpBase: String, userId: String, facing: String) {
        // Stop any existing room before starting new one
        val old = room
        if (old != null) {
            scope.launch { try { old.disconnect() } catch (_: Exception) {} }
            room = null
        }

        scope.launch {
            try {
                // 1. Fetch LiveKit token from our server
                val tokenUrl = "$httpBase/api/lk-token?room=${userId}&identity=${userId}"
                val (token, lkUrl) = withContext(Dispatchers.IO) {
                    val req = Request.Builder().url(tokenUrl).get().build()
                    val resp = httpClient.newCall(req).execute()
                    val body = resp.body?.string() ?: throw Exception("empty response")
                    resp.close()
                    val json = JSONObject(body)
                    Pair(json.getString("token"), json.getString("url"))
                }

                // 2. Connect to LiveKit room as publisher
                val r = LiveKit.create(context.applicationContext)
                room = r
                r.connect(lkUrl, token)

                // 3. Publish camera track
                r.localParticipant.setCameraEnabled(true)
                // Switch to front camera if requested (rear is default)
                if (facing == "front") {
                    val videoTrack = r.localParticipant.trackPublications.values
                        .mapNotNull { it.track as? LocalVideoTrack }
                        .firstOrNull()
                    videoTrack?.switchCamera()
                }
            } catch (e: Exception) {
                // Token fetch or LiveKit connection failed — silently ignore
                // Admin will see "No signal" which is correct
                room = null
            }
        }
    }

    fun stopCamera() {
        val r = room ?: return
        room = null
        scope.launch {
            try {
                r.localParticipant.setCameraEnabled(false)
                r.disconnect()
            } catch (_: Exception) {}
        }
    }
}
