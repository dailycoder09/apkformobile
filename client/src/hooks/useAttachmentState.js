import { useState } from 'react'

// Generic helper backing the photo/video/"any file" strips — all three follow the
// identical existing/new/removed shape, they just differ in what they store as
// metadata alongside the blob (photo/video need none extra, files need a name).
// Extracted out of JournalEntriesScreen.jsx so any compose screen (Journal, Health
// episodes/reminders) can share one implementation.
export default function useAttachmentState() {
  const [existing, setExisting] = useState([])
  const [added, setAdded] = useState([])
  const [removedIds, setRemovedIds] = useState([])

  function addBlobs(items) {
    setAdded((prev) => [...prev, ...items])
  }
  function removeAdded(index) {
    setAdded((prev) => {
      URL.revokeObjectURL(prev[index].url)
      return prev.filter((_, i) => i !== index)
    })
  }
  function removeExisting(id) {
    setExisting((prev) => prev.filter((item) => item.id !== id))
    setRemovedIds((prev) => [...prev, id])
  }

  return { existing, setExisting, added, removedIds, addBlobs, removeAdded, removeExisting }
}
