import { useEffect, useRef, useState } from 'react'
import { getCache, setCache } from '../lib/offlineCache'

// Same-origin in the browser, absolute host in the native app — meeee_server is set by
// Login.jsx on every user login, same pattern used for the update-check fetch in App.jsx.
function httpBase() {
  return (localStorage.getItem('meeee_server') || '').trim().replace(/\/$/, '')
}

export default function ProfilePage({ session, sendMsg, addListener }) {
  // Seeded from cache so something real renders even offline, before profile_get's reply
  // (or lack thereof) arrives.
  const cachedProfile = getCache('profile', session.userId)
  const [profile, setProfile] = useState(() => cachedProfile || null)
  const [firstName, setFirstName] = useState(() => cachedProfile?.firstName || '')
  const [lastName, setLastName] = useState(() => cachedProfile?.lastName || '')
  const [email, setEmail] = useState(() => cachedProfile?.email || '')
  const [photoFile, setPhotoFile] = useState(null)
  const [photoPreview, setPhotoPreview] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const fileInputRef = useRef(null)

  useEffect(() => {
    return addListener((msg) => {
      if (msg.type === 'profile' && msg.userId === session.userId) {
        setProfile(msg.profile)
        setFirstName(msg.profile.firstName || '')
        setLastName(msg.profile.lastName || '')
        setEmail(msg.profile.email || '')
        setCache('profile', session.userId, msg.profile)
      }
    })
  }, [addListener, session.userId])

  // No payload — server resolves "own profile" from the authenticated session
  useEffect(() => {
    sendMsg({ type: 'profile_get' })
  }, [sendMsg])

  // Release the object URL created for the local preview once it's no longer needed
  useEffect(() => {
    return () => { if (photoPreview) URL.revokeObjectURL(photoPreview) }
  }, [photoPreview])

  const handlePhotoChange = (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setPhotoFile(file)
    setPhotoPreview(URL.createObjectURL(file))
    setSaved(false)
  }

  const handleSave = async (e) => {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      sendMsg({
        type: 'profile_update',
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: email.trim(),
      })

      if (photoFile) {
        // Raw binary body — the server expects just the image bytes, not multipart/FormData.
        const res = await fetch(`${httpBase()}/api/profile-photo/${session.userId}`, {
          method: 'POST',
          headers: {
            'Content-Type': photoFile.type || 'application/octet-stream',
            'X-Upload-Token': session.uploadToken || '',
          },
          body: photoFile,
        })
        if (!res.ok) {
          throw new Error(res.status === 413 ? 'Photo is too large (max 5MB)' : 'Photo upload failed')
        }
        const data = await res.json()
        setProfile((p) => ({ ...(p || {}), photoUrl: data.photoUrl }))
        setPhotoFile(null)
      }

      setSaved(true)
    } catch (err) {
      setError(err.message || 'Could not save profile')
    } finally {
      setSaving(false)
    }
  }

  const displayPhoto = photoPreview || (profile?.photoUrl ? `${httpBase()}${profile.photoUrl}` : '')

  return (
    <div className="profile-page">
      <div className="profile-header">
        <h1 className="profile-title">My Profile</h1>
        <p className="profile-subtitle">{session.name}</p>
      </div>

      <div className="profile-photo-section">
        <button
          type="button"
          className="profile-photo-wrap"
          onClick={() => fileInputRef.current?.click()}
          aria-label="Change photo"
        >
          {displayPhoto
            ? <img className="profile-photo-img" src={displayPhoto} alt="" />
            : <span className="profile-photo-placeholder">{(session.name || 'U')[0].toUpperCase()}</span>}
          <span className="profile-photo-edit">✎</span>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="profile-photo-input"
          onChange={handlePhotoChange}
        />
      </div>

      <form className="profile-form" onSubmit={handleSave}>
        <div className="profile-field">
          <label className="profile-field-label" htmlFor="profile-first">First name</label>
          <input
            id="profile-first"
            className="profile-field-input"
            type="text"
            value={firstName}
            onChange={(e) => { setFirstName(e.target.value); setSaved(false) }}
            maxLength={40}
          />
        </div>

        <div className="profile-field">
          <label className="profile-field-label" htmlFor="profile-last">Last name</label>
          <input
            id="profile-last"
            className="profile-field-input"
            type="text"
            value={lastName}
            onChange={(e) => { setLastName(e.target.value); setSaved(false) }}
            maxLength={40}
          />
        </div>

        <div className="profile-field">
          <label className="profile-field-label" htmlFor="profile-email">Email</label>
          <input
            id="profile-email"
            className="profile-field-input"
            type="email"
            value={email}
            onChange={(e) => { setEmail(e.target.value); setSaved(false) }}
            maxLength={80}
          />
        </div>

        {error && <div className="profile-error">{error}</div>}
        {saved && !error && <div className="profile-saved">Saved ✓</div>}

        <button type="submit" className="profile-save-btn" disabled={saving}>
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </form>
    </div>
  )
}
