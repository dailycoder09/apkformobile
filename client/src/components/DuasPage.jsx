import { Fragment, useEffect, useRef, useState } from 'react'

const QURAN_API = 'https://api.alquran.cloud/v1'

const PLAYBACK_SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2]

// Shared recitation-audio player: only one ayah plays at a time, and
// auto-advances to the next ayah in the list when one finishes (like a real
// recitation player), via a `getNext(key)` resolver the caller supplies.
// Playback speed is user-adjustable and remembered across sessions.
function useAyahAudioPlayer() {
  const audioRef = useRef(null)
  const getNextRef = useRef(null)
  const [playingKey, setPlayingKey] = useState(null)
  const [playbackRate, setPlaybackRateState] = useState(() => {
    const stored = Number(localStorage.getItem('quran-playback-rate'))
    return PLAYBACK_SPEEDS.includes(stored) ? stored : 1
  })
  const playbackRateRef = useRef(playbackRate)
  playbackRateRef.current = playbackRate

  function playKey(key, url) {
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current = null
    }
    if (!url) { setPlayingKey(null); return }
    const audio = new Audio(url)
    audio.playbackRate = playbackRateRef.current
    audio.addEventListener('ended', () => {
      const next = getNextRef.current?.(key)
      if (next?.url) playKey(next.key, next.url)
      else setPlayingKey(null)
    })
    audio.play().catch(() => setPlayingKey(null))
    audioRef.current = audio
    setPlayingKey(key)
  }

  function toggleAudio(key, url, getNext) {
    getNextRef.current = getNext || null
    if (playingKey === key) {
      audioRef.current?.pause()
      audioRef.current = null
      setPlayingKey(null)
      return
    }
    playKey(key, url)
  }

  function setPlaybackRate(rate) {
    setPlaybackRateState(rate)
    localStorage.setItem('quran-playback-rate', String(rate))
    if (audioRef.current) audioRef.current.playbackRate = rate
  }

  useEffect(() => () => audioRef.current?.pause(), [])

  return { playingKey, toggleAudio, playbackRate, setPlaybackRate }
}

function AudioButton({ playing, onClick }) {
  return (
    <button className="duas-audio-btn" onClick={onClick} aria-label={playing ? 'Pause recitation' : 'Play recitation'}>
      <span className="material-symbols-outlined">{playing ? 'pause_circle' : 'play_circle'}</span>
    </button>
  )
}

function SpeedControl({ rate, onChange }) {
  return (
    <div className="duas-speed-control">
      <span className="material-symbols-outlined duas-speed-icon">speed</span>
      {PLAYBACK_SPEEDS.map((s) => (
        <button
          key={s}
          type="button"
          className={`duas-speed-btn${rate === s ? ' active' : ''}`}
          onClick={() => onChange(s)}
        >
          {s}×
        </button>
      ))}
    </div>
  )
}

// Quranic text sources embed invisible bidi/formatting marks (RLM, LRM, ZWJ,
// bidi embedding controls) that some font/fallback combinations render as a
// visible "tofu" box instead of treating as zero-width. We already set
// direction: rtl via CSS, so these are redundant — strip them before display.
const INVISIBLE_MARK_CODES = [0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0xfeff]
function cleanArabicText(text) {
  if (!text) return text
  return Array.from(text).filter((ch) => !INVISIBLE_MARK_CODES.includes(ch.codePointAt(0))).join('')
}

// Indo-Pak script first (via our server's Quran Foundation proxy), falling
// back to Uthmani (Al Quran Cloud, no proxy needed) if the proxy isn't
// configured or errors. Used everywhere a single ayah's Arabic is shown.
async function fetchArabicText(verseKey) {
  try {
    const res = await fetch(`/api/quran-indopak?verse_key=${verseKey}`)
    if (res.ok) {
      const json = await res.json()
      const text = json?.verses?.[0]?.text_indopak
      if (text) return cleanArabicText(text)
    }
  } catch { /* fall through to Uthmani */ }
  const res = await fetch(`${QURAN_API}/ayah/${verseKey}/quran-uthmani`)
  const json = await res.json()
  return cleanArabicText(json?.data?.text)
}
const HADITH_CDN = 'https://cdn.jsdelivr.net/gh/fawazahmed0/hadith-api@1'
const PAGE_SIZE = 20

const DUA_CATEGORIES = [
  {
    key: 'after-prayer',
    title: 'After Prayer',
    icon: 'mosque',
    duas: [
      {
        arabic: 'أَسْتَغْفِرُ اللَّهَ (×٣)',
        transliteration: 'Astaghfirullah — (repeat 3 times)',
        translation: 'I seek forgiveness from Allah.',
        source: 'Sahih Muslim, Book of Mosques and Places of Prayer — narrated by Thawban (RA)',
      },
      {
        arabic: 'اللَّهُمَّ أَنْتَ السَّلاَمُ وَمِنْكَ السَّلاَمُ تَبَارَكْتَ يَا ذَا الْجَلاَلِ وَالإِكْرَامِ',
        transliteration: 'Allahumma antas-salamu wa minkas-salam, tabarakta ya dhal-jalali wal-ikram.',
        translation: 'O Allah, You are Peace and from You comes peace. Blessed are You, O Owner of majesty and honor.',
        source: 'Sahih Muslim, Book of Mosques and Places of Prayer — narrated by Thawban (RA), same hadith as above',
      },
      {
        arabic: 'سُبْحَانَ اللَّهِ (×٣٣) — الْحَمْدُ لِلَّهِ (×٣٣) — اللَّهُ أَكْبَرُ (×٣٤)',
        transliteration: 'SubhanAllah (33×), Alhamdulillah (33×), Allahu Akbar (34×).',
        translation: 'Glory be to Allah — All praise is for Allah — Allah is the Greatest.',
        source: 'Sahih al-Bukhari, Book of Adhan, and Sahih Muslim, Book of Mosques — narrated by Abu Hurairah (RA)',
      },
      {
        arabic: null,
        quranRefs: ['2:255'],
        transliteration: 'Ayat al-Kursi',
        translation: 'Quran 2:255 — widely recommended after each obligatory prayer.',
        source: "Quran 2:255 (Surah al-Baqarah), Hafs 'an Asim riwayah — the same text whether printed in Uthmani or Indo-Pak script, in every mus-haf found in Masjid al-Haram and Masjid an-Nabawi",
      },
    ],
  },
  {
    key: 'morning',
    title: 'Morning Adhkar',
    icon: 'wb_twilight',
    duas: [
      {
        arabic: 'اللَّهُمَّ أَنْتَ رَبِّي لاَ إِلَهَ إِلاَّ أَنْتَ، خَلَقْتَنِي وَأَنَا عَبْدُكَ، وَأَنَا عَلَى عَهْدِكَ وَوَعْدِكَ مَا اسْتَطَعْتُ، أَعُوذُ بِكَ مِنْ شَرِّ مَا صَنَعْتُ، أَبُوءُ لَكَ بِنِعْمَتِكَ عَلَيَّ، وَأَبُوءُ بِذَنْبِي فَاغْفِرْ لِي فَإِنَّهُ لاَ يَغْفِرُ الذُّنُوبَ إِلاَّ أَنْتَ',
        transliteration: "Allahumma anta Rabbi la ilaha illa anta, khalaqtani wa ana 'abduka, wa ana 'ala 'ahdika wa wa'dika mastata'tu, a'udhu bika min sharri ma sana'tu, abu'u laka bini'matika 'alayya, wa abu'u bidhanbi faghfir li fa'innahu la yaghfirudh-dhunuba illa ant.",
        translation: "O Allah, You are my Lord, none has the right to be worshipped except You. You created me and I am Your servant, and I am faithful to my covenant and promise as much as I can. I seek refuge in You from the evil of what I have done. I acknowledge Your favor upon me, and I acknowledge my sin, so forgive me, for none forgives sins except You.",
        source: 'Sahih al-Bukhari — "Sayyidul Istighfar" (the master supplication for forgiveness)',
      },
      {
        arabic: 'أَصْبَحْنَا وَأَصْبَحَ الْمُلْكُ لِلَّهِ، وَالْحَمْدُ لِلَّهِ',
        transliteration: 'Asbahna wa asbahal-mulku lillah, walhamdu lillah.',
        translation: 'We have entered the morning and with it all dominion belongs to Allah, and all praise is for Allah.',
        source: 'Sahih Muslim',
      },
    ],
  },
  {
    key: 'evening',
    title: 'Evening Adhkar',
    icon: 'nights_stay',
    duas: [
      {
        arabic: 'أَمْسَيْنَا وَأَمْسَى الْمُلْكُ لِلَّهِ، وَالْحَمْدُ لِلَّهِ',
        transliteration: 'Amsayna wa amsal-mulku lillah, walhamdu lillah.',
        translation: 'We have entered the evening and with it all dominion belongs to Allah, and all praise is for Allah.',
        source: 'Sahih Muslim',
      },
    ],
  },
  {
    key: 'daily-life',
    title: 'Daily Life',
    icon: 'home',
    duas: [
      {
        arabic: 'بِسْمِ اللَّهِ',
        transliteration: 'Bismillah',
        translation: 'In the name of Allah. (Before eating)',
        source: 'Sunan Abi Dawud',
      },
      {
        arabic: 'الْحَمْدُ لِلَّهِ الَّذِي أَطْعَمَنِي هَذَا وَرَزَقَنِيهِ مِنْ غَيْرِ حَوْلٍ مِنِّي وَلاَ قُوَّةٍ',
        transliteration: "Alhamdulillahil-ladhi at'amani hadha wa razaqanihi min ghayri hawlin minni wa la quwwah.",
        translation: 'Praise be to Allah who has fed me this and provided it for me without any might or power on my part. (After eating)',
        source: 'Sunan Abi Dawud, Jami at-Tirmidhi',
      },
      {
        arabic: 'بِاسْمِكَ اللَّهُمَّ أَمُوتُ وَأَحْيَا',
        transliteration: 'Bismika Allahumma amutu wa ahya.',
        translation: 'In Your name, O Allah, I die and I live. (Before sleeping)',
        source: 'Sahih al-Bukhari',
      },
      {
        arabic: 'الْحَمْدُ لِلَّهِ الَّذِي أَحْيَانَا بَعْدَ مَا أَمَاتَنَا وَإِلَيْهِ النُّشُورُ',
        transliteration: "Alhamdulillahil-ladhi ahyana ba'da ma amatana wa ilayhin-nushur.",
        translation: 'Praise be to Allah who gave us life after having taken it from us, and unto Him is the resurrection. (Upon waking)',
        source: 'Sahih al-Bukhari',
      },
      {
        arabic: 'بِسْمِ اللَّهِ وَلَجْنَا، وَبِسْمِ اللَّهِ خَرَجْنَا، وَعَلَى رَبِّنَا تَوَكَّلْنَا',
        transliteration: "Bismillahi walajna, wa bismillahi kharajna, wa 'ala Rabbina tawakkalna.",
        translation: 'In the name of Allah we enter, and in the name of Allah we leave, and upon our Lord we place our trust. (Entering home)',
        source: 'Sunan Abi Dawud',
      },
      {
        arabic: 'بِسْمِ اللَّهِ تَوَكَّلْتُ عَلَى اللَّهِ وَلاَ حَوْلَ وَلاَ قُوَّةَ إِلاَّ بِاللَّهِ',
        transliteration: "Bismillah, tawakkaltu 'alallah, wa la hawla wa la quwwata illa billah.",
        translation: 'In the name of Allah, I place my trust in Allah, and there is no might nor power except with Allah. (Leaving home)',
        source: 'Sunan Abi Dawud, Jami at-Tirmidhi',
      },
      {
        arabic: 'اللَّهُمَّ افْتَحْ لِي أَبْوَابَ رَحْمَتِكَ',
        transliteration: 'Allahumma iftah li abwaba rahmatik.',
        translation: 'O Allah, open the gates of Your mercy for me. (Entering the masjid)',
        source: 'Sahih Muslim',
      },
      {
        arabic: 'اللَّهُمَّ إِنِّي أَسْأَلُكَ مِنْ فَضْلِكَ',
        transliteration: 'Allahumma inni as-aluka min fadlik.',
        translation: 'O Allah, I ask You from Your bounty. (Leaving the masjid)',
        source: 'Sahih Muslim',
      },
      {
        arabic: null,
        quranRefs: ['43:13', '43:14'],
        transliteration: 'Travel dua',
        translation: 'Glory be to Him who has subjected this to us, and we could never have accomplished it by ourselves. And to our Lord we shall return. (as recited by the Prophet ﷺ when setting out on a journey)',
        source: 'Sahih Muslim; Quran 43:13-14',
      },
    ],
  },
]

const TABS = [
  { key: 'dua', label: 'Dua', icon: 'volunteer_activism' },
  { key: 'hadees', label: 'Hadees', icon: 'menu_book' },
  { key: 'quran', label: 'Quran', icon: 'auto_stories' },
]

// ── Dua tab (curated compilation, unchanged) ────────────────────────────
function DuaTab() {
  const [openCategory, setOpenCategory] = useState(DUA_CATEGORIES[0].key)
  const [quranVerses, setQuranVerses] = useState({})
  const { playingKey, toggleAudio } = useAyahAudioPlayer()

  async function fetchAyah(ref) {
    const [arabic, en, hi, tr, au] = await Promise.all([
      fetchArabicText(ref).catch(() => null),
      fetch(`${QURAN_API}/ayah/${ref}/en.sahih`).then((r) => r.json()).catch(() => null),
      fetch(`${QURAN_API}/ayah/${ref}/hi.hindi`).then((r) => r.json()).catch(() => null),
      fetch(`${QURAN_API}/ayah/${ref}/en.transliteration`).then((r) => r.json()).catch(() => null),
      fetch(`${QURAN_API}/ayah/${ref}/ar.alafasy`).then((r) => r.json()).catch(() => null),
    ])
    return { arabic, translation: en?.data?.text, hindi: hi?.data?.text, transliteration: tr?.data?.text, audio: au?.data?.audio }
  }

  useEffect(() => {
    let cancelled = false
    const refs = ['2:255', '43:13', '43:14']
    refs.forEach((ref) => {
      fetchAyah(ref).then((data) => {
        if (!cancelled) setQuranVerses((prev) => ({ ...prev, [ref]: data }))
      })
    })
    return () => { cancelled = true }
  }, [])

  function quranTextFor(dua) {
    if (!dua.quranRefs) return null
    const parts = dua.quranRefs.map((ref) => quranVerses[ref]).filter(Boolean)
    if (parts.length !== dua.quranRefs.length) return null
    return {
      arabic: parts.map((p) => p.arabic).join(' '),
      translation: parts.map((p) => p.translation).join(' '),
      hindi: parts.map((p) => p.hindi).join(' '),
      transliteration: parts.map((p) => p.transliteration).join(' '),
      audio: parts[0]?.audio,
    }
  }

  return (
    <div className="duas-categories">
      {DUA_CATEGORIES.map((cat) => {
        const isOpen = openCategory === cat.key
        return (
          <div key={cat.key} className="duas-category">
            <button className="duas-category-toggle" onClick={() => setOpenCategory(isOpen ? null : cat.key)}>
              <span className="duas-category-icon"><span className="material-symbols-outlined">{cat.icon}</span></span>
              <span className="duas-category-title">{cat.title}</span>
              <span className={`material-symbols-outlined duas-category-chevron${isOpen ? ' open' : ''}`}>expand_more</span>
            </button>

            {isOpen && (
              <div className="duas-list">
                {cat.duas.map((dua, i) => {
                  const fetched = quranTextFor(dua)
                  const arabic = fetched?.arabic || dua.arabic
                  const translation = fetched?.translation || dua.translation
                  const translit = fetched?.transliteration || dua.transliteration
                  const audioKey = `${cat.key}-${i}`
                  return (
                    <div key={i} className={`duas-card${playingKey === audioKey ? ' duas-card--playing' : ''}`}>
                      {fetched?.audio && (
                        <AudioButton playing={playingKey === audioKey} onClick={() => toggleAudio(audioKey, fetched.audio)} />
                      )}
                      {arabic && <p className="duas-arabic">{arabic}</p>}
                      <p className="duas-translit">{translit}</p>
                      <p className="duas-translation">{translation}</p>
                      {fetched?.hindi && <p className="duas-translation duas-translation--hindi">{fetched.hindi}</p>}
                      <p className="duas-source">{dua.source}</p>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Quran tab: search + browse by Surah, ayahs shown in sequence ───────
function QuranTab() {
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [searchStatus, setSearchStatus] = useState('idle')
  const [surahList, setSurahList] = useState([])
  const [selectedSurah, setSelectedSurah] = useState(null)
  const [surahAyahs, setSurahAyahs] = useState(null)
  const [surahStatus, setSurahStatus] = useState('idle')
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const [scriptMode, setScriptMode] = useState('indopak') // 'uthmani' | 'indopak' — Indo-Pak by default
  const [indopakUnavailable, setIndopakUnavailable] = useState(false)
  const { playingKey, toggleAudio, playbackRate, setPlaybackRate } = useAyahAudioPlayer()
  const ayahCardRefs = useRef({})
  const searchCardRefs = useRef({})
  const scrollTimerRef = useRef(null)
  const resumeTargetRef = useRef(null)
  const [lastRead, setLastRead] = useState(() => {
    try { return JSON.parse(localStorage.getItem('quran-last-read')) } catch { return null }
  })

  useEffect(() => {
    fetch(`${QURAN_API}/surah`).then((r) => r.json()).then((json) => {
      setSurahList(json?.data || [])
    }).catch(() => {})
  }, [])

  // Keep the playing ayah visible: reveal it if paginated out of view, then
  // scroll to it. Applies to both the Surah browser and search results.
  useEffect(() => {
    if (!playingKey) return
    if (playingKey.startsWith('surah-')) {
      const num = Number(playingKey.replace('surah-', ''))
      if (num > visibleCount) { setVisibleCount(num); return }
      ayahCardRefs.current[num]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    } else if (playingKey.startsWith('search-')) {
      searchCardRefs.current[playingKey]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [playingKey, visibleCount])

  // Bookmark the ayah nearest the top of the viewport as "last read", debounced
  // so it doesn't write on every scroll frame. Listens on the capture phase so
  // it still fires if a nested scrollable div — not window — does the scrolling.
  useEffect(() => {
    if (!selectedSurah || !surahAyahs) return
    function handleScroll() {
      clearTimeout(scrollTimerRef.current)
      scrollTimerRef.current = setTimeout(() => {
        let closestNum = null
        let closestDist = Infinity
        Object.entries(ayahCardRefs.current).forEach(([num, el]) => {
          if (!el) return
          const dist = Math.abs(el.getBoundingClientRect().top - 120)
          if (dist < closestDist) { closestDist = dist; closestNum = Number(num) }
        })
        if (closestNum == null) return
        const meta = surahList.find((s) => s.number === selectedSurah)
        const entry = { surah: selectedSurah, ayah: closestNum, surahName: meta?.englishName, timestamp: Date.now() }
        localStorage.setItem('quran-last-read', JSON.stringify(entry))
        setLastRead(entry)
      }, 800)
    }
    window.addEventListener('scroll', handleScroll, true)
    handleScroll()
    return () => { window.removeEventListener('scroll', handleScroll, true); clearTimeout(scrollTimerRef.current) }
  }, [selectedSurah, surahAyahs, surahList])

  useEffect(() => {
    if (!surahAyahs || resumeTargetRef.current == null) return
    const target = resumeTargetRef.current
    if (target > visibleCount) { setVisibleCount(target); return }
    const t = setTimeout(() => {
      ayahCardRefs.current[target]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      resumeTargetRef.current = null
    }, 50)
    return () => clearTimeout(t)
  }, [surahAyahs, visibleCount])

  useEffect(() => {
    const query = searchQuery.trim()
    if (query.length < 3) { setSearchResults([]); setSearchStatus('idle'); return }
    setSearchStatus('loading')
    const t = setTimeout(() => {
      fetch(`${QURAN_API}/search/${encodeURIComponent(query)}/all/en`)
        .then((r) => r.json())
        .then(async (json) => {
          const matches = (json?.data?.matches || []).slice(0, 5)
          const withText = await Promise.all(matches.map(async (m) => {
            const ref = `${m.surah.number}:${m.numberInSurah}`
            const [arabic, hiRes, trRes, auRes] = await Promise.all([
              fetchArabicText(ref).catch(() => null),
              fetch(`${QURAN_API}/ayah/${ref}/hi.hindi`).then((r) => r.json()).catch(() => null),
              fetch(`${QURAN_API}/ayah/${ref}/en.transliteration`).then((r) => r.json()).catch(() => null),
              fetch(`${QURAN_API}/ayah/${ref}/ar.alafasy`).then((r) => r.json()).catch(() => null),
            ])
            return { ...m, arabic, hindi: hiRes?.data?.text, transliteration: trRes?.data?.text, audio: auRes?.data?.audio }
          }))
          setSearchResults(withText)
          setSearchStatus('idle')
        })
        .catch(() => { setSearchResults([]); setSearchStatus('error') })
    }, 400)
    return () => clearTimeout(t)
  }, [searchQuery])

  function loadSurah(num, script) {
    setVisibleCount(PAGE_SIZE)
    setSurahStatus('loading')

    const arabicPromise = script === 'indopak'
      ? fetch(`/api/quran-indopak?chapter=${num}`)
          .then((r) => { if (!r.ok) throw new Error('unavailable'); return r.json() })
          .then((json) => {
            setIndopakUnavailable(false)
            return (json.verses || []).map((v) => ({ numberInSurah: Number(v.verse_key.split(':')[1]), text: v.text_indopak }))
          })
          .catch(() => {
            setIndopakUnavailable(true)
            return fetch(`${QURAN_API}/surah/${num}/quran-uthmani`).then((r) => r.json()).then((j) => j?.data?.ayahs || [])
          })
      : fetch(`${QURAN_API}/surah/${num}/quran-uthmani`).then((r) => r.json()).then((j) => j?.data?.ayahs || [])

    // Ruku numbers only live on the Uthmani ayah objects, so when the Indo-Pak
    // script is active (and its own ayahs lack `ruku`), fetch Uthmani again
    // purely to source ruku boundaries.
    const rukuPromise = script === 'indopak'
      ? fetch(`${QURAN_API}/surah/${num}/quran-uthmani`).then((r) => r.json()).then((j) => j?.data?.ayahs || []).catch(() => [])
      : Promise.resolve(null)

    Promise.all([
      arabicPromise,
      rukuPromise,
      fetch(`${QURAN_API}/surah/${num}/en.sahih`).then((r) => r.json()),
      fetch(`${QURAN_API}/surah/${num}/hi.hindi`).then((r) => r.json()).catch(() => null),
      fetch(`${QURAN_API}/surah/${num}/en.transliteration`).then((r) => r.json()).catch(() => null),
      fetch(`${QURAN_API}/surah/${num}/ar.alafasy`).then((r) => r.json()).catch(() => null),
    ]).then(([arAyahs, rukuAyahs, enJson, hiJson, trJson, auJson]) => {
      const enAyahs = enJson?.data?.ayahs || []
      const hiAyahs = hiJson?.data?.ayahs || []
      const trAyahs = trJson?.data?.ayahs || []
      const auAyahs = auJson?.data?.ayahs || []
      const rukuSource = rukuAyahs && rukuAyahs.length ? rukuAyahs : arAyahs
      const rukuByNumber = {}
      rukuSource.forEach((a) => { if (a.ruku != null) rukuByNumber[a.numberInSurah] = a.ruku })
      const combined = arAyahs.map((a, i) => ({
        number: a.numberInSurah,
        ruku: rukuByNumber[a.numberInSurah],
        arabic: cleanArabicText(a.text),
        translation: enAyahs[i]?.text,
        hindi: hiAyahs[i]?.text,
        transliteration: trAyahs[i]?.text,
        audio: auAyahs[i]?.audio,
      }))
      setSurahAyahs(combined)
      setSurahStatus('idle')
    }).catch(() => setSurahStatus('error'))
  }

  function openSurah(num) {
    setSelectedSurah(num)
    loadSurah(num, scriptMode)
  }

  function changeScript(mode) {
    setScriptMode(mode)
    if (selectedSurah) loadSurah(selectedSurah, mode)
  }

  function resumeLastRead() {
    if (!lastRead) return
    resumeTargetRef.current = lastRead.ayah
    openSurah(lastRead.surah)
  }

  if (selectedSurah) {
    const meta = surahList.find((s) => s.number === selectedSurah)
    return (
      <div>
        <button className="duas-subheader-back" onClick={() => { setSelectedSurah(null); setSurahAyahs(null) }}>
          <span className="material-symbols-outlined">arrow_back</span>
          All Surahs
        </button>
        <h2 className="duas-subheader-title">{meta?.number}. {meta?.englishName} <span className="duas-subheader-arabic">{meta?.name}</span></h2>
        <p className="duas-settings-hint">{meta?.englishNameTranslation} — {meta?.numberOfAyahs} ayahs, {meta?.revelationType}</p>

        <div className="duas-script-toggle">
          <button className={scriptMode === 'uthmani' ? 'active' : ''} onClick={() => changeScript('uthmani')}>Uthmani</button>
          <button className={scriptMode === 'indopak' ? 'active' : ''} onClick={() => changeScript('indopak')}>Indo-Pak</button>
        </div>
        <SpeedControl rate={playbackRate} onChange={setPlaybackRate} />
        {scriptMode === 'indopak' && indopakUnavailable && (
          <p className="duas-disclaimer">Indo-Pak script isn't configured on the server yet — showing Uthmani instead.</p>
        )}
        {surahStatus === 'loading' && <p className="duas-disclaimer">Loading…</p>}
        {surahStatus === 'error' && <p className="duas-disclaimer">Couldn't load this surah — check your connection.</p>}
        <div className="duas-list">
          {(surahAyahs || []).slice(0, visibleCount).map((a, idx, arr) => {
            const startsNewRuku = a.ruku != null && a.ruku !== arr[idx - 1]?.ruku
            return (
              <Fragment key={a.number}>
                {startsNewRuku && <div className="duas-ruku-marker">Ruku {a.ruku}</div>}
                <div
                  ref={(el) => { ayahCardRefs.current[a.number] = el }}
                  className={`duas-card${playingKey === `surah-${a.number}` ? ' duas-card--playing' : ''}`}
                >
                  {a.audio && (
                    <AudioButton
                      playing={playingKey === `surah-${a.number}`}
                      onClick={() => toggleAudio(`surah-${a.number}`, a.audio, (key) => {
                        const i = (surahAyahs || []).findIndex((x) => `surah-${x.number}` === key)
                        const nextAyah = i >= 0 ? surahAyahs[i + 1] : null
                        return nextAyah ? { key: `surah-${nextAyah.number}`, url: nextAyah.audio } : null
                      })}
                    />
                  )}
                  <p className="duas-arabic">
                    {a.arabic}
                    <span className="duas-ayah-badge">{a.number}</span>
                  </p>
                  {a.transliteration && <p className="duas-translit">{a.transliteration}</p>}
                  <p className="duas-translation">{a.translation}</p>
                  {a.hindi && <p className="duas-translation duas-translation--hindi">{a.hindi}</p>}
                </div>
              </Fragment>
            )
          })}
        </div>
        {surahAyahs && visibleCount < surahAyahs.length && (
          <button className="duas-load-more" onClick={() => setVisibleCount((v) => v + PAGE_SIZE)}>
            Load more ({surahAyahs.length - visibleCount} remaining)
          </button>
        )}
      </div>
    )
  }

  return (
    <div>
      <div className="duas-search">
        <span className="material-symbols-outlined">search</span>
        <input
          type="text"
          placeholder="Search the Quran by topic (e.g. patience, travel)"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>
      <SpeedControl rate={playbackRate} onChange={setPlaybackRate} />

      {searchQuery.trim().length >= 3 ? (
        <div className="duas-list">
          {searchStatus === 'loading' && <p className="duas-disclaimer">Searching…</p>}
          {searchStatus === 'error' && <p className="duas-disclaimer">Couldn't reach the search service — check your connection.</p>}
          {searchStatus === 'idle' && searchResults.length === 0 && (
            <p className="duas-disclaimer">No matches found for "{searchQuery.trim()}".</p>
          )}
          {searchResults.map((m, i) => (
            <div
              key={i}
              ref={(el) => { searchCardRefs.current[`search-${i}`] = el }}
              className={`duas-card${playingKey === `search-${i}` ? ' duas-card--playing' : ''}`}
            >
              {m.audio && (
                <AudioButton
                  playing={playingKey === `search-${i}`}
                  onClick={() => toggleAudio(`search-${i}`, m.audio, (key) => {
                    const idx = Number(key.replace('search-', ''))
                    const nextItem = searchResults[idx + 1]
                    return nextItem ? { key: `search-${idx + 1}`, url: nextItem.audio } : null
                  })}
                />
              )}
              {m.arabic && (
                <p className="duas-arabic">
                  {m.arabic}
                  <span className="duas-ayah-badge">{m.numberInSurah}</span>
                </p>
              )}
              {m.transliteration && <p className="duas-translit">{m.transliteration}</p>}
              <p className="duas-translation">{m.text}</p>
              {m.hindi && <p className="duas-translation duas-translation--hindi">{m.hindi}</p>}
              <p className="duas-source">Quran {m.surah.number}:{m.numberInSurah} — Surah {m.surah.englishName}</p>
            </div>
          ))}
        </div>
      ) : (
        <>
          {lastRead && (
            <button className="duas-continue-card" onClick={resumeLastRead}>
              <span className="material-symbols-outlined">bookmark</span>
              <span className="duas-continue-info">
                <span className="duas-continue-label">Continue Reading</span>
                <span className="duas-continue-detail">{lastRead.surahName} · Ayah {lastRead.ayah}</span>
              </span>
              <span className="material-symbols-outlined">chevron_right</span>
            </button>
          )}
          <p className="duas-settings-hint">Browse by Surah, in sequence:</p>
          <div className="duas-booklist">
            {surahList.map((s) => (
              <button key={s.number} className="duas-book-row" onClick={() => openSurah(s.number)}>
                <span className="duas-book-num">{s.number}</span>
                <span className="duas-book-info">
                  <span className="duas-book-name">{s.englishName}</span>
                  <span className="duas-book-sub">{s.englishNameTranslation} · {s.numberOfAyahs} ayahs</span>
                </span>
                <span className="material-symbols-outlined">chevron_right</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

// ── Hadees tab: book -> chapter -> hadiths in sequence ─────────────────
const HADITH_BOOKS = [
  { key: 'bukhari', label: 'Sahih al-Bukhari' },
  { key: 'muslim', label: 'Sahih Muslim' },
  { key: 'abudawud', label: 'Sunan Abu Dawud' },
  { key: 'tirmidhi', label: 'Jami at-Tirmidhi' },
  { key: 'ibnmajah', label: 'Sunan Ibn Majah' },
  { key: 'nasai', label: "Sunan an-Nasa'i" },
]

function HadeesTab() {
  const [selectedBook, setSelectedBook] = useState(null)
  const [bookData, setBookData] = useState(null)
  const [bookStatus, setBookStatus] = useState('idle')
  const [selectedSection, setSelectedSection] = useState(null)
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)

  function openBook(key) {
    setSelectedBook(key)
    setSelectedSection(null)
    setBookStatus('loading')
    fetch(`${HADITH_CDN}/editions/eng-${key}.min.json`)
      .then((r) => r.json())
      .then((json) => { setBookData(json); setBookStatus('idle') })
      .catch(() => setBookStatus('error'))
  }

  function openSection(id) {
    setSelectedSection(id)
    setVisibleCount(PAGE_SIZE)
  }

  if (selectedBook && selectedSection != null && bookData) {
    const range = bookData.metadata.section_details[selectedSection]
    const hadiths = bookData.hadiths.filter((h) => h.hadithnumber >= range.hadithnumber_first && h.hadithnumber <= range.hadithnumber_last)
    return (
      <div>
        <button className="duas-subheader-back" onClick={() => setSelectedSection(null)}>
          <span className="material-symbols-outlined">arrow_back</span>
          Chapters
        </button>
        <h2 className="duas-subheader-title">{bookData.metadata.sections[selectedSection] || 'Chapter'}</h2>
        <div className="duas-list">
          {hadiths.slice(0, visibleCount).map((h) => (
            <div key={h.hadithnumber} className="duas-card">
              <p className="duas-translation">{h.text}</p>
              <p className="duas-source">{bookData.metadata.name} {h.hadithnumber}</p>
            </div>
          ))}
        </div>
        {hadiths.length > visibleCount && (
          <button className="duas-load-more" onClick={() => setVisibleCount((v) => v + PAGE_SIZE)}>
            Load more ({hadiths.length - visibleCount} remaining)
          </button>
        )}
      </div>
    )
  }

  if (selectedBook && bookData) {
    const sections = Object.entries(bookData.metadata.sections).filter(([id, name]) => name)
    return (
      <div>
        <button className="duas-subheader-back" onClick={() => { setSelectedBook(null); setBookData(null) }}>
          <span className="material-symbols-outlined">arrow_back</span>
          All Books
        </button>
        <h2 className="duas-subheader-title">{bookData.metadata.name}</h2>
        <div className="duas-booklist">
          {sections.map(([id, name]) => (
            <button key={id} className="duas-book-row" onClick={() => openSection(id)}>
              <span className="duas-book-info">
                <span className="duas-book-name">{name}</span>
                <span className="duas-book-sub">Hadith {bookData.metadata.section_details[id].hadithnumber_first}–{bookData.metadata.section_details[id].hadithnumber_last}</span>
              </span>
              <span className="material-symbols-outlined">chevron_right</span>
            </button>
          ))}
        </div>
      </div>
    )
  }

  if (selectedBook && bookStatus === 'loading') {
    return <p className="duas-disclaimer">Loading {selectedBook}…</p>
  }
  if (selectedBook && bookStatus === 'error') {
    return <p className="duas-disclaimer">Couldn't load this collection — check your connection.</p>
  }

  return (
    <div>
      <p className="duas-settings-hint">Browse by collection, in sequence:</p>
      <div className="duas-booklist">
        {HADITH_BOOKS.map((b) => (
          <button key={b.key} className="duas-book-row" onClick={() => openBook(b.key)}>
            <span className="duas-book-info">
              <span className="duas-book-name">{b.label}</span>
            </span>
            <span className="material-symbols-outlined">chevron_right</span>
          </button>
        ))}
      </div>
    </div>
  )
}

export default function DuasPage({ onBack }) {
  const [activeTab, setActiveTab] = useState('dua')

  return (
    <div className="duas-screen">
      <div className="duas-header">
        <button className="duas-back" onClick={onBack} aria-label="Back to Namaz">
          <span className="material-symbols-outlined">arrow_back</span>
        </button>
        <h1 className="duas-title">Islamic Reference</h1>
      </div>

      <p className="duas-disclaimer">
        A general reference. Please verify pronunciation and rulings with a trusted local source or scholar.
      </p>

      <div className="duas-tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`duas-tab${activeTab === t.key ? ' active' : ''}`}
            onClick={() => setActiveTab(t.key)}
          >
            <span className="material-symbols-outlined">{t.icon}</span>
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === 'dua' && <DuaTab />}
      {activeTab === 'quran' && <QuranTab />}
      {activeTab === 'hadees' && <HadeesTab />}
    </div>
  )
}
