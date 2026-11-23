import Peer, { type DataConnection, type PeerOptions } from "peerjs";
import { createRoomFeedback, RoomError } from "./feedback";
import type { HostLobby } from "./lobby-store";
import { connectRoom, prepareNetwork, holdHostLock, type RoomNetwork } from "./transport";
import { observeConnectionRoute, type ConnectionRoute } from "./connection-route";
import { createRematchRule } from "./rematch";
import type { LobbySettings, RoomPersistence } from "./persistence";

export type MatchSeat = "Player1" | "Player2";
type Member<P> = P & { connected: boolean };
export type MatchRoom<P, State> = {
  code: string;
  public: boolean;
  status: "waiting" | "active" | "finished" | "abandoned";
  round: number;
  players: { player1: Member<P>; player2?: Member<P> };
  state: State;
  rematchRequester?: MatchSeat;
  rematchVotes?: [boolean, boolean];
};
export type MatchView<P, State> = {
  room: MatchRoom<P, State>;
  seat: MatchSeat;
  route: ConnectionRoute;
  connected: boolean;
  syncing: boolean;
  notice: string;
};
export interface MatchSession<P, State, Move> {
  watch(listener: (view: MatchView<P, State>) => void): void;
  move(move: Move): void;
  rematch(): void;
  leave(): Promise<void>;
  stop(): void;
}

export interface AuthoritativeGame<P extends object, Settings, State, Move> {
  store: RoomPersistence<P, Settings>;
  relayUrl?: string;
  peerOptions?: Pick<PeerOptions, "host" | "port" | "secure" | "path">;
  /** Override only when integrating an existing wire protocol. */
  protocol?: string;
  moveField?: string;
  legacyRematchSeat?: (state: State, round: number) => MatchSeat;
  queueKey: (settings: Settings) => string;
  settings: (state: State) => Settings;
  initial: (settings: Settings) => State;
  advanceRound?: (previous: State) => State;
  isState: (value: unknown) => value is State;
  isMove: (value: unknown) => value is Move;
  /** Return the same state for an illegal or out-of-turn move. */
  apply: (state: State, move: Move, seat: MatchSeat) => State;
  revision: (state: State) => number;
  finished: (state: State) => boolean;
  acceptGuest?: (host: P, guest: P) => P;
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

export function createAuthoritativeMultiplayer<Player extends object, Settings, State, Move>(
  rules: AuthoritativeGame<Player, Settings, State, Move>,
) {
  type Side = MatchSeat;
  type Room = MatchRoom<Player, State>;
  type OnlineView = MatchView<Player, State>;
  type HostSettings = LobbySettings<Player, Settings>;
  const { store } = rules;
  const { waitingHost, codes: { isRoomCode, newRoomCode } } = store;
  const protocol = rules.protocol ?? store.namespace;
  const moveField = rules.moveField ?? "move";
  const { roomMessages, roomFailure } = createRoomFeedback(store.codes.length);
  type Saved = { room: Room; seat: Side; ticket: string; hostToken?: string };
  type Packet = {
    [field: string]: unknown;
    type: string;
    ticket?: string;
    player?: Player;
    room?: Room;
    ply?: number;
    round?: number;
    reason?: string;
    code?: string;
    heartbeat?: boolean;
    mutualRematch?: boolean;
  };
  const prefix = store.namespace + "-";
  const hostId = (code: string) => prefix + "room-" + code;
  const queueId = (s: Settings) => prefix + "queue-" + rules.queueKey(s);
  function waitingRoom(code: string, isPublic: boolean, player: Player, size: Settings): Room {
    return { code, public: isPublic, round: 1, status: "waiting",
      players: { player1: { ...player, connected: true } }, state: rules.initial(size) };
  }
  function nextRound(room: Room): Room {
    if (room.status !== "finished") return room;
    const state = rules.advanceRound ? rules.advanceRound(room.state) : rules.initial(rules.settings(room.state));
    const next: Room = { ...room, round: room.round + 1, state, status: "active" };
    delete next.rematchRequester;
    if (next.rematchVotes) next.rematchVotes = [false, false];
    return next;
  }
  const voteForRematch = createRematchRule(nextRound);
  function roomOK(r: Room) {
    return (
      r &&
      isRoomCode(r.code) &&
      Number.isInteger(r.round) &&
      r.round > 0 &&
      (r.rematchVotes === undefined || (Array.isArray(r.rematchVotes) && r.rematchVotes.length === 2 &&
        r.rematchVotes.every(vote => typeof vote === "boolean"))) &&
      ["waiting", "active", "finished", "abandoned"].includes(r.status) &&
      store.isProfile(r.players?.player1) &&
      (!r.players.player2 || store.isProfile(r.players.player2)) &&
      rules.isState(r.state)
    );
  }
  function savedRoom(code?: string): Saved | undefined {
    try {
      const s = store.readMatch(code) as Partial<Saved> | null;
      if (
        s &&
        s.room && roomOK(s.room) &&
        (s.seat === "Player1" || s.seat === "Player2") &&
        typeof s.ticket === "string" &&
        s.room.status !== "abandoned"
      )
        return { room: s.room, ticket: s.ticket, seat: s.seat, hostToken: s.hostToken };
    } catch {}
  }
  const options = rules.peerOptions ?? { secure: true };
  function openPeer(network: RoomNetwork, id?: string, token?: string, signal?: AbortSignal): Promise<Peer> {
    return new Promise((resolve, reject) => {
      signal?.throwIfAborted();
      const settings = { ...options, config: network.config, ...(token && { token }) };
      const peer = new Peer(id ?? prefix + "guest-" + crypto.randomUUID(), settings);
      const timeout = setTimeout(
        () =>
          fail(
            new RoomError(
              "The room service took too long to respond. Check your internet connection and try again.",
            ),
          ),
        14000,
      );
      function fail(e: Error) {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", cancel);
        peer.destroy();
        reject(e);
      }
      function cancel() { fail(signal!.reason); }
      signal?.addEventListener("abort", cancel, { once: true });
      peer.once("error", fail);
      peer.once("open", () => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", cancel);
        peer.off("error", fail);
        resolve(peer);
      });
    });
  }
  function packet(data: unknown): Packet | undefined {
    if (typeof data !== "string" || data.length > 40000) return;
    try {
      const p = JSON.parse(data);
      if (p && typeof p.type === "string") return p;
    } catch {}
  }
  function send(ch: DataConnection | undefined, p: Packet) {
    if (ch?.open) ch.send(JSON.stringify(p));
  }
  function collision(e: unknown) {
    return (e as { type?: string })?.type === "unavailable-id";
  }
  function lockSeat(save: Saved, requestHandoff = false) {
    if (requestHandoff && !document.hidden && typeof BroadcastChannel !== "undefined") {
      const request = new BroadcastChannel(prefix + "resume-" + save.room.code);
      request.postMessage(save.seat);
      request.close();
    }
    return holdHostLock(store.namespace, save.seat === "Player1" ? save.hostToken! : "guest-" + save.ticket);
  }
  async function allocateHost(network: RoomNetwork, token: string, signal: AbortSignal) {
    for (let i = 0; i < 5; i++) {
      const code = newRoomCode();
      try {
        return { code, peer: await openPeer(network, hostId(code), token, signal) };
      } catch (e) {
        if (!collision(e)) throw e;
      }
    }
    throw new RoomError("Couldn’t reserve a room code. Try creating the room again.");
  }
  class Session {
    private channel?: DataConnection;
    private alias?: Peer;
    private listen?: (v: OnlineView) => void;
    private serviceNotice = "";
    private publicSearchStopped = false;
    private closed = false;
    private joined = false;
    private pending = false;
    private retry = 0;
    private dialing = false;
    private route: ConnectionRoute = "unknown";
    private channelEvents?: AbortController;
    private lastMessage = 0;
    private lobby?: HostLobby<HostSettings>;
    private registration?: AbortController;
    private peerEvents = new AbortController();
    private parked = false;
    private leaving = false;
    private handoff?: BroadcastChannel;
    private readonly lifetime = new AbortController();
    constructor(
      private peer: Peer | undefined,
      private data: Saved,
      private me: Player,
      private network: RoomNetwork | undefined,
      private progress: (message: string) => void,
      private releaseSeat?: () => void,
    ) {
      if (peer) this.bindPeer(peer);
      const listeners = { signal: this.lifetime.signal };
      if (typeof BroadcastChannel !== "undefined") {
        this.handoff = new BroadcastChannel(prefix + "resume-" + data.room.code);
        this.handoff.onmessage = event => {
          if (event.data === data.seat && document.hidden) this.park();
        };
      }
      window.addEventListener("pagehide", event => {
        if (event.persisted) this.park();
        else this.stop();
      }, listeners);
      document.addEventListener("freeze", () => this.park(), listeners);
      const resume = () => {
        if (document.hidden || this.closed) return;
        this.parked = false;
        this.lastMessage = performance.now();
        void this.recover();
      };
      window.addEventListener("online", resume, listeners);
      window.addEventListener("offline", () => {
        // Keep the foreground seat lock so leaving offline can release its saved board.
        this.detach();
        this.parked = false;
        this.serviceNotice = this.data.room.status === "waiting"
          ? "Your room will reopen when you’re back online."
          : "Your board is saved. Reconnecting when you’re back online.";
        this.reflect();
      }, listeners);
      window.addEventListener("pageshow", resume, listeners);
      document.addEventListener("resume", resume, listeners);
      document.addEventListener("visibilitychange", resume, listeners);
    }
    private bindPeer(peer: Peer) {
      peer.on("connection", ch => {
        if (this.peer === peer) this.incoming(ch);
        else ch.close();
      });
      peer.on("error", (e) => {
        if (this.closed || this.peer !== peer) return;
        if (!this.dialing && e.type !== "peer-unavailable" && e.type !== "webrtc") {
          this.serviceNotice = roomFailure(e, "play");
          this.reflect();
        }
      });
      peer.on("open", () => {
        if (this.closed || this.peer !== peer) return;
        this.serviceNotice = "";
        this.reflect();
        if (this.data.seat === "Player2" && this.data.room.status !== "abandoned")
          void this.reconnectGuest();
      });
      peer.on("disconnected", () => {
        if (!this.closed && this.peer === peer) {
          this.serviceNotice = this.channel?.open
            ? "Lost contact with the room service. You can keep playing while it reconnects."
            : "Lost contact with the room service. Keep this tab open while it reconnects. If it stays offline, check your internet connection and refresh.";
          this.reflect();
          this.retryRecovery();
        }
      });
      peer.on("close", () => {
        if (this.peer === peer && !this.closed) this.retryRecovery();
      });
    }
    private retryRecovery() {
      clearTimeout(this.retry);
      if (!this.closed && !this.parked && this.data.room.status !== "abandoned")
        this.retry = window.setTimeout(() => void this.recover(), 2000);
    }
    private detach() {
      const alias = this.alias;
      this.alias = undefined;
      alias?.destroy();
      const peer = this.peer;
      this.peer = undefined;
      this.registration?.abort();
      this.registration = undefined;
      this.peerEvents.abort();
      this.peerEvents = new AbortController();
      this.channelEvents?.abort();
      const ch = this.channel;
      this.channel = undefined;
      this.joined = this.pending = this.dialing = false;
      this.route = "unknown";
      ch?.close();
      peer?.destroy();
    }
    private park() {
      if (this.closed || this.parked || this.data.room.status === "abandoned") return;
      this.parked = true;
      clearTimeout(this.retry);
      this.detach();
      this.reflect();
      this.releaseSeat?.();
      this.releaseSeat = undefined;
    }
    private async recover() {
      if (this.closed || this.parked || document.hidden || this.data.room.status === "abandoned" || this.registration) return;
      if (!navigator.onLine) {
        this.serviceNotice = "Your board is saved. Reconnecting when you’re back online.";
        this.reflect();
        return;
      }
      if (this.peer && !this.peer.destroyed) {
        if (!this.peer.disconnected) {
          if (this.data.seat === "Player2") await this.reconnectGuest();
          return;
        }
        if (this.channel?.open || !this.data.room.players.player2) {
          try { this.peer.reconnect(); } catch { this.retryRecovery(); }
          return;
        }
      }
      this.detach();
      const attempt = new AbortController();
      this.registration = attempt;
      try {
        if (!this.releaseSeat) {
          const release = await lockSeat(this.data, true);
          if (attempt.signal.aborted) { release(); return; }
          this.releaseSeat = release;
          const latest = savedRoom(this.data.room.code);
          const waiting = this.data.room.status === "waiting" && waitingHost.read()?.token === this.data.hostToken;
          if (!waiting && (!latest || latest.ticket !== this.data.ticket || latest.seat !== this.data.seat)) {
            this.data.room.status = "abandoned";
            this.reflect();
            return;
          }
          if (latest) this.data = latest;
        }
        this.network = await prepareNetwork(rules.relayUrl, attempt.signal);
        attempt.signal.throwIfAborted();
        const host = this.data.seat === "Player1";
        const peer = await openPeer(this.network, host ? hostId(this.data.room.code) : undefined,
          host ? this.data.hostToken : undefined, attempt.signal);
        if (attempt.signal.aborted) { peer.destroy(); return; }
        this.peer = peer;
        this.bindPeer(peer);
        if (host && this.data.room.public && this.data.room.status === "waiting") {
          try { this.serve(await openPeer(this.network, queueId(rules.settings(this.data.room.state)), undefined, attempt.signal)); }
          catch (error) { if (collision(error)) this.stopPublicSearch(); else throw error; }
        }
        this.serviceNotice = "";
        this.reflect();
        if (!host) await this.reconnectGuest();
      } catch (error) {
        if (!attempt.signal.aborted) {
          this.serviceNotice = collision(error)
            ? "Your board is saved. Reopening the room as soon as the previous connection closes."
            : "Your board is saved. " + roomFailure(error, "restore");
          this.reflect();
          this.retryRecovery();
        }
      } finally {
        if (this.registration === attempt) this.registration = undefined;
      }
    }
    watch(show: (v: OnlineView) => void) {
      this.listen = show;
      this.reflect();
      if (!this.peer) void this.recover();
    }
    private reflect() {
      if (this.closed || !this.listen) return;
      const { room, seat } = this.data;
      const connected = this.joined && !!this.channel?.open;
      room.players.player1.connected = seat === "Player1" || connected;
      if (room.players.player2)
        room.players.player2.connected = seat === "Player2" || connected;
      if (seat === "Player1" && room.status === "waiting" && this.releaseSeat && !this.leaving) {
        this.lobby = { code: room.code, token: this.data.hostToken,
          profile: { player: room.players.player1, size: rules.settings(room.state), public: room.public } };
        waitingHost.remember(this.lobby);
      } else if (this.lobby && room.status !== "waiting") {
        waitingHost.forget(this.lobby);
        this.lobby = undefined;
      }
      if (this.releaseSeat && !this.leaving) {
        if (room.status === "abandoned") store.forgetMatch(this.data);
        else store.saveMatch(this.data);
      }
      this.listen({
        room: structuredClone(room),
        seat,
        route: this.route,
        connected: connected || room.status === "waiting",
        syncing: this.pending,
        notice: this.serviceNotice || (this.publicSearchStopped && room.status === "waiting" ? roomMessages.publicStopped : ""),
      });
    }
    stopPublicSearch() {
      this.data.room.public = false;
      this.publicSearchStopped = true;
      this.reflect();
    }
    public serve(queue: Peer) {
      this.alias = queue;
      const unlist = () => {
        if (this.closed || this.alias !== queue || this.data.room.status !== "waiting") return;
        this.alias = undefined;
        queue.destroy();
        this.stopPublicSearch();
      };
      queue.on("disconnected", unlist);
      queue.on("error", (e) => {
        if (e.type !== "peer-unavailable" && e.type !== "webrtc") unlist();
      });
      queue.on("connection", (ch) => {
        if (ch.metadata?.app !== protocol || ch.metadata?.type !== "find") {
          ch.close();
          return;
        }
        ch.on("open", () => {
          if (this.data.room.status === "waiting")
            send(ch, { type: "invite", code: this.data.room.code });
          setTimeout(() => ch.close(), 1200);
        });
        ch.on("error", () => {});
      });
    }
    private incoming(ch: DataConnection) {
      const peer = this.peer;
      if (
        this.closed ||
        this.data.seat !== "Player1" ||
        ch.metadata?.app !== protocol ||
        ch.metadata?.type !== "join"
      ) {
        ch.close();
        return;
      }
      let accepted = false;
      let timeout = setTimeout(() => ch.close(), 45000);
      ch.on("open", () => {
        clearTimeout(timeout);
        timeout = setTimeout(() => ch.close(), 8000);
      });
      ch.on("data", (d) => {
        if (this.closed || this.parked || this.peer !== peer) return;
        const p = packet(d);
        if (!p) return;
        if (!accepted) {
          if (
            p.type !== "hello" ||
            !p.player ||
            !store.isProfile(p.player) ||
            typeof p.ticket !== "string" ||
            !/^[a-f0-9-]{36}$/i.test(p.ticket)
          )
            return;
          if (
            this.data.room.status === "abandoned" ||
            (this.data.ticket && this.data.ticket !== p.ticket)
          ) {
            send(ch, {
              type: "reject",
              reason: this.data.room.status === "abandoned" ? "closed" : "full",
            });
            setTimeout(() => ch.close(), 250);
            return;
          }
          clearTimeout(timeout);
          accepted = true;
          const previous = this.channel;
          this.channel = ch;
          previous?.close();
          this.joined = true;
          if (!this.peer?.disconnected) this.serviceNotice = "";
          this.data.ticket = p.ticket;
          const r = this.data.room;
          if (p.mutualRematch === true) r.rematchVotes ??= [false, false];
          else delete r.rematchVotes;
          if (!r.players.player2) {
            const guest = rules.acceptGuest?.(r.players.player1, p.player) ?? p.player;
            r.players.player2 = { ...guest, connected: true };
            r.status = "active";
          }
          this.alias?.destroy();
          this.alias = undefined;
          this.monitor(ch, p.heartbeat === true);
          this.publish();
          return;
        }
        if (this.channel === ch) {
          this.lastMessage = performance.now();
          if (p.type !== "ping") this.hostAction(p);
        }
      });
      ch.on("close", () => {
        clearTimeout(timeout);
        if (this.channel === ch) this.lost();
      });
      ch.on("error", () => {
        clearTimeout(timeout);
        if (this.channel === ch) this.lost();
      });
    }
    private hostAction(p: Packet) {
      if (p.type === "leave") {
        this.data.room.status = "abandoned";
        this.reflect();
        return;
      }
      const move = p[moveField];
      if (
        p.type === "move" &&
        rules.isMove(move) &&
        p.round === this.data.room.round &&
        p.ply === rules.revision(this.data.room.state)
      )
        this.apply(move, "Player2");
      if (p.type === "rematch" && p.round === this.data.room.round)
        this.reset("Player2");
      this.publish();
    }
    private apply(move: Move, seat: Side) {
      const r = this.data.room;
      if (!this.joined || r.status !== "active")
        return;
      const next = rules.apply(r.state, move, seat);
      if (next === r.state) return;
      r.state = next;
      if (rules.finished(next)) {
        r.status = "finished";
        r.rematchRequester = rules.legacyRematchSeat?.(next, r.round) ?? "Player1";
      }
    }
    private reset(seat: Side) {
      const r = this.data.room;
      if (!this.joined || r.status !== "finished") return;
      if (r.rematchVotes)
        this.data.room = voteForRematch(r, r.rematchVotes, seat === "Player1" ? 0 : 1, r.round);
      else if (seat === r.rematchRequester)
        this.data.room = nextRound(r);
    }
    private publish() {
      this.reflect();
      send(this.channel, { type: "state", room: this.data.room, heartbeat: true });
    }
    private monitor(ch: DataConnection, heartbeat: boolean) {
      this.channelEvents?.abort();
      this.channelEvents = new AbortController();
      const { signal } = this.channelEvents;
      this.lastMessage = performance.now();
      this.route = "unknown";
      const refresh = observeConnectionRoute(ch.peerConnection, signal, route => {
        if (this.route === route) return;
        this.route = route;
        this.reflect();
      });
      const timer = window.setInterval(() => {
        if (this.data.room.status === "abandoned") return;
        if (heartbeat) {
          if (!document.hidden && performance.now() - this.lastMessage > 25000) { this.lost(); return; }
          send(ch, { type: "ping" });
        }
        void refresh();
      }, 5000);
      signal.addEventListener("abort", () => clearInterval(timer), { once: true });
    }
    private lost() {
      const old = this.channel;
      this.channel = undefined;
      this.channelEvents?.abort();
      this.route = "unknown";
      this.joined = false;
      this.pending = false;
      old?.close();
      this.reflect();
      if (this.data.seat === "Player2" || !this.peer?.open) {
        this.retryRecovery();
      }
    }
    private async dial() {
      const peer = this.peer;
      if (this.closed || this.channel || this.dialing || !peer || !this.network) return;
      this.dialing = true;
      const receive = (data: unknown) => {
        const p = packet(data);
        if (p?.type === "reject") {
          const message = this.data.room.public
            ? roomMessages.publicGone
            : p.reason === "closed" ? roomMessages.closed : roomMessages.full;
          throw new RoomError(message);
        }
        if (p?.type === "state" && p.room && roomOK(p.room) &&
            p.room.code === this.data.room.code && p.room.players.player2) {
          return { room: p.room, heartbeat: p.heartbeat === true };
        }
      };
      try {
        const { channel, reply } = await connectRoom(peer, hostId(this.data.room.code), protocol, "join",
          this.network, this.peerEvents.signal, {
            open: ch => send(ch, { type: "hello", ticket: this.data.ticket, player: this.me, heartbeat: true, mutualRematch: true }),
            receive,
          }, message => {
            if (this.listen) { this.serviceNotice = message; this.reflect(); }
            else this.progress(message);
          });
        if (this.closed || this.peer !== peer) { channel.close(); return; }
        this.channel = channel;
        this.joined = true;
        this.pending = false;
        this.serviceNotice = "";
        this.data.room = reply.room;
        this.monitor(channel, reply.heartbeat);
        channel.on("data", data => {
          if (this.channel !== channel) return;
          const p = packet(data);
          if (!p) return;
          this.lastMessage = performance.now();
          if (p.type === "leave") this.data.room.status = "abandoned";
          else if (p.type === "state" && p.room && roomOK(p.room) &&
                   p.room.code === this.data.room.code && p.room.players.player2) {
            this.data.room = p.room;
            this.pending = false;
          } else return;
          this.reflect();
        });
        const ended = () => { if (this.channel === channel) this.lost(); };
        channel.on("close", ended);
        channel.on("error", ended);
        this.reflect();
      } finally { if (this.peer === peer) this.dialing = false; }
    }
    private async reconnectGuest() {
      const peer = this.peer;
      if (this.closed || !peer || peer.disconnected || peer.destroyed) return;
      try { await this.dial(); }
      catch (error) {
        if (this.closed || this.peer !== peer) return;
        if (error instanceof RoomError && [roomMessages.closed, roomMessages.full, roomMessages.publicGone].includes(error.message)) {
          this.data.room.status = "abandoned";
          this.serviceNotice = error.message;
        }
        this.lost();
      }
    }
    async connect(resume: boolean) {
      if (resume) { void this.reconnectGuest(); return; }
      const retryUntil = Date.now() + 8000;
      for (;;) {
        try { await this.dial(); return; }
        catch (error) {
          if ((error as { type?: string })?.type !== "peer-unavailable" || this.data.room.public ||
              Date.now() >= retryUntil || this.closed) throw error;
          this.progress("Waiting for the host to return to the room. They may still be sharing the invite…");
          await sleep(2000);
          this.lifetime.signal.throwIfAborted();
        }
      }
    }
    move(move: Move) {
      const { room: r, seat } = this.data;
      if (
        this.pending ||
        !this.joined ||
        r.status !== "active" ||
        !rules.isMove(move)
      )
        return;
      if (seat === "Player1") {
        this.apply(move, seat);
        this.publish();
      } else {
        if (rules.apply(r.state, move, seat) === r.state) return;
        this.pending = true;
        this.reflect();
        send(this.channel, {
          type: "move",
          [moveField]: move,
          round: r.round,
          ply: rules.revision(r.state),
        });
      }
    }
    rematch() {
      const r = this.data.room;
      if (!this.joined || r.status !== "finished") return;
      if (this.data.seat === "Player1") {
        this.reset("Player1");
        this.publish();
      } else send(this.channel, { type: "rematch", round: r.round });
    }
    async leave() {
      this.leaving = true;
      if (this.releaseSeat) store.forgetMatch(this.data);
      if (this.lobby) waitingHost.forget(this.lobby);
      try {
        if (this.channel?.open) {
          send(this.channel, { type: "leave" });
          await sleep(100);
        }
      } catch {
        // A channel that already closed cannot deliver the leave message.
      } finally {
        this.stop();
      }
    }
    stop() {
      if (this.closed) return;
      this.closed = true;
      clearTimeout(this.retry);
      this.lifetime.abort();
      this.detach();
      this.handoff?.close();
      this.releaseSeat?.();
      this.releaseSeat = undefined;
    }
  }
  async function enter(
    action: "create" | "public" | "join" | "restore",
    player: Player,
    size: Settings,
    code = "",
    progress: (message: string) => void = () => {},
    signal?: AbortSignal,
  ): Promise<MatchSession<Player, State, Move>> {
    if (!isSecureContext) throw new RoomError("Online games need a secure connection. Open the HTTPS game link and try again.");
    if (typeof RTCPeerConnection === "undefined")
      throw new RoomError(roomMessages.browser);
    if (action === "join" && !isRoomCode(code)) throw new RoomError(roomMessages.invalidCode);
    let saved = action === "restore" ? savedRoom(code || undefined) : action === "join" ? savedRoom(code) : undefined;
    if (saved?.room.players.player2) {
      if (saved.seat === "Player1") saved.hostToken ??= crypto.randomUUID();
      const release = await lockSeat(saved, true);
      if (signal?.aborted) { release(); signal.throwIfAborted(); }
      const latest = savedRoom(saved.room.code);
      if (!latest || latest.ticket !== saved.ticket || latest.seat !== saved.seat) {
        release();
        throw new RoomError(roomMessages.closed);
      }
      latest.hostToken = saved.hostToken;
      const profile = latest.seat === "Player2" ? latest.room.players.player2! : latest.room.players.player1;
      return new Session(undefined, latest, profile, undefined, progress, release);
    }
    if (!navigator.onLine) throw new RoomError(roomMessages.offline);
    if (action === "restore" && !saved) {
      const lobby = waitingHost.read();
      if (lobby && (!code || code === lobby.code)) saved = { seat: "Player1", ticket: "", hostToken: lobby.token,
        room: waitingRoom(lobby.code, lobby.profile.public, lobby.profile.player, lobby.profile.size) };
    }
    if (action === "restore" && !saved)
      throw new RoomError("Your saved room has expired. Ask your friend for a new invite, or create a room.");
    let peer: Peer | undefined,
      alias: Peer | undefined,
      session: Session | undefined;
    const hostToken = navigator.locks && saved?.hostToken && /^[a-f0-9-]{36}$/i.test(saved.hostToken)
      ? saved.hostToken : crypto.randomUUID();
    let releaseSeat: (() => void) | undefined;
    const setup = new AbortController();
    const cancel = () => setup.abort();
    signal?.throwIfAborted();
    signal?.addEventListener("abort", cancel, { once: true });
    window.addEventListener("pagehide", cancel, { once: true });
    try {
      if (action === "public" || action === "create" || saved?.seat === "Player1")
        releaseSeat = await holdHostLock(store.namespace, hostToken);
      const network = await prepareNetwork(rules.relayUrl, setup.signal);
      setup.signal.throwIfAborted();
      if (action === "public") {
        // Make the game endpoint available before advertising the queue alias.
        const allocated = await allocateHost(network, hostToken, setup.signal);
        peer = allocated.peer;
        code = allocated.code;
        try {
          alias = await openPeer(network, queueId(size), undefined, setup.signal);
        } catch (e) {
          if (!collision(e)) throw e;
        }
      }
      const host = action === "create" || !!alias || saved?.seat === "Player1";
      if (host) {
        if (saved) {
          code = saved.room.code;
          for (let i = 0; !peer; i++) {
            try {
              peer = await openPeer(network, hostId(code), hostToken, setup.signal);
            } catch (e) {
              if (!collision(e) || i >= 4) throw e;
              await sleep(800);
            }
          }
          if (saved.room.public && saved.room.status === "waiting") {
            try {
              alias = await openPeer(network, queueId(rules.settings(saved.room.state)), undefined, setup.signal);
            } catch (e) {
              if (!collision(e)) throw e;
            }
          }
        } else if (!peer) {
          const allocated = await allocateHost(network, hostToken, setup.signal);
          peer = allocated.peer;
          code = allocated.code;
        }
      } else {
        peer ??= await openPeer(network, undefined, undefined, setup.signal);
        if (action === "public") {
          const { channel, reply } = await connectRoom(peer, queueId(size), protocol, "find", network, setup.signal, {
            receive(data) {
              const p = packet(data);
              if (p?.type === "invite" && p.code && isRoomCode(p.code)) return p.code;
            },
          }, progress);
          channel.close();
          code = reply;
        }
        if (saved) code = saved.room.code;
      }
      const state: Saved = saved ?? {
        ticket: host ? "" : crypto.randomUUID(),
        seat: host ? "Player1" : "Player2",
        room: waitingRoom(code, action === "public", player, size),
      };
      if (host) state.hostToken = hostToken;
      else {
        releaseSeat?.();
        releaseSeat = await lockSeat(state);
      }
      setup.signal.throwIfAborted();
      session = new Session(peer, state, player, network, progress, releaseSeat);
      setup.signal.addEventListener("abort", () => session?.stop(), { once: true });
      if (alias) session.serve(alias);
      else if (host && saved?.room.public && saved.room.status === "waiting") session.stopPublicSearch();
      if (!host) await session.connect(!!saved);
      setup.signal.throwIfAborted();
      return session;
    } catch (e) {
      if (session) session.stop();
      else {
        peer?.destroy();
        alias?.destroy();
        releaseSeat?.();
      }
      throw e;
    } finally {
      window.removeEventListener("pagehide", cancel);
      signal?.removeEventListener("abort", cancel);
    }
  }
  return { enter, savedRoom };
}
