// Parses a PhonePe "Transaction Statement" CSV export into transaction records matching the
// shape already used everywhere else (transaction_add's `transaction` payload).
//
// Real export format (verified against an actual sample):
//   Transaction Statement for 7972079842
//   Duration,"01 Aug, 2026 - 31 Aug, 2026"
//   Date,Time,Transaction Details,Transaction ID,UTR,Transaction Type,Credit/debit instrument,Amount
//   "Aug 14, 2026","08:03 pm","Received from Rzwaana Shaikh","T260814...","8200...","CREDIT","Credited to XXXXXXXXXX9851","2"
//   ... more rows ...
//   <blank line, then multi-paragraph disclaimer text>
//
// Only lines that parse into exactly 8 quoted CSV fields are treated as transaction rows —
// this naturally skips the two header lines and the footer disclaimer without needing to
// hard-code line numbers, which would break if PhonePe tweaks the preamble wording.

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 }

// Minimal CSV row parser respecting quoted fields (handles "" as an escaped quote) — safer
// than a naive split(',') in case a merchant name ever contains a comma.
function parseCsvLine(line) {
  const fields = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++ }
        else inQuotes = false
      } else {
        cur += ch
      }
    } else {
      if (ch === '"') inQuotes = true
      else if (ch === ',') { fields.push(cur); cur = '' }
      else cur += ch
    }
  }
  fields.push(cur)
  return fields
}

function parseDateTime(dateStr, timeStr) {
  // dateStr: "Aug 14, 2026"   timeStr: "08:03 pm"
  const dateMatch = dateStr.match(/([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{4})/)
  const timeMatch = timeStr.match(/(\d{1,2}):(\d{2})\s*(am|pm)/i)
  if (!dateMatch || !timeMatch) return null
  const month = MONTHS[dateMatch[1]]
  const day = parseInt(dateMatch[2], 10)
  const year = parseInt(dateMatch[3], 10)
  let hour = parseInt(timeMatch[1], 10)
  const minute = parseInt(timeMatch[2], 10)
  const ampm = timeMatch[3].toLowerCase()
  if (ampm === 'pm' && hour !== 12) hour += 12
  if (ampm === 'am' && hour === 12) hour = 0
  if (month === undefined) return null
  return new Date(year, month, day, hour, minute, 0).getTime()
}

function extractMerchant(details) {
  const paidTo = details.match(/^Paid to\s+(.+)$/i)
  if (paidTo) return paidTo[1].trim()
  const receivedFrom = details.match(/^Received from\s+(.+)$/i)
  if (receivedFrom) return receivedFrom[1].trim()
  return details.trim()
}

export function parsePhonePeStatementCsv(text) {
  const lines = text.split(/\r?\n/)
  const transactions = []

  for (const line of lines) {
    if (!line.trim().startsWith('"')) continue
    const fields = parseCsvLine(line)
    if (fields.length !== 8) continue
    const [dateStr, timeStr, details, transactionId, , txnType, instrument, amountStr] = fields

    const type = txnType.trim().toUpperCase() === 'CREDIT' ? 'credit'
      : txnType.trim().toUpperCase() === 'DEBIT' ? 'debit' : null
    if (!type) continue

    const amount = parseFloat(amountStr)
    if (!amount || amount <= 0) continue

    const date = parseDateTime(dateStr, timeStr)
    if (!date) continue

    transactions.push({
      id: transactionId.trim() || `statement-${date}-${amount}`,
      amount,
      type,
      category: 'manual',
      merchant: extractMerchant(details),
      description: instrument.trim(),
      date,
      source: 'statement',
      bank: 'PhonePe',
      balance: null,
    })
  }

  return transactions
}
