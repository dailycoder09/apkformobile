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
// payment time — checked via the last one or two hyphen-separated segments (see
// extractCategory below; the account holder's own "FOOD-CHOTU" style tags split the word
// "FOOD" and the sub-tag across two segments, so a single last-segment check missed them).
// Verified against a real 87-row sample: the account holder has been using this field as an
// informal category tag for months — e.g. "FOOD MILK", "FOOD VEGETABLE", "FOOD CHICKEN" all
// show up repeatedly for genuine grocery/food payments. Originally these all mapped to one
// generic 'food' category; split further per explicit request into 'milk' and 'veg'
// (vegetables/fruit) sub-categories, with any other "FOOD <tag>" still falling back to 'food'.
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

// Fallback signals checked only when the trailing remark above doesn't already resolve a
// category — these look at the *whole* narration (merchant name + VPA), because the giveaway
// fragment is sometimes only present in the VPA (e.g. "ACTCORP", "PPAUTOPAYELECTRICITY") and
// not in extractMerchant()'s narrower "second hyphen-segment" slice. Kept deliberately narrow:
// every pattern below is tied either to a real merchant actually seen in the 87-row sample or
// to a very well-established, unambiguous Indian brand/service name — never a guess at an
// unfamiliar one (see the deliberately-NOT-mapped cases noted where this is used).
//
// - "ATRIA CONVERGENCE"/"ACTCORP": ACT Fibernet, a well-known home-broadband ISP (real row:
//   "UPI-ATRIA CONVERGENCE TE-ACTCORP1.PAYU@HDFCBANK-...-UPIINTENT"). "FIBERNET"/"BROADBAND"
//   added as generic ISP fragments for the same reason even though not present in this sample.
// - "ELECTRICITY": literal in the VPA of a real row ("PPAUTOPAYELECTRICITY@YBL"), an
//   unambiguous utility-bill signal.
// - "RECHARGE": real row "UPI-JIO RECHARGE-JIOINAPPDIRECT1@YBL-...". Jio is a well-known
//   Indian telecom operator and "<name> RECHARGE" is the standard UPI narration shape for a
//   prepaid mobile/DTH recharge — a utility-style bill payment.
const UTILITY_KEYWORD_RE = /ATRIA CONVERGENCE|ACTCORP|FIBERNET|BROADBAND|ELECTRICITY|\bRECHARGE\b/i

// - "GROWW": a well-known Indian investing app (stocks/mutual funds) — money moving there
//   is an investment, not spending.
// - "ZERODHA": another major Indian stock-broking platform, same reasoning as Groww (real
//   rows: "...-ZERODHA BROKING LIMI...").
const INVESTMENT_KEYWORD_RE = /\bGROWW\b|ZERODHA/i

// - "SPAR"/"HYPERMARKET": real row "UPI-SPAR HYPERMARKETS-LANDMARKSPAR@YBL-...". SPAR is a
//   well-known supermarket/hypermarket chain; "HYPERMARKET" kept as a generic fragment too.
const FOOD_KEYWORD_RE = /\bSPAR\b|HYPERMARKET/i

// - "RETAIL": real row (x2) "UPI-LMD RETAIL SPECTRUM-...-PAY TO LMD RETAIL".
// - "LULU": a well-known Indian shopping-mall chain — matched as a bare fragment (not just
//   "LULU MALL") since real rows show up as "LULU HYDERABAD" too, keyed to the city rather
//   than literally saying "MALL".
// - "BLINKIT"/"ZEPTO": quick-commerce delivery apps — categorized as shopping rather than
//   food per explicit correction (real row: "UPI-BLINKIT-BLINKIT.RZP@HDFCBANK-...").
const SHOPPING_KEYWORD_RE = /\bRETAIL\b|\bLULU\b|\bBLINKIT\b|\bZEPTO\b/i

// - "SHOES": real row "POS ... CENTRO SHOES" — footwear/clothing retail, an unambiguous
//   shopping signal regardless of the specific store name.
const POS_SHOPPING_KEYWORD_RE = /\bSHOES\b/i

// - "GOOGLEPLAY"/"AMAZON PRIME": real rows "ME DC SI ... GOOGLEPLAY" and remark "AMAZON PRIME
//   RECUR" — recurring digital-subscription payments.
// - "SUBSCRIPTION"/"RECURRINGTXN": generic remarks the bank itself uses for standing-instruction
//   recurring debits (real rows: "SUBSCRIPTION DEBIT", "RECURRINGTXN"), not brand-specific but
//   an unambiguous signal of what kind of payment it is.
const SUBSCRIPTION_KEYWORD_RE = /GOOGLEPLAY|AMAZON PRIME|\bSUBSCRIPTION\b|RECURRINGTXN/i

// - "ICICI": the account holder has a second account at ICICI Bank — any UPI/IMPS narration
//   naming it is money moving between their own accounts, not real spend/income.
const ICICI_SELF_TRANSFER_RE = /ICICI/i

// POS narrations have no free-text remark field at all, so they're otherwise left 'manual'
// entirely (see below). A literal "FOOD" in the merchant name itself is still an unambiguous
// signal though — real rows: "POS ... HYDERABAD M S AA FOOD DELIGHTS L" (x2). This is
// intentionally narrow (just the literal word) rather than an attempt at general POS
// categorization.
const POS_FOOD_KEYWORD_RE = /\bFOOD\b/i

// Deliberately NOT mapped, despite being considered (left 'manual' — a wrong guess is worse
// than an uncategorized transaction):
// - POS "... RANGA REDDY AJMAL": "AJMAL" could be a perfume/attar brand or a person's name —
//   not confident enough either way.
// - POS "... AMB CINEMAS L L P": clearly a cinema, but there's no entertainment category in
//   txnMeta.js's CATEGORIES to map it onto (considered, explicitly declined).
// - POS "... BEIJING BITES": likely a food outlet by name, but "BITES" is too generic a
//   fragment to add as a rule (would risk matching unrelated merchants), and it's not a
//   nationally-unambiguous brand the way Blinkit/SPAR are.
// - UPI "CHINTAN COLLECTION": "COLLECTION" is too generic/ambiguous a business-name fragment
//   (could be all sorts of businesses) to map to shopping.
// - "SCHOOLFEES" remark: a genuine self-applied category, but there's no education/school-fees
//   bucket in CATEGORIES to map it onto (already noted above for the remark-based rule).
// - "PAYMENT FROM PHONE"/"PAY TO BHARATPE ME"/"UPIINTENT": generic bank/UPI/payment-gateway
//   boilerplate that appears on payments to all kinds of different merchants (BharatPe in
//   particular is a gateway used by many unrelated small vendors) — the remark itself carries
//   no category signal no matter how often it repeats.

function extractCategory(narration) {
  const n = narration.trim()

  if (/^UPI-/i.test(n) || /^IMPS-/i.test(n)) {
    // The account holder's personal "FOOD <tag>" convention shows up with inconsistent
    // separators and segment counts ("FOOD MILK", "FOOD-CHOTU", "FOOD-RAPIDO", ...) — rather
    // than keep chasing exactly how many trailing hyphen-segments to join, just search the
    // whole narration for the word "FOOD". Safe to do narration-wide here (not just the
    // remark) because this account's real merchant/VPA names never contain "FOOD" as a
    // standalone word outside this personal-tag convention.
    if (/\bFOOD\b/i.test(n) && /\bMILK\b/i.test(n)) return 'milk'
    if (/\bFOOD\b/i.test(n) && /\b(VEGETABLE|VEGETABLES|FRUIT|FRUITS)\b/i.test(n)) return 'veg'
    if (/\bFOOD\b/i.test(n)) return 'food'

    if (INVESTMENT_KEYWORD_RE.test(n)) return 'investment'
    if (UTILITY_KEYWORD_RE.test(n)) return 'utilities'
    if (SUBSCRIPTION_KEYWORD_RE.test(n)) return 'subscription'
    if (FOOD_KEYWORD_RE.test(n)) return 'food'
    if (SHOPPING_KEYWORD_RE.test(n)) return 'shopping'

    return 'manual'
  }

  // ME DC SI <card> <merchant> — debit-card standing instructions, mostly recurring digital
  // subscriptions (real row: "ME DC SI 541919XXXXXX2292 GOOGLEPLAY").
  if (/^ME DC SI\s/i.test(n) && SUBSCRIPTION_KEYWORD_RE.test(n)) return 'subscription'

  if (/^POS\s/i.test(n)) {
    if (POS_FOOD_KEYWORD_RE.test(n)) return 'food'
    if (POS_SHOPPING_KEYWORD_RE.test(n)) return 'shopping'
  }

  return 'manual'
}

export function parseHdfcStatementCsv(text) {
  const lines = text.split(/\r?\n/)
  const transactions = []

  // HDFC statement dates have no time component, so a busy day (this format easily runs
  // into hundreds of rows across a statement) produces many transactions sharing the exact
  // same `date` value. The statement's own row order IS chronological though, so each
  // subsequent row on the same calendar day gets nudged forward by 1ms — enough to make
  // "latest transaction" comparisons (e.g. the real account-balance card) resolve to the
  // true last row of the day instead of an arbitrary tie, without affecting anything that
  // only cares about the calendar day itself (bucketing, display formatting, etc.).
  const sameDayCount = {}

  for (const line of lines) {
    if (!line.trim()) continue
    const fields = line.split(',')
    if (fields.length !== 7) continue

    const [dateStr, narration, refNo, , withdrawalStr, depositStr, balanceStr] = fields
    const parsedDate = parseDate(dateStr)
    if (parsedDate === null) continue
    const dayKey = dateStr.trim()
    const occurrence = sameDayCount[dayKey] || 0
    sameDayCount[dayKey] = occurrence + 1
    const date = parsedDate + occurrence

    const withdrawal = parseFloat(withdrawalStr)
    const deposit = parseFloat(depositStr)
    const hasWithdrawal = !isNaN(withdrawal) && withdrawal > 0
    const hasDeposit = !isNaN(deposit) && deposit > 0
    if (!hasWithdrawal && !hasDeposit) continue

    const amount = hasWithdrawal ? withdrawal : deposit
    // Money moving to/from the account holder's own ICICI account is a self-transfer, not
    // real spend/income — overrides the debit/credit read off the withdrawal/deposit column.
    const isSelfTransfer = ICICI_SELF_TRANSFER_RE.test(narration)
    const type = isSelfTransfer ? 'transfer' : (hasWithdrawal ? 'debit' : 'credit')
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
      // fromBank/toBank drive the Bank filter for type==='transfer' rows (see
      // TransactionPanel's applyTxnFilters) — direction follows which side of this
      // statement the money left from.
      ...(isSelfTransfer ? { fromBank: hasWithdrawal ? 'HDFC Bank' : 'ICICI Bank', toBank: hasWithdrawal ? 'ICICI Bank' : 'HDFC Bank' } : {}),
    })
  }

  return transactions
}
