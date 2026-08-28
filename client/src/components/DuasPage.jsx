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

const DUAS_API = 'https://ummahapi.com/api/duas'

// UmmahAPI's dua "source" field cites hadith collections with a specific Book:Hadith
// number (e.g. "Sahih Al-Bukhari 11:113") — checked one of these against sunnah.com's
// real book numbering and it did not match any known edition (Invocations is Book 75
// or 80 everywhere, never Book 11), so these specific numbers can't be trusted. Strip
// them and show only the collection name. Quran citations (e.g. "Quran 1:2") are left
// alone — Surah:Ayah numbering is universal and not subject to this problem.
function cleanDuaSource(source) {
  if (!source) return source
  return source
    .split(',')
    .map((part) => {
      const trimmed = part.trim()
      if (/quran/i.test(trimmed)) return trimmed
      return trimmed.replace(/\s+\d+:\d+\s*$/, '')
    })
    .join(', ')
}

// Icons for UmmahAPI's 27 dua category ids (see /api/duas/categories) — falls back to
// a generic icon for any category id not listed here (e.g. if the API adds more later).
const DUA_CATEGORY_ICONS = {
  morning: 'wb_twilight', evening: 'nights_stay', wudu: 'water_drop', prayer: 'mosque',
  after_prayer: 'mosque', sleep: 'bedtime', food: 'restaurant', travel: 'flight',
  home: 'home', masjid: 'mosque', distress: 'sentiment_stressed', forgiveness: 'volunteer_activism',
  illness: 'healing', weather: 'cloud', knowledge: 'school', parents: 'family_restroom',
  guidance: 'explore', gratitude: 'favorite', protection: 'shield', dhikr: 'self_improvement',
  marriage: 'favorite', hajj: 'location_on', grief: 'sentiment_very_dissatisfied',
  children: 'child_care', business: 'payments', night_prayer: 'dark_mode', quran_recitation: 'auto_stories',
}

const TABS = [
  { key: 'dua', label: 'Dua', icon: 'volunteer_activism' },
  { key: 'hadees', label: 'Hadees', icon: 'menu_book' },
  { key: 'quran', label: 'Quran', icon: 'auto_stories' },
  { key: 'names', label: 'Names', icon: 'badge' },
  { key: 'hadith2', label: 'Hadith DB', icon: 'travel_explore' },
]

const HADITH_API = 'https://ummahapi.com/api/hadith'
const HADITH_PAGE_SIZE = 20

// ── Hadith DB tab — a second, separate hadith browser on UmmahAPI (alongside the
// existing Hadees tab's fawazahmed0/chapter-based one), so both can be compared side
// by side. Adds full-text search, a random-hadith button, Arabic text and Sahih/Hasan
// grading — none of which the chapter-based tab has — at the cost of no chapter/topic
// browsing (UmmahAPI's hadith data is flat, numbered straight through each collection).
function HadithApiTab() {
  const [collections, setCollections] = useState([])
  const [collection, setCollection] = useState('bukhari')
  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState(null)
  const [searchStatus, setSearchStatus] = useState('idle')
  const [page, setPage] = useState(1)
  const [browse, setBrowse] = useState({ hadiths: [], total_pages: 1 })
  const [browseStatus, setBrowseStatus] = useState('loading')
  const [randomHadith, setRandomHadith] = useState(null)
  const [randomStatus, setRandomStatus] = useState('idle')

  useEffect(() => {
    fetch(`${HADITH_API}/collections`)
      .then((r) => r.json())
      .then((json) => setCollections(json?.data?.collections || []))
      .catch(() => {})
  }, [])

  useEffect(() => {
    const q = query.trim()
    if (q.length < 3) { setSearchResults(null); return }
    setSearchStatus('loading')
    const t = setTimeout(() => {
      fetch(`${HADITH_API}/search?q=${encodeURIComponent(q)}&collection=${collection}&limit=20`)
        .then((r) => r.json())
        .then((json) => { setSearchResults(json?.data?.hadiths || []); setSearchStatus('idle') })
        .catch(() => setSearchStatus('error'))
    }, 350)
    return () => clearTimeout(t)
  }, [query, collection])

  useEffect(() => {
    if (query.trim().length >= 3) return
    setBrowseStatus('loading')
    fetch(`${HADITH_API}/${collection}?page=${page}&limit=${HADITH_PAGE_SIZE}`)
      .then((r) => r.json())
      .then((json) => setBrowse({
        hadiths: json?.data?.hadiths || [],
        total_pages: json?.data?.total_pages || 1,
      }))
      .catch(() => {})
      .finally(() => setBrowseStatus('idle'))
  }, [collection, page, query])

  function selectCollection(key) {
    setCollection(key)
    setPage(1)
    setRandomHadith(null)
  }

  function loadRandom() {
    setRandomStatus('loading')
    fetch(`${HADITH_API}/random?collection=${collection}`)
      .then((r) => r.json())
      .then((json) => { setRandomHadith(json?.data || null); setRandomStatus('idle') })
      .catch(() => setRandomStatus('error'))
  }

  const showingSearch = query.trim().length >= 3
  const list = showingSearch ? searchResults : browse.hadiths
  const status = showingSearch ? searchStatus : browseStatus

  return (
    <div>
      <div className="duas-collection-chips">
        {collections.map((c) => (
          <button
            key={c.key}
            className={`duas-collection-chip${collection === c.key ? ' active' : ''}`}
            onClick={() => selectCollection(c.key)}
          >
            {c.name}
          </button>
        ))}
      </div>

      <div className="duas-search">
        <span className="material-symbols-outlined">search</span>
        <input
          type="text"
          placeholder={`Search ${collections.find((c) => c.key === collection)?.name || 'hadith'}…`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {!showingSearch && (
        <button className="duas-load-more" onClick={loadRandom} disabled={randomStatus === 'loading'}>
          🎲 Random hadith from this collection
        </button>
      )}

      {randomHadith && !showingSearch && (
        <div className="duas-card">
          <p className="duas-arabic">{randomHadith.arabic}</p>
          <p className="duas-translation">{randomHadith.english}</p>
          <p className="duas-source">{randomHadith.collection_name} #{randomHadith.hadithnumber}{randomHadith.grade ? ` · ${randomHadith.grade}` : ''}</p>
        </div>
      )}

      <div className="duas-list">
        {status === 'loading' && <p className="duas-disclaimer">Loading…</p>}
        {status === 'error' && <p className="duas-disclaimer">Couldn't reach the hadith service — check your connection.</p>}
        {status === 'idle' && list?.length === 0 && (
          <p className="duas-disclaimer">{showingSearch ? `No hadith found for "${query.trim()}".` : 'No hadith found.'}</p>
        )}
        {list?.map((h) => (
          <div key={h.id} className="duas-card">
            {h.arabic && <p className="duas-arabic">{h.arabic}</p>}
            <p className="duas-translation">{h.english}</p>
            <p className="duas-source">{h.collection_name} #{h.hadithnumber}{h.grade ? ` · ${h.grade}` : ''}</p>
          </div>
        ))}
      </div>

      {!showingSearch && browse.total_pages > 1 && (
        <div className="duas-names-pager">
          <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Prev</button>
          <span>Page {page} / {browse.total_pages}</span>
          <button disabled={page >= browse.total_pages} onClick={() => setPage((p) => p + 1)}>Next</button>
        </div>
      )}
    </div>
  )
}

const NAMES_API = 'https://ummahapi.com/api/names'
const NAMES_PAGE_SIZE = 20

// ── Names tab — live from UmmahAPI (210 Islamic names, meaning/origin/gender), same
// no-signup/CORS-open source as the Dua tab. Search takes priority over browsing;
// clearing the query goes back to the paginated browse list.
function NamesTab() {
  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState(null)
  const [searchStatus, setSearchStatus] = useState('idle')
  const [gender, setGender] = useState('') // '' | 'male' | 'female'
  const [page, setPage] = useState(1)
  const [browse, setBrowse] = useState({ names: [], total: 0, total_pages: 1 })
  const [browseStatus, setBrowseStatus] = useState('loading')

  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) { setSearchResults(null); return }
    setSearchStatus('loading')
    const t = setTimeout(() => {
      fetch(`${NAMES_API}/search?q=${encodeURIComponent(q)}&limit=30`)
        .then((r) => r.json())
        .then((json) => { setSearchResults(json?.data?.names || []); setSearchStatus('idle') })
        .catch(() => setSearchStatus('error'))
    }, 300)
    return () => clearTimeout(t)
  }, [query])

  useEffect(() => {
    if (query.trim().length >= 2) return
    setBrowseStatus('loading')
    const genderParam = gender ? `&gender=${gender}` : ''
    fetch(`${NAMES_API}?page=${page}&limit=${NAMES_PAGE_SIZE}${genderParam}`)
      .then((r) => r.json())
      .then((json) => setBrowse({
        names: json?.data?.names || [],
        total: json?.data?.total || 0,
        total_pages: json?.data?.total_pages || 1,
      }))
      .catch(() => {})
      .finally(() => setBrowseStatus('idle'))
  }, [page, gender, query])

  const showingSearch = query.trim().length >= 2
  const list = showingSearch ? searchResults : browse.names
  const status = showingSearch ? searchStatus : browseStatus

  return (
    <div>
      <div className="duas-search">
        <span className="material-symbols-outlined">search</span>
        <input
          type="text"
          placeholder="Search names by meaning or spelling"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {!showingSearch && (
        <div className="duas-script-toggle">
          <button className={gender === '' ? 'active' : ''} onClick={() => { setGender(''); setPage(1) }}>All</button>
          <button className={gender === 'male' ? 'active' : ''} onClick={() => { setGender('male'); setPage(1) }}>Boys</button>
          <button className={gender === 'female' ? 'active' : ''} onClick={() => { setGender('female'); setPage(1) }}>Girls</button>
        </div>
      )}

      <div className="duas-list">
        {status === 'loading' && <p className="duas-disclaimer">Loading…</p>}
        {status === 'error' && <p className="duas-disclaimer">Couldn't reach the names service — check your connection.</p>}
        {status === 'idle' && list?.length === 0 && (
          <p className="duas-disclaimer">{showingSearch ? `No names found for "${query.trim()}".` : 'No names found.'}</p>
        )}
        {list?.map((n) => (
          <div key={n.id} className="duas-card">
            <p className="duas-arabic">{n.arabic}</p>
            <p className="duas-translit">{n.name} <span className="duas-source">· {n.gender === 'male' ? 'Boy' : n.gender === 'female' ? 'Girl' : n.gender}</span></p>
            <p className="duas-translation">{n.meaning}</p>
            {n.note && <p className="duas-translation duas-translation--hindi">{n.note}</p>}
            <p className="duas-source">{n.origin}{n.root ? ` · root ${n.root}` : ''}</p>
          </div>
        ))}
      </div>

      {!showingSearch && browse.total_pages > 1 && (
        <div className="duas-names-pager">
          <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Prev</button>
          <span>Page {page} / {browse.total_pages}</span>
          <button disabled={page >= browse.total_pages} onClick={() => setPage((p) => p + 1)}>Next</button>
        </div>
      )}
    </div>
  )
}

// ── Dua tab — live from UmmahAPI (126 duas across 27 categories, no signup/key
// required, CORS-open). Categories load up front; each category's duas load lazily
// on first expand and are cached in state so re-opening doesn't refetch. No audio or
// Hindi translation is available from this source (unlike the Quran tab's per-ayah data).
function DuaTab() {
  const [categories, setCategories] = useState([])
  const [categoriesStatus, setCategoriesStatus] = useState('loading')
  const [openCategory, setOpenCategory] = useState(null)
  const [duasByCategory, setDuasByCategory] = useState({})
  const [categoryStatus, setCategoryStatus] = useState({})
  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState(null)
  const [searchStatus, setSearchStatus] = useState('idle')
  const [randomDua, setRandomDua] = useState(null)
  const [randomStatus, setRandomStatus] = useState('idle')

  function loadCategory(id) {
    setCategoryStatus((s) => ({ ...s, [id]: 'loading' }))
    fetch(`${DUAS_API}/category/${id}`)
      .then((r) => r.json())
      .then((json) => {
        setDuasByCategory((prev) => ({ ...prev, [id]: json?.data?.duas || [] }))
        setCategoryStatus((s) => ({ ...s, [id]: 'idle' }))
      })
      .catch(() => setCategoryStatus((s) => ({ ...s, [id]: 'error' })))
  }

  useEffect(() => {
    fetch(`${DUAS_API}/categories`)
      .then((r) => r.json())
      .then((json) => {
        const list = json?.data?.categories || []
        setCategories(list)
        setCategoriesStatus('idle')
        if (list[0]) { setOpenCategory(list[0].id); loadCategory(list[0].id) }
      })
      .catch(() => setCategoriesStatus('error'))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const q = query.trim()
    if (q.length < 3) { setSearchResults(null); return }
    setSearchStatus('loading')
    const t = setTimeout(() => {
      fetch(`${DUAS_API}/search?q=${encodeURIComponent(q)}`)
        .then((r) => r.json())
        .then((json) => { setSearchResults(json?.data?.results || []); setSearchStatus('idle') })
        .catch(() => setSearchStatus('error'))
    }, 350)
    return () => clearTimeout(t)
  }, [query])

  function toggleCategory(id) {
    setOpenCategory((prev) => (prev === id ? null : id))
    if (!duasByCategory[id] && categoryStatus[id] !== 'loading') loadCategory(id)
  }

  function loadRandomDua() {
    setRandomStatus('loading')
    fetch(`${DUAS_API}/random`)
      .then((r) => r.json())
      .then((json) => { setRandomDua(json?.data || null); setRandomStatus('idle') })
      .catch(() => setRandomStatus('error'))
  }

  if (categoriesStatus === 'loading') return <p className="duas-disclaimer">Loading categories…</p>
  if (categoriesStatus === 'error') return <p className="duas-disclaimer">Couldn't load duas — check your connection.</p>

  const showingSearch = query.trim().length >= 3

  return (
    <div>
      <div className="duas-search">
        <span className="material-symbols-outlined">search</span>
        <input
          type="text"
          placeholder="Search duas by title, meaning or translation"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {!showingSearch && (
        <button className="duas-load-more" onClick={loadRandomDua} disabled={randomStatus === 'loading'}>
          🎲 Random dua
        </button>
      )}

      {randomDua && !showingSearch && (
        <div className="duas-card">
          <p className="duas-arabic">{randomDua.arabic}</p>
          <p className="duas-translit">{randomDua.transliteration}</p>
          <p className="duas-translation">{randomDua.translation}</p>
          <p className="duas-source">{cleanDuaSource(randomDua.source)}{randomDua.repeat > 1 ? ` — repeat ${randomDua.repeat}×` : ''}</p>
        </div>
      )}

      {showingSearch ? (
        <div className="duas-list">
          {searchStatus === 'loading' && <p className="duas-disclaimer">Searching…</p>}
          {searchStatus === 'error' && <p className="duas-disclaimer">Couldn't reach the duas service — check your connection.</p>}
          {searchStatus === 'idle' && searchResults?.length === 0 && (
            <p className="duas-disclaimer">No duas found for "{query.trim()}".</p>
          )}
          {searchResults?.map((dua) => (
            <div key={dua.id} className="duas-card">
              <p className="duas-arabic">{dua.arabic}</p>
              <p className="duas-translit">{dua.transliteration}</p>
              <p className="duas-translation">{dua.translation}</p>
              <p className="duas-source">{cleanDuaSource(dua.source)}{dua.repeat > 1 ? ` — repeat ${dua.repeat}×` : ''}</p>
            </div>
          ))}
        </div>
      ) : (
      <div className="duas-categories">
      {categories.map((cat) => {
        const isOpen = openCategory === cat.id
        const duas = duasByCategory[cat.id]
        const status = categoryStatus[cat.id]
        return (
          <div key={cat.id} className="duas-category">
            <button className="duas-category-toggle" onClick={() => toggleCategory(cat.id)}>
              <span className="duas-category-icon"><span className="material-symbols-outlined">{DUA_CATEGORY_ICONS[cat.id] || 'volunteer_activism'}</span></span>
              <span className="duas-category-title">{cat.name}</span>
              <span className={`material-symbols-outlined duas-category-chevron${isOpen ? ' open' : ''}`}>expand_more</span>
            </button>

            {isOpen && (
              <div className="duas-list">
                {status === 'loading' && <p className="duas-disclaimer">Loading…</p>}
                {status === 'error' && <p className="duas-disclaimer">Couldn't load this category.</p>}
                {duas?.map((dua) => (
                  <div key={dua.id} className="duas-card">
                    <p className="duas-arabic">{dua.arabic}</p>
                    <p className="duas-translit">{dua.transliteration}</p>
                    <p className="duas-translation">{dua.translation}</p>
                    <p className="duas-source">{cleanDuaSource(dua.source)}{dua.repeat > 1 ? ` — repeat ${dua.repeat}×` : ''}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}
      </div>
      )}
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
      {activeTab === 'names' && <NamesTab />}
      {activeTab === 'hadith2' && <HadithApiTab />}
    </div>
  )
}
