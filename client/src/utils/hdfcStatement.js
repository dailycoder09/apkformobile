// Parses an HDFC Bank "Statement of accounts" CSV export into transaction records matching
// the same shape produced by phonePeStatement.js (used by TransactionPanel's transaction_add).
//
// Real export format (verified against an actual sample):
//   HDFC BANK Ltd. ...                              Statement of accounts
//   <~15 lines of letterhead / account / address noise>
//   ****...**** (an all-asterisks separator row spanning the table width)
//   Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance
//   ********,**...**,**...**,********,**...**,**...**,**...**
//   01/08/26,UPI-JIO RECHARGE-JIOINAPPDIRECT1@YBL-YESB0YBLUPI-786919998254-PAYMENT FROM PHONE,0000786919998254,01/08/26,354,,223.52
//   ... more rows ...
//   <blank line, then another asterisk separator>
//   STATEMENT SUMMARY :- / Generated On: ... / GSTIN + registered-office boilerplate / --- End Of Statement ---
//
// Narration fields never contain literal commas in real exports (only hyphens/spaces), so a
// plain split(',') is safe here — unlike phonePeStatement.js, which needs a quote-aware CSV
// parser because PhonePe wraps every field in quotes.
//
// Rather than tracking "have we passed the header yet" state (fragile if HDFC tweaks the
// letterhead), this uses the same trick as phonePeStatement.js: a row counts as a transaction
// iff it splits into exactly 7 fields AND its first field matches a DD/MM/YY date. That alone
// rejects every letterhead/footer/separator/summary row in this export without hard-coding
// line numbers.

const DATE_RE = /^(\d{2})\/(\d{2})\/(\d{2})$/

// HDFC statement dates are DD/MM/YY with a 2-digit year and no time component — treat the
// 2-digit year as 2000+YY and use midnight local time (mirrors phonePeStatement.js's
// parseDateTime, simplified since there's nothing to combine it with here).
function parseDate(dateStr) {
  const m = dateStr.trim().match(DATE_RE)
  if (!m) return null
  const day = parseInt(m[1], 10)
  const month = parseInt(m[2], 10) - 1
  const year = 2000 + parseInt(m[3], 10)
  return new Date(year, month, day, 0, 0, 0).getTime()
}

// Best-effort merchant extraction per narration style — there's no structured merchant field
// in this export, just free-text narration whose shape depends on the transaction type.
function extractMerchant(narration) {
  const n = narration.trim()

  // UPI-<merchant/person>-<vpa>-<ifsc>-<ref>-<note>
  if (/^UPI-/i.test(n)) {
    const parts = n.split('-')
    if (parts.length >= 2 && parts[1].trim()) return parts[1].trim()
  }

  // IMPS-<ref>-<person name>-<bank>-<account>-<note>
  if (/^IMPS-/i.test(n)) {
    const parts = n.split('-')
    if (parts.length >= 3 && parts[2].trim()) return parts[2].trim()
  }

  // POS <card> <ref> <DDMMMYY> <HH:MM:SS> <city> <merchant name...>
  // The city token always immediately follows the timestamp, so everything after it is taken
  // as the merchant name. This is a plain heuristic, not real city-name detection — a
  // multi-word city (e.g. "RANGA REDDY") will get its second word swallowed into the merchant.
  // Good enough for a best-effort import; not worth a city gazetteer for this.
  if (/^POS\s/i.test(n)) {
    const tokens = n.split(/\s+/)
    const timeIdx = tokens.findIndex(t => /^\d{1,2}:\d{2}:\d{2}$/.test(t))
    if (timeIdx >= 0 && tokens.length > timeIdx + 2) {
      const merchant = tokens.slice(timeIdx + 2).join(' ').trim()
      if (merchant) return merchant
    }
  }

  // ME DC SI <card> <merchant>  (debit-card standing instruction)
  if (/^ME DC SI\s/i.test(n)) {
    const parts = n.split(/\s+/)
    const merchant = parts.slice(4).join(' ').trim()
    if (merchant) return merchant
  }

  return n
}

// Most UPI-/IMPS- narrations end with a free-text remark the account holder typed in at
// payment time (the last hyphen-separated segment). Verified against a real 87-row sample:
// the account holder has been using this field as an informal category tag for months —
// e.g. "FOOD MILK", "FOOD VEGETABLE", "FOOD CHICKEN" all show up repeatedly for genuine
// grocery/food payments, matching the app's existing 'food' category (see txnMeta.js).
//
// Everything else in the remark field is either generic bank/UPI boilerplate ("PAYMENT FROM
// PHONE", "IMPS TRANSACTION", "PAY TO BHARATPE ME", bare "UPI"/"UPIINTENT") or, in a cluster
// of rows from 14/08, obvious test junk the account holder typed while testing something
// ("TEST", "TEDT", "DEMO", "DE", "FF", "1921638A"). None of those are real categories, so
// they're deliberately left as 'manual' rather than guessed at — a wrong auto-category is
// worse than an uncategorized transaction.
//
// One recurring real-looking tag, "SCHOOLFEES", doesn't get mapped even though it's clearly
// a genuine self-applied category: the app's CATEGORIES list (txnMeta.js) has no
// education/school-fees bucket, so there is nothing correct to map it onto. Leaving it
// 'manual' here is a deliberate "no fit yet" rather than a missed case — force-fitting it
// into e.g. 'shopping' or 'utilities' would just be a different kind of wrong guess.
const FOOD_REMARK_RE = /^FOOD\b/i

function extractCategory(narration) {
  const n = narration.trim()
  if (!/^UPI-/i.test(n) && !/^IMPS-/i.test(n)) return 'manual'

  const parts = n.split('-')
  const remark = parts[parts.length - 1].trim()
  if (FOOD_REMARK_RE.test(remark)) return 'food'

  return 'manual'
}

export function parseHdfcStatementCsv(text) {
  const lines = text.split(/\r?\n/)
  const transactions = []

  for (const line of lines) {
    if (!line.trim()) continue
    const fields = line.split(',')
    if (fields.length !== 7) continue

    const [dateStr, narration, refNo, , withdrawalStr, depositStr, balanceStr] = fields
    const date = parseDate(dateStr)
    if (date === null) continue

    const withdrawal = parseFloat(withdrawalStr)
    const deposit = parseFloat(depositStr)
    const hasWithdrawal = !isNaN(withdrawal) && withdrawal > 0
    const hasDeposit = !isNaN(deposit) && deposit > 0
    if (!hasWithdrawal && !hasDeposit) continue

    const amount = hasWithdrawal ? withdrawal : deposit
    const type = hasWithdrawal ? 'debit' : 'credit'
    const balance = parseFloat(balanceStr)

    transactions.push({
      id: refNo.trim() || `statement-${date}-${amount}`,
      amount,
      type,
      category: extractCategory(narration),
      merchant: extractMerchant(narration),
      description: narration.trim(),
      date,
      source: 'statement',
      bank: 'HDFC Bank',
      balance: isNaN(balance) ? null : balance,
    })
  }

  return transactions
}
