import { useCallback, useEffect, useState } from 'react'
import { NavLink, Outlet } from 'react-router'
import { supabase } from '../lib/supabase'
import AvatarImage from './AvatarImage'
import ProfileEditor from './ProfileEditor'
import Toast from './Toast'

// Imports are direct — no barrel files (bundle-barrel-imports).

/**
 * Shared layout for all authenticated routes.
 *
 * Renders the top header (navigation tabs + profile) and an <Outlet /> for the
 * matched child route. Profile state (displayName, avatar, ProfileEditor) lives
 * here so it persists across route changes.
 *
 * @param {{
 *   userId: string,
 *   userEmail: string | undefined,
 *   theme: string,
 *   onToggleTheme: () => void,
 *   onSignOut: () => void,
 * }} props
 */
export default function Layout({ userId, userEmail, theme, onToggleTheme, onSignOut }) {
  const [displayName, setDisplayName] = useState(/** @type {string | null} */ (null))
  const [avatarSignedUrl, setAvatarSignedUrl] = useState(/** @type {string | null} */ (null))
  const [profileEditorOpen, setProfileEditorOpen] = useState(false)
  const [toast, setToast] = useState(/** @type {string | null} */ (null))
  const dismissToast = useCallback(() => setToast(null), [])

  // ── Fetch profile on mount ──────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    async function fetchProfile() {
      const { data: profile } = await supabase
        .from('users')
        .select('display_name, avatar_path')
        .eq('id', userId)
        .single()
      if (cancelled) return
      setDisplayName(profile?.display_name ?? null)
      const path = profile?.avatar_path ?? null
      if (path) {
        const { data: urlData } = await supabase.storage
          .from('avatars')
          .createSignedUrl(path, 3600)
        if (!cancelled) setAvatarSignedUrl(urlData?.signedUrl ?? null)
      }
    }
    fetchProfile()
    return () => { cancelled = true }
  }, [userId])

  // ── Profile callbacks ───────────────────────────────────────────────────

  const handleProfileSave = useCallback(async (name) => {
    const { error } = await supabase
      .from('users')
      .update({ display_name: name })
      .eq('id', userId)
    if (error) throw error
    setDisplayName(name)
    setProfileEditorOpen(false)
    setToast('Profile saved')
  }, [userId])

  const handleAvatarSave = useCallback(async (path) => {
    const { data } = await supabase.storage.from('avatars').createSignedUrl(path, 3600)
    setAvatarSignedUrl(data?.signedUrl ?? null)
  }, [])

  // NavLink className callback — adds the active modifier when the link
  // matches the current URL (rerender-no-inline-components: the callback is
  // a stable arrow re-created per render, but NavLink requires it inline).
  /** @param {{ isActive: boolean }} props */
  function tabClass({ isActive }) {
    return `btn notes-tab${isActive ? ' notes-tab--active' : ''}`
  }

  return (
    <div className="notes-layout">
      <header className="notes-header">
        <div className="notes-tabs">
          <NavLink to="/" end className={tabClass}>
            Notes
          </NavLink>
          <NavLink to="/archived" className={tabClass}>
            Archived
          </NavLink>
          <NavLink to="/shared" className={tabClass}>
            Shared with me
          </NavLink>
          <NavLink to="/documents" className={tabClass}>
            Documents
          </NavLink>
        </div>
        <div className="notes-header-actions">
          <button
            type="button"
            className="btn btn-ghost notes-profile-btn"
            onClick={() => setProfileEditorOpen(true)}
            aria-label="Edit profile"
          >
            <AvatarImage
              key={avatarSignedUrl}
              signedUrl={avatarSignedUrl}
              displayName={displayName}
              email={userEmail}
              size="sm"
            />
            <span className="notes-user">{displayName ?? userEmail}</span>
          </button>
          <button type="button" className="btn btn-ghost" onClick={onSignOut}>
            Sign out
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={onToggleTheme}
            aria-label="Toggle day/night theme"
          >
            {theme === 'light' ? '🌙' : '☀️'}
          </button>
        </div>
      </header>

      <Outlet context={{ displayName, userEmail, avatarSignedUrl }} />

      {profileEditorOpen ? (
        <ProfileEditor
          initialName={displayName ?? userEmail ?? ''}
          userId={userId}
          initialAvatarSignedUrl={avatarSignedUrl}
          onSave={handleProfileSave}
          onAvatarSave={handleAvatarSave}
          onCancel={() => setProfileEditorOpen(false)}
        />
      ) : null}

      <Toast message={toast} onDismiss={dismissToast} />
    </div>
  )
}
