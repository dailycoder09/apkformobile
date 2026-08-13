package com.familywatch.app

import android.net.VpnService
import android.os.ParcelFileDescriptor
import org.json.JSONObject
import java.io.FileInputStream
import java.io.FileOutputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetSocketAddress
import java.nio.ByteBuffer

// Captures plaintext DNS queries (port 53) only — NOT a full traffic proxy. We deliberately
// don't add a 0.0.0.0/0 route, so only DNS gets routed through our TUN interface; every other
// packet keeps using the normal network path untouched. This trades full-URL visibility for a
// vastly simpler and safer implementation (no NAT/TCP proxying needed).
//
// Known limitation: DNS-over-HTTPS/TLS (used by default in some Chrome/Firefox configs) bypasses
// this entirely since the query itself is encrypted — accepted for v1, see project plan.
class DnsMonitorVpnService : VpnService() {

    private var vpnInterface: ParcelFileDescriptor? = null
    @Volatile private var running = false
    private var workerThread: Thread? = null

    private val recentDomains = mutableMapOf<String, Long>()
    private val dedupWindowMs = 60_000L

    override fun onStartCommand(intent: android.content.Intent?, flags: Int, startId: Int): Int {
        if (running) return START_STICKY
        val builder = Builder()
            .addAddress("10.0.0.2", 32)
            .addDnsServer("10.0.0.2")
            .setSession("FamilyWatch DNS Monitor")
            .setBlocking(true)
        vpnInterface = builder.establish()
        if (vpnInterface == null) return START_STICKY

        running = true
        workerThread = Thread { runLoop() }.also { it.start() }
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        try { vpnInterface?.close() } catch (ignored: Exception) {}
        vpnInterface = null
        super.onDestroy()
    }

    override fun onRevoke() {
        // User pulled the plug via Settings — stop cleanly rather than crash-looping
        running = false
        try { vpnInterface?.close() } catch (ignored: Exception) {}
        stopSelf()
        super.onRevoke()
    }

    private fun runLoop() {
        val fd = vpnInterface ?: return
        val input = FileInputStream(fd.fileDescriptor)
        val output = FileOutputStream(fd.fileDescriptor)
        val buffer = ByteArray(32767)

        while (running) {
            val length = try { input.read(buffer) } catch (e: Exception) { break }
            if (length <= 0) continue
            try {
                handlePacket(buffer, length, output)
            } catch (ignored: Exception) {
                // Malformed/unsupported packet — drop and keep going, never crash the loop
            }
        }
    }

    // Parses just enough of IPv4 + UDP + DNS to (a) pull the queried domain for logging and
    // (b) forward the query to a real resolver and relay the response back, so the device's
    // actual DNS resolution keeps working normally.
    private fun handlePacket(buffer: ByteArray, length: Int, output: FileOutputStream) {
        val ipVersion = (buffer[0].toInt() shr 4) and 0xF
        if (ipVersion != 4) return // IPv6 DNS not handled in v1

        val ihl = (buffer[0].toInt() and 0xF) * 4
        val protocol = buffer[9].toInt() and 0xFF
        if (protocol != 17) return // UDP only

        val udpStart = ihl
        if (udpStart + 8 > length) return
        val destPort = ((buffer[udpStart + 2].toInt() and 0xFF) shl 8) or (buffer[udpStart + 3].toInt() and 0xFF)
        if (destPort != 53) return

        val dnsStart = udpStart + 8
        val dnsLength = length - dnsStart
        if (dnsLength < 12) return

        val domain = parseDnsQueryName(buffer, dnsStart, length) ?: return
        maybeLogDomain(domain)
        forwardAndRelay(buffer, length, ihl, udpStart, dnsStart, dnsLength, output)
    }

    // Extracts the QNAME from the question section of a DNS message (length-prefixed labels,
    // terminated by a zero-length label). Only reads the first question — sufficient for the
    // single-question queries virtually every real-world resolver sends.
    private fun parseDnsQueryName(buffer: ByteArray, dnsStart: Int, packetLength: Int): String? {
        var pos = dnsStart + 12 // skip the fixed 12-byte DNS header
        val labels = mutableListOf<String>()
        while (pos < packetLength) {
            val len = buffer[pos].toInt() and 0xFF
            if (len == 0) break
            pos += 1
            if (pos + len > packetLength) return null
            labels.add(String(buffer, pos, len, Charsets.US_ASCII))
            pos += len
        }
        if (labels.isEmpty()) return null
        return labels.joinToString(".")
    }

    private fun maybeLogDomain(domain: String) {
        val now = System.currentTimeMillis()
        synchronized(recentDomains) {
            recentDomains.entries.removeAll { now - it.value > dedupWindowMs }
            if (recentDomains.containsKey(domain)) return
            recentDomains[domain] = now
        }
        try {
            val entry = JSONObject().apply {
                put("id", java.util.UUID.randomUUID().toString())
                put("domain", domain)
                put("timestamp", now)
            }
            KeepAliveService.sendBrowsingEvent(applicationContext, entry)
        } catch (ignored: Exception) {}
    }

    // Forwards the original DNS query to a real upstream resolver and writes the response back
    // into the TUN so the querying app actually gets its answer. The forwarding socket MUST be
    // protect()ed or its own traffic would loop back into this same VPN.
    private fun forwardAndRelay(
        buffer: ByteArray, length: Int, ihl: Int, udpStart: Int, dnsStart: Int, dnsLength: Int,
        output: FileOutputStream,
    ) {
        val query = buffer.copyOfRange(dnsStart, dnsStart + dnsLength)
        val socket = DatagramSocket()
        try {
            protect(socket)
            socket.soTimeout = 5000
            socket.send(DatagramPacket(query, query.size, InetSocketAddress("8.8.8.8", 53)))

            val responseBuf = ByteArray(4096)
            val responsePacket = DatagramPacket(responseBuf, responseBuf.size)
            socket.receive(responsePacket)

            val reply = buildReplyPacket(buffer, ihl, udpStart, responseBuf, responsePacket.length)
            output.write(reply)
        } catch (ignored: Exception) {
            // Upstream timeout/unreachable — the querying app will simply retry, matching
            // normal DNS failure behavior on any network.
        } finally {
            socket.close()
        }
    }

    // Swaps source/destination in the original IPv4+UDP headers and appends the real DNS
    // response, producing a well-formed reply packet to write back into the TUN.
    private fun buildReplyPacket(original: ByteArray, ihl: Int, udpStart: Int, dnsResponse: ByteArray, dnsRespLen: Int): ByteArray {
        val udpLen = 8 + dnsRespLen
        val totalLen = ihl + udpLen
        val out = ByteArray(totalLen)

        // IPv4 header: copy original, then swap src/dst addresses, fix total length + checksum
        System.arraycopy(original, 0, out, 0, ihl)
        for (i in 0 until 4) {
            out[12 + i] = original[16 + i] // new src = original dst
            out[16 + i] = original[12 + i] // new dst = original src
        }
        out[2] = ((totalLen shr 8) and 0xFF).toByte()
        out[3] = (totalLen and 0xFF).toByte()
        out[10] = 0; out[11] = 0 // zero checksum before recompute
        val ipChecksum = computeChecksum(out, 0, ihl)
        out[10] = ((ipChecksum shr 8) and 0xFF).toByte()
        out[11] = (ipChecksum and 0xFF).toByte()

        // UDP header: swap ports, set length, zero checksum (0 = not computed, valid for IPv4)
        val srcPort = ((original[udpStart].toInt() and 0xFF) shl 8) or (original[udpStart + 1].toInt() and 0xFF)
        val dstPort = ((original[udpStart + 2].toInt() and 0xFF) shl 8) or (original[udpStart + 3].toInt() and 0xFF)
        out[ihl] = ((dstPort shr 8) and 0xFF).toByte()
        out[ihl + 1] = (dstPort and 0xFF).toByte()
        out[ihl + 2] = ((srcPort shr 8) and 0xFF).toByte()
        out[ihl + 3] = (srcPort and 0xFF).toByte()
        out[ihl + 4] = ((udpLen shr 8) and 0xFF).toByte()
        out[ihl + 5] = (udpLen and 0xFF).toByte()
        out[ihl + 6] = 0; out[ihl + 7] = 0

        System.arraycopy(dnsResponse, 0, out, ihl + 8, dnsRespLen)
        return out
    }

    private fun computeChecksum(data: ByteArray, offset: Int, length: Int): Int {
        var sum = 0
        var i = offset
        while (i < offset + length - 1) {
            sum += ((data[i].toInt() and 0xFF) shl 8) or (data[i + 1].toInt() and 0xFF)
            i += 2
        }
        if (length % 2 == 1) sum += (data[offset + length - 1].toInt() and 0xFF) shl 8
        while (sum shr 16 != 0) sum = (sum and 0xFFFF) + (sum shr 16)
        return sum.inv() and 0xFFFF
    }
}
