import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import ThemePicker from './ThemePicker'

// Same-origin in the browser, absolute host in the native app — mirrors the helper that
// used to live in the standalone ProfileTrigger.jsx (now folded into this component) and
// still lives in ProfilePage.jsx, the other place this same photoUrl gets resolved to a URL.
function httpBase() {
  return (localStorage.getItem('meeee_server') || '').trim().replace(/\/$/, '')
}

// Single fixed top-right "more" control, mounted once at the App root. Replaces what used
// to be TWO always-visible corner buttons (ThemePicker's own trigger, top-right, and a
// dedicated ProfileTrigger avatar, top-left) with one small kebab button that reveals both
// destinations in a dropdown. One small trigger instead of two 46px circles removes an
// entire class of "floating corner button collides with a page's title/header" bugs
// instead of just reserving more top padding for it on every screen (see PageShell.jsx and
// the .namaz-screen / .txn-header padding comments this replaces).
//
// Theme logic itself is not duplicated here — ThemePicker.jsx keeps 100% of its hue/chroma
// state, presets, harmonies, and saved-themes logic; it's now a controlled panel (open/
// onClose props) instead of owning its own trigger, so this menu just toggles it. The
// profile-photo preview is the one piece of ProfileTrigger.jsx's rendering reused here
// (same fetch-on-mount + listener pattern) since it's small and only ever used from this
// one call site now.
export default function CornerMenu({ session, sendMsg, addListener, showProfile, onProfileOpen, extraItems }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [themeOpen, setThemeOpen] = useState(false)
  const [photoUrl, setPhotoUrl] = useState('')
  const [dropdownPos, setDropdownPos] = useState(null)
  const rootRef = useRef(null)
  const triggerRef = useRef(null)
  const dropdownRef = useRef(null)

  // The dropdown is portaled to <body> (see the render below) instead of living inside this
  // component's own DOM subtree. Several of this app's headers (PageShell's `animate-fade-up`
  // header, in particular) apply a CSS `transform` for their entrance animation, and any
  // transformed ancestor creates its own stacking context — that silently traps a plain
  // `position: absolute` dropdown's z-index *inside* that header, so page content rendered
  // after the header in the DOM (a carousel, a stat tile, ...) paints over it and swallows
  // clicks, even though the dropdown is still visibly drawn on top. Portaling to <body> and
  // positioning it with `fixed` + real viewport coordinates (measured from the trigger)
  // sidesteps that entirely, matching how most component libraries render popovers/menus.
  useLayoutEffect(() => {
    if (!menuOpen || !triggerRef.current) { setDropdownPos(null); return }
    const place = () => {
      const r = triggerRef.current.getBoundingClientRect()
      setDropdownPos({ top: r.bottom + 8, right: Math.max(8, window.innerWidth - r.right) })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [menuOpen])

  useEffect(() => {
    if (!session || !addListener) return
    return addListener((msg) => {
      if (msg.type === 'profile' && msg.userId === session.userId) {
        setPhotoUrl(msg.profile?.photoUrl || '')
      }
    })
  }, [addListener, session])

  // No payload — server resolves "own profile" from the authenticated session, same call
  // ProfilePage.jsx makes; this just lets the menu preview the saved photo next to "Profile".
  useEffect(() => {
    if (!session || !sendMsg) return
    sendMsg({ type: 'profile_get' })
  }, [sendMsg, session])

  // Close the dropdown on an outside click/tap or Escape — the theme panel below keeps its
  // own explicit close button (unchanged from before), this only governs the small menu.
  useEffect(() => {
    if (!menuOpen) return
    function handlePointer(e) {
      // The dropdown itself lives in a <body> portal now (see above), so a click inside it
      // is NOT inside rootRef's own subtree — check both, or every click on a menu item
      // would register as "outside" and close the menu before its own onClick ever fires.
      const inRoot = rootRef.current && rootRef.current.contains(e.target)
      const inDropdown = dropdownRef.current && dropdownRef.current.contains(e.target)
      if (!inRoot && !inDropdown) setMenuOpen(false)
    }
    function handleKey(e) {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('mousedown', handlePointer)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handlePointer)
      document.removeEventListener('keydown', handleKey)
    }
  }, [menuOpen])

  const displayPhoto = photoUrl ? `${httpBase()}${photoUrl}` : ''

  return (
    <div className="corner-menu" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="corner-menu-trigger"
        aria-label="Open menu"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((v) => !v)}
      >
        <span className="material-symbols-outlined">more_vert</span>
      </button>

      {menuOpen && dropdownPos && createPortal(
        <div
          className="corner-menu-dropdown"
          role="menu"
          aria-label="Menu"
          ref={dropdownRef}
          style={{ top: dropdownPos.top, right: dropdownPos.right }}
        >
          {extraItems && extraItems.length > 0 && (
            <>
              {extraItems.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  role="menuitem"
                  className="corner-menu-item"
                  disabled={item.disabled}
                  onClick={() => { setMenuOpen(false); item.onClick?.() }}
                >
                  <span className="corner-menu-item-icon material-symbols-outlined">{item.icon}</span>
                  {item.label}
                </button>
              ))}
              <div className="corner-menu-divider" role="separator" />
            </>
          )}
          <button
            type="button"
            role="menuitem"
            className="corner-menu-item"
            onClick={() => { setMenuOpen(false); setThemeOpen(true) }}
          >
            <span className="corner-menu-item-icon material-symbols-outlined">palette</span>
            Theme
          </button>
          {showProfile && (
            <button
              type="button"
              role="menuitem"
              className="corner-menu-item"
              onClick={() => { setMenuOpen(false); onProfileOpen?.() }}
            >
              <span className="corner-menu-item-avatar">
                {displayPhoto
                  ? <img src={displayPhoto} alt="" />
                  : <span>{(session?.name || 'U')[0].toUpperCase()}</span>}
              </span>
              Profile
            </button>
          )}
        </div>,
        document.body
      )}

      <ThemePicker open={themeOpen} onClose={() => setThemeOpen(false)} />
    </div>
  )
}
