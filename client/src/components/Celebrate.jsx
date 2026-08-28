// Ported from the reference app's Celebrate.tsx - confetti-burst success banner and the
// 3D-tilt badge card, both reused verbatim across Khatabook/Milestones. Material Symbols
// swap in for the reference's lucide-react PartyPopper icon (no lucide dependency here).

import { useEffect, useState } from 'react'

export function Celebrate({ show, message }) {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (!show) return
    setVisible(true)
    const t = setTimeout(() => setVisible(false), 3200)
    return () => clearTimeout(t)
  }, [show, message])

  if (!visible) return null

  const pieces = Array.from({ length: 18 }, (_, i) => i)
  const colors = ['var(--chart-1)', 'var(--chart-2)', 'var(--color-gold)', 'var(--color-success)']

  return (
    <div aria-live="polite" className="pointer-events-none fixed inset-x-0 top-6 z-50 flex justify-center px-4">
      <div className="relative">
        <div className="animate-pop flex items-center gap-2 rounded-full border border-gold/40 bg-card px-5 py-2.5 shadow-[var(--shadow-glow)]">
          <span className="material-symbols-outlined text-lg text-gold">celebration</span>
          <p className="text-sm font-bold">{message}</p>
        </div>
        {pieces.map((i) => (
          <span
            key={i}
            className="absolute left-1/2 top-1/2 size-1.5 rounded-[2px] animate-float"
            style={{
              background: colors[i % colors.length],
              transform: `translate(${(i - 9) * 14}px, ${((i * 37) % 40) - 20}px) rotate(${i * 33}deg)`,
              animationDelay: `${(i % 6) * 0.09}s`,
              opacity: 0.85,
            }}
          />
        ))}
      </div>
    </div>
  )
}

export function Badge3D({ title, hint, earned, icon }) {
  return (
    <div
      className={`flex items-center gap-3 rounded-2xl border p-3.5 transition-all duration-300 ${
        earned ? 'border-gold/40 bg-gold-soft shadow-[var(--shadow-glow)]' : 'border-border bg-secondary/40 opacity-60'
      }`}
    >
      <span
        className={`grid size-10 shrink-0 place-items-center rounded-xl ${
          earned ? 'bg-[image:var(--gradient-gold)] text-accent-foreground' : 'bg-card text-muted-foreground'
        }`}
      >
        {icon}
      </span>
      <div className="min-w-0">
        <p className="truncate text-sm font-bold">{title}</p>
        <p className="truncate text-xs text-muted-foreground">{hint}</p>
      </div>
    </div>
  )
}
