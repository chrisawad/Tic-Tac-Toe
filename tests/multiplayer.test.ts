import { afterEach, expect, it, vi } from 'vitest';
import { inviteURL, readInviteCode } from '../src/multiplayer';
import { createLobbyStore } from '../src/multiplayer/lobby-store';

afterEach(() => vi.unstubAllGlobals());

it('shares only the game path and room code and reads invites from another game path', () => {
  const link = inviteURL('ABC23', 'https://games.example/counter/?private=1#old');
  expect(link).toBe('https://games.example/counter/?room=ABC23');
  expect(readInviteCode(new URL(link.toLowerCase()))).toBe('ABC23');
  expect(readInviteCode(new URL('https://games.example/counter/?room=00000'))).toBeNull();
});

it('isolates saved host rooms for games on one origin even when the visible room codes match', () => {
  const entries = new Map<string, string>();
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('navigator', {});
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => entries.set(key, value),
    removeItem: (key: string) => entries.delete(key),
  });
  const isName = (value: unknown): value is string => typeof value === 'string';
  const first = createLobbyStore('first-v1:waiting-host', isName);
  const second = createLobbyStore('second-v1:waiting-host', isName);
  first.remember({ code: 'ABC23', profile: 'Amy' });
  second.remember({ code: 'ABC23', profile: 'Bea' });
  expect(first.read()?.profile).toBe('Amy');
  first.forget(first.read()!);
  expect(first.read()).toBeNull();
  expect(second.read()?.profile).toBe('Bea');
});
