import { useEffect, useState } from 'react'
import {
  PRESETS, DEFAULT_THEME, harmonies, randomTheme, accentColor,
  loadTheme, saveTheme, loadCustomThemes, saveCustomThemes,
  applyTheme, clampHue, clampChroma,
} from '../utils/theme'

// Global color-theming control. Mounted once at the App root (inside CornerMenu.jsx) so
// its mount-time load/applyTheme effect below always runs on every screen (Tailwind-scoped
// or not), regardless of whether the panel itself is visible. All state is local - no
// Context needed, this is a self-contained control surface that reads/writes localStorage
// + CSS custom properties directly via applyTheme().
//
// Controlled by `open`/`onClose` rather than owning its own trigger button + open state -
// CornerMenu.jsx is the single entry point for both this and the Profile screen now, so it
// owns the toggle. The actual theming logic (presets, hue/intensity sliders, harmonies,
// saved custom themes) is untouched from before this split.
export default function ThemePicker({ open, onClose }) {
  const [theme, setTheme] = useState(DEFAULT_THEME)
  const [customThemes, setCustomThemes] = useState([])
  const [saveName, setSaveName] = useState('')

  useEffect(() => {
    const initial = loadTheme()
    setTheme(initial)
    applyTheme(initial)
    setCustomThemes(loadCustomThemes())
  }, [])

  function update(partial) {
    setTheme((prev) => {
      const next = {
        ...prev,
        ...partial,
        hue: clampHue(partial.hue ?? prev.hue),
        chroma: clampChroma(partial.chroma ?? prev.chroma),
      }
      applyTheme(next)
      saveTheme(next)
      return next
    })
  }

  function handleSave() {
    const name = saveName.trim() || `Theme ${customThemes.length + 1}`
    const entry = { ...theme, id: Date.now().toString(), name }
    const next = [entry, ...customThemes]
    setCustomThemes(next)
    saveCustomThemes(next)
    setSaveName('')
  }

  function handleDeleteSaved(id) {
    const next = customThemes.filter((t) => t.id !== id)
    setCustomThemes(next)
    saveCustomThemes(next)
  }

  function applySaved(t) {
    update({ hue: t.hue, chroma: t.chroma, mode: t.mode })
  }

  const chromaPct = Math.round(theme.chroma * 100)
  const matches = harmonies(theme.hue)

  if (!open) return null

  return (
    <div className="theme-picker-panel" role="dialog" aria-label="App colour picker">
          <div className="theme-picker-row theme-picker-header">
            <span className="theme-picker-title">App colour</span>
            <div className="theme-picker-header-actions">
              <button
                type="button"
                className="theme-picker-icon-btn"
                aria-label="Surprise me"
                title="Surprise me"
                onClick={() => update(randomTheme(theme.mode))}
              >
                <span className="material-symbols-outlined">shuffle</span>
              </button>
              <button
                type="button"
                className="theme-picker-icon-btn"
                aria-label="Reset to default"
                title="Reset to default"
                onClick={() => update(DEFAULT_THEME)}
              >
                <span className="material-symbols-outlined">restart_alt</span>
              </button>
              <button
                type="button"
                className="theme-picker-icon-btn"
                aria-label="Close"
                onClick={onClose}
              >
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>
          </div>

          <div className="theme-picker-mode-toggle">
            <button
              type="button"
              className={`theme-picker-mode-btn${theme.mode === 'light' ? ' is-active' : ''}`}
              onClick={() => update({ mode: 'light' })}
            >
              <span className="material-symbols-outlined">light_mode</span>
              Light
            </button>
            <button
              type="button"
              className={`theme-picker-mode-btn${theme.mode === 'dark' ? ' is-active' : ''}`}
              onClick={() => update({ mode: 'dark' })}
            >
              <span className="material-symbols-outlined">dark_mode</span>
              Dark
            </button>
          </div>

          <div className="theme-picker-section-label">Presets</div>
          <div className="theme-picker-preset-grid">
            {PRESETS.map((p) => {
              const active = p.hue === theme.hue && Math.abs(p.chroma - theme.chroma) < 0.001
              return (
                <button
                  type="button"
                  key={p.name}
                  className={`theme-picker-preset${active ? ' is-active' : ''}`}
                  title={p.name}
                  onClick={() => update({ hue: p.hue, chroma: p.chroma })}
                >
                  <span className="theme-picker-swatch-strip">
                    {p.swatch.map((color, i) => (
                      <span key={i} className="theme-picker-swatch-chip" style={{ backgroundColor: color }} />
                    ))}
                  </span>
                  {active && (
                    <span className="theme-picker-preset-check material-symbols-outlined">check</span>
                  )}
                </button>
              )
            })}
          </div>

          <div className="theme-picker-slider-block">
            <div className="theme-picker-slider-label">
              <span>Custom Hue</span>
              <span className="theme-picker-slider-value">{theme.hue}&deg;</span>
            </div>
            <input
              type="range"
              min="0"
              max="359"
              step="1"
              value={theme.hue}
              className="theme-picker-slider"
              onChange={(e) => update({ hue: Number(e.target.value) })}
              aria-label="Custom hue"
            />
          </div>

          <div className="theme-picker-slider-block">
            <div className="theme-picker-slider-label">
              <span>Intensity</span>
              <span className="theme-picker-slider-value">{chromaPct}</span>
            </div>
            <input
              type="range"
              min="2"
              max="24"
              step="1"
              value={chromaPct}
              className="theme-picker-slider"
              onChange={(e) => update({ chroma: Number(e.target.value) / 100 })}
              aria-label="Colour intensity"
            />
          </div>

          <div className="theme-picker-section-label">Perfect matches</div>
          <div className="theme-picker-harmony-grid">
            {matches.map((m) => (
              <button
                type="button"
                key={m.label}
                className="theme-picker-harmony-btn"
                onClick={() => update({ hue: m.hue })}
              >
                <span
                  className="theme-picker-harmony-dot"
                  style={{ backgroundColor: accentColor(m.hue, theme.chroma) }}
                />
                {m.label}
              </button>
            ))}
          </div>

          <div className="theme-picker-section-label">My themes</div>
          <div className="theme-picker-save-row">
            <input
              type="text"
              className="theme-picker-save-input"
              placeholder="Theme name"
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              maxLength={24}
            />
            <button type="button" className="theme-picker-save-btn" onClick={handleSave}>
              <span className="material-symbols-outlined">add</span>
            </button>
          </div>
          {customThemes.length > 0 && (
            <div className="theme-picker-saved-list">
              {customThemes.map((t) => (
                <div key={t.id} className="theme-picker-saved-row">
                  <button type="button" className="theme-picker-saved-apply" onClick={() => applySaved(t)}>
                    <span
                      className="theme-picker-harmony-dot"
                      style={{ backgroundColor: accentColor(t.hue, t.chroma) }}
                    />
                    <span className="theme-picker-saved-name">{t.name}</span>
                  </button>
                  <button
                    type="button"
                    className="theme-picker-icon-btn theme-picker-saved-delete"
                    aria-label={`Delete ${t.name}`}
                    onClick={() => handleDeleteSaved(t.id)}
                  >
                    <span className="material-symbols-outlined">close</span>
                  </button>
                </div>
              ))}
            </div>
          )}
    </div>
  )
}
