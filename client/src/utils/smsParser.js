// India bank/UPI SMS parser — no dependencies

const BANK_SENDERS = {
  HDFCBK: 'HDFC', HDFCBNK: 'HDFC', HDFCBANKLTD: 'HDFC',
  SBIINB: 'SBI', SBICRD: 'SBI', SBICARD: 'SBI', SBIPSG: 'SBI',
  ICICIB: 'ICICI', ICICIBNK: 'ICICI',
  AXISBK: 'Axis', AXISBANK: 'Axis',
  KOTAKB: 'Kotak', KOTAK: 'Kotak',
  PAYTM: 'Paytm', PYTMSMS: 'Paytm',
  PhonePe: 'PhonePe', PHONPE: 'PhonePe',
  GPAY: 'Google Pay', GOOGLEPAY: 'Google Pay',
  INDBNK: 'Indian Bank', PNBSMS: 'PNB', BARODASMS: 'Bank of Baroda',
  BOBTXN: 'Bank of Baroda', CANBNK: 'Canara Bank', UCOBNK: 'UCO Bank',
  IDFCBK: 'IDFC', YESBNK: 'Yes Bank', INDUSIND: 'IndusInd',
  AUBANK: 'AU Bank', FEDRBL: 'Federal Bank',
}

const FOOD_KEYWORDS    = ['swiggy','zomato','mcdonald','kfc','domino','pizza','burger','cafe','restaurant','biryani','dunzo','blinkit','zepto','bigbasket','grofer','instamart']
const SHOPPING_KEYWORDS = ['amazon','flipkart','myntra','meesho','ajio','nykaa','snapdeal','shopclues','limeroad','firstcry','paytmmall']
const TRANSPORT_KEYWORDS = ['ola','uber','rapido','petrol','diesel','fuel','irctc','railway','metro','bus','flight','makemytrip','goibibo','redbus','yatra']
const UTILITY_KEYWORDS   = ['electricity','electric','bescom','tpddl','bses','msedcl','water','gas','airtel','jio','vi vodafone','bsnl','broadband','postpaid','prepaid','dth','tataplay','dish']

function detectCategory(text, bank) {
  const t = text.toLowerCase()
  if (['Paytm','PhonePe','Google Pay'].includes(bank)) return 'upi'
  if (FOOD_KEYWORDS.some(k => t.includes(k)))    return 'food'
  if (SHOPPING_KEYWORDS.some(k => t.includes(k))) return 'shopping'
  if (TRANSPORT_KEYWORDS.some(k => t.includes(k))) return 'transport'
  if (UTILITY_KEYWORDS.some(k => t.includes(k)))  return 'utilities'
  if (/upi|phonepe|gpay|paytm|bhim/i.test(t))    return 'upi'
  return 'bank'
}

function parseAmount(text) {
  const m = text.match(/(?:Rs\.?|INR|₹)\s*([\d,]+(?:\.\d{1,2})?)/i)
  if (!m) return null
  return parseFloat(m[1].replace(/,/g, ''))
}

function parseBalance(text) {
  const m = text.match(/(?:Avl\.?\s*[Bb]al|[Bb]alance|Avail[a-z]*\s*Bal|Bal)\s*(?:is|:)?\s*(?:Rs\.?|INR|₹)?\s*([\d,]+(?:\.\d{1,2})?)/i)
  if (!m) return null
  return parseFloat(m[1].replace(/,/g, ''))
}

function parseMerchant(text) {
  const patterns = [
    /(?:paid to|sent to|transferred to|to)\s+([A-Za-z0-9 &.'%@-]{2,40}?)(?:\s+(?:via|on|at|\.|,|UPI|Ref|txn)|$)/i,
    /(?:at|from)\s+([A-Za-z0-9 &.'%@-]{2,40}?)(?:\s+(?:via|on|\.|,|Ref|txn)|$)/i,
    /(?:debited for|payment for|purchase at)\s+([A-Za-z0-9 &.'%@-]{2,40})/i,
  ]
  for (const p of patterns) {
    const m = text.match(p)
    if (m && m[1] && m[1].trim().length >= 2) return m[1].trim()
  }
  return ''
}

// Check if a sender ID looks like a known bank/UPI sender
export function isKnownSender(address) {
  if (!address) return false
  const key = address.toUpperCase().replace(/[^A-Z]/g, '')
  return Object.keys(BANK_SENDERS).some(k => k.toUpperCase() === key) ||
    /^(HDFC|SBI|ICICI|AXIS|KOTAK|PAYTM|PHONPE|GPAY|INDBNK|PNB|BOB|CANBNK|IDFCBK|YESBNK|INDUSIND|AUBANK|FEDRBL)/i.test(address)
}

// Parse a single SMS into a transaction object, or return null if not a financial SMS
export function parseSms(address, body, dateMs) {
  const amount = parseAmount(body)
  if (!amount || amount <= 0) return null

  const isDebit = /debited|paid|spent|deducted|withdrawn|sent|dr\b/i.test(body)
  const isCredit = /credited|received|added|deposited|cr\b/i.test(body)
  if (!isDebit && !isCredit) return null

  const addrKey = (address || '').toUpperCase().replace(/[^A-Z]/g, '')
  const bank = BANK_SENDERS[addrKey] ||
    Object.entries(BANK_SENDERS).find(([k]) => addrKey.startsWith(k))?.[1] ||
    address || 'Unknown'

  const merchant = parseMerchant(body)
  const balance  = parseBalance(body)
  const category = detectCategory(body + ' ' + merchant, bank)

  return {
    id:          Math.random().toString(36).slice(2),
    amount,
    type:        isDebit ? 'debit' : 'credit',
    category,
    merchant:    merchant || bank,
    description: body,
    date:        dateMs || Date.now(),
    source:      'sms',
    bank,
    balance,
  }
}
