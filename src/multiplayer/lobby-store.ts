import { isRoomCode } from './invite';
export type HostLobby<Profile> = { code: string; token?: string; profile: Profile };
const maxAge = 2 * 60 * 60 * 1000;

function storage() {
  const installed = matchMedia('(display-mode: standalone), (display-mode: minimal-ui), (display-mode: window-controls-overlay)').matches
    || (navigator as Navigator & { standalone?: boolean }).standalone;
  return installed ? localStorage : sessionStorage;
}

export function createLobbyStore<Profile>(key: string, isProfile: (value: unknown) => value is Profile, validCode = isRoomCode) {
  function read(): HostLobby<Profile> | null {
    try {
      const saved = JSON.parse(storage().getItem(key) ?? 'null');
      if (saved && typeof saved.code === 'string' && validCode(saved.code) && isProfile(saved.profile)
        && Number.isFinite(saved.savedAt) && Date.now() - saved.savedAt < maxAge) {
        // Older saves lack a credential. Reuse one across windows only with exclusive ownership.
        const token = navigator.locks && typeof saved.token === 'string' && /^[a-f0-9-]{36}$/i.test(saved.token)
          ? saved.token : undefined;
        return { code: saved.code, profile: saved.profile, token };
      }
    } catch { /* Storage can be unavailable in a private window. */ }
    return null;
  }

  function remember(lobby: HostLobby<Profile>) {
    try { storage().setItem(key, JSON.stringify({ ...lobby, savedAt: Date.now() })); }
    catch { /* A suspended page can still recover from memory. */ }
  }

  function forget(lobby: HostLobby<Profile>) {
    try {
      const saved = read();
      if (saved?.code === lobby.code && (!navigator.locks || saved.token === lobby.token)) storage().removeItem(key);
    } catch { /* Storage is optional. */ }
  }
  return { read, remember, forget };
}
