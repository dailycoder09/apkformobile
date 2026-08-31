import { useState, useEffect } from 'react'

// Generic 2-page swipe carousel for mobile screens that would otherwise be one long scroll —
// first used to split Milestones into a focus page + analytics page, now reused for Khatabook.
// Native touch events + a CSS transform, no swipe library. Desktop keeps its own non-carousel
// layout (rendered separately by the caller), so this component is mobile-only by convention.
export default function SwipeCarousel({ children, hintNext, hintPrev, compact = false }) {
  const [page, setPage] = useState(0)
  const [dragStart, setDragStart] = useState(null)

  // stopPropagation so a carousel nested inside another one (e.g. a small
  // hero-card/calendar pair embedded in a page that's itself one page of an outer
  // carousel) doesn't also register as a swipe on the outer instance — without this,
  // the same touch gesture could flip both at once.
  const handleTouchStart = (e) => {
    e.stopPropagation()
    setDragStart(e.touches[0].clientX)
  }

  const handleTouchEnd = (e) => {
    if (dragStart === null) return
    e.stopPropagation()
    const diff = dragStart - e.changedTouches[0].clientX
    setDragStart(null)
    if (Math.abs(diff) < 30) return // dead zone
    if (diff > 0 && page < 1) setPage(1)
    else if (diff < 0 && page > 0) setPage(0)
  }

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'ArrowRight' && page < 1) setPage(1)
      if (e.key === 'ArrowLeft' && page > 0) setPage(0)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [page])

  return (
    <div className="flex h-full flex-col overflow-hidden" onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd}>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div
          className="flex h-full transition-transform duration-300 ease-out"
          style={{ transform: `translateX(${-page * 100}%)` }}
        >
          {/* overscroll-y-contain: each page sits inside PageShell's own overflow-y-auto
              scroll container (which always has a little genuine scroll room of its own —
              e.g. the decorative glow-orb absolutely positioned near the page bottom extends
              past the visible content). Without containment, a vertical drag that runs out of
              room inside this page chains straight into that outer scroller mid-gesture —
              content jerks/catches instead of just stopping, and on a page with no internal
              overflow at all the touch can drag the *entire* carousel (dots included) instead
              of the page content. Matches the same fix already used by .message-list in
              index.css for an analogous nested-scroller case. */}
          <div className={`w-full shrink-0 overflow-y-auto overscroll-y-contain ${compact ? 'pb-8' : 'pb-24'}`}>{children[0]}</div>
          <div className={`w-full shrink-0 overflow-y-auto overscroll-y-contain ${compact ? 'pb-8' : 'pb-24'}`}>{children[1]}</div>
        </div>
      </div>

      {/* A real flex sibling below the pages (not an absolute overlay on top of them) — dots
          and the swipe hint used to float `absolute` over the page content, which looked fine
          on tall pages but visibly covered real content (a stat value, a section label) on
          shorter ones, since the overlay's position had no idea how much content sat beneath
          it. Reserving actual layout space here means content is never covered, on any page,
          at the cost of the pages area getting very slightly shorter to make room. */}
      <CarouselFooter page={page} setPage={setPage} compact={compact} text={page === 0 ? hintNext : hintPrev} />
    </div>
  )
}

function CarouselFooter({ page, setPage, compact, text }) {
  const [show, setShow] = useState(Boolean(text))

  useEffect(() => {
    if (!text) { setShow(false); return }
    setShow(true)
    const timer = setTimeout(() => setShow(false), 3000)
    return () => clearTimeout(timer)
  }, [text])

  const hintVisible = show && Boolean(text)

  return (
    <div
      className={`relative z-40 flex shrink-0 flex-col items-center justify-end gap-1.5 transition-[height] duration-300 ${
        compact ? (hintVisible ? 'h-14' : 'h-6') : (hintVisible ? 'h-16' : 'h-8')
      }`}
    >
      {hintVisible && (
        <div className="animate-fade-in whitespace-nowrap rounded-full bg-black/60 px-3 py-1.5 text-xs text-white backdrop-blur">
          {text}
        </div>
      )}
      <div className="flex gap-2 pb-1.5">
        {[0, 1].map((i) => (
          <button
            key={i}
            onClick={() => setPage(i)}
            className={`size-2 rounded-full transition-all duration-300 ${page === i ? 'bg-gold w-6' : 'bg-muted-foreground/40'}`}
            aria-label={`Go to page ${i + 1}`}
          />
        ))}
      </div>
    </div>
  )
}
