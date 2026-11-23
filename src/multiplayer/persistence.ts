import { createLobbyStore } from "./lobby-store";
import { createRoomCodes } from "./invite";

export type LobbySettings<Profile, Settings> = { player: Profile; size: Settings; public: boolean };

export function createRoomPersistence<Profile, Settings>(options: {
  namespace: string;
  codes?: ReturnType<typeof createRoomCodes>;
  roomKey?: string;
  lobbyKey?: string;
  isProfile: (value: unknown) => value is Profile;
  isSettings: (value: unknown) => value is Settings;
}) {
  const codes = options.codes ?? createRoomCodes();
  const roomKey = options.roomKey ?? options.namespace + ":match";
  const waitingHost = createLobbyStore(options.lobbyKey ?? options.namespace + ":waiting-host",
    (value): value is LobbySettings<Profile, Settings> => {
      const data = value as Partial<LobbySettings<Profile, Settings>> | null;
      return !!data && options.isProfile(data.player) && options.isSettings(data.size) && typeof data.public === "boolean";
    }, codes.isRoomCode);
  function read(): unknown {
    try { return JSON.parse(sessionStorage.getItem(roomKey) ?? "null"); } catch { return null; }
  }
  function remember(value: unknown) {
    try { sessionStorage.setItem(roomKey, JSON.stringify(value)); } catch { /* Storage is optional. */ }
  }
  function clear() {
    try { sessionStorage.removeItem(roomKey); } catch { /* Storage is optional. */ }
  }
  type SavedSeat = { room: { code: string; status: string }; seat: string; ticket: string; hostToken?: string; deviceSaved?: boolean };
  const prefix = roomKey + ":active:";
  function isSeat(value: unknown): value is SavedSeat {
    const save = value as Partial<SavedSeat> | null;
    return !!save?.room && codes.isRoomCode(save.room.code) && typeof save.ticket === "string" &&
      (save.seat === "Player1" || save.seat === "Player2");
  }
  function active(save: SavedSeat) {
    return save.room.status === "active" || save.room.status === "finished";
  }
  function seatKey(save: SavedSeat) {
    return prefix + save.room.code + ":" + save.seat;
  }
  function deviceRecord(key: string) {
    const raw = localStorage.getItem(key);
    if (!raw) return;
    try {
      const entry = JSON.parse(raw);
      if (isSeat(entry?.save) && active(entry.save) && key === seatKey(entry.save) && Number.isFinite(entry.time))
        return entry as { save: SavedSeat; time: number };
    } catch { /* An unreadable record must not hide the other rooms. */ }
  }
  function readMatch(code?: string): unknown {
    const tab = read();
    const current = isSeat(tab) && (!code || tab.room.code === code) ? tab : undefined;
    if (current?.room.status === "abandoned") return null;
    try {
      if (!navigator.locks) return current;
      if (current) {
        const device = deviceRecord(seatKey(current))?.save;
        if (device?.seat === current.seat && (device.ticket === current.ticket ||
          (current.hostToken && current.hostToken === device.hostToken))) return device;
        // A missing mirror means this seat was explicitly released in another window.
        return current.deviceSaved ? undefined : current;
      }
      let latest: ReturnType<typeof deviceRecord>;
      const searchPrefix = code ? prefix + code + ":" : prefix;
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key?.startsWith(searchPrefix)) continue;
        const entry = deviceRecord(key);
        if (entry && (!latest || entry.time > latest.time)) latest = entry;
      }
      return latest?.save;
    } catch { return current; }
  }
  function saveMatch(save: SavedSeat) {
    if (active(save) && navigator.locks) {
      try {
        localStorage.setItem(seatKey(save), JSON.stringify({ save, time: Date.now() }));
        remember({ ...save, deviceSaved: true });
        return;
      } catch { /* Fall back to the original tab when device storage is unavailable. */ }
    }
    remember(save);
  }
  function forgetMatch(save: SavedSeat) {
    const sameSeat = (other: unknown) => isSeat(other) && other.room.code === save.room.code &&
      other.seat === save.seat && other.ticket === save.ticket;
    try {
      const key = seatKey(save);
      if (sameSeat(deviceRecord(key)?.save)) localStorage.removeItem(key);
    } catch { /* The tab can still release its own save. */ }
    if (sameSeat(read())) clear();
  }
  return { namespace: options.namespace, codes, isProfile: options.isProfile, waitingHost,
    read, remember, clear, readMatch, saveMatch, forgetMatch };
}
export type RoomPersistence<P, S> = ReturnType<typeof createRoomPersistence<P, S>>;
