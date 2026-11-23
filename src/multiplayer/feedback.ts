export type RoomOperation = "create" | "join" | "public" | "restore" | "play";

// Only game-authored errors can supply text to the interface.
export class RoomError extends Error {}
/** No signaling answer arrived. A migrating client can try its previous room namespace. */
export class NoHostReply extends RoomError {}

export function createRoomFeedback(codeLength: number) {
  const lengthLabel = codeLength === 6 ? "six" : codeLength === 5 ? "five" : String(codeLength);
  const roomMessages = {
    offline: "You’re offline. Connect to Wi-Fi or mobile data and try again, or play a local game.",
    browser: "This browser can’t connect two players. Open the game in an up-to-date browser, or choose Local.",
    service: "Couldn’t reach the room service. Check your internet connection and try again in a moment.",
    invalidCode: "Enter the " + lengthLabel + "-character room code from your friend, or open their invite link.",
    missing: "Room not found. Check the code with your friend and ask them to keep the room open or send a new invite.",
    full: "This room already has two players. Ask your friend to create a new room, or find a public game.",
    closed: "This room has closed. Ask your friend for a new invite.",
    publicGone: "That public match is no longer available. Select Find public game to search again.",
    direct: "Couldn’t connect the two devices. Keep both games open and try again. If it keeps happening, try a different network.",
    publicStopped: "Public search stopped. Share this room’s code with a friend, or leave the room and search again.",
  };

  function roomFailure(error: unknown, operation: RoomOperation): string {
    if (navigator.onLine === false) return roomMessages.offline;
    if (error instanceof RoomError) return error.message;
    const type = error && typeof error === "object" && "type" in error ? error.type : undefined;
    switch (type) {
      case "browser-incompatible":
        return roomMessages.browser;
      case "peer-unavailable":
        return operation === "public" ? roomMessages.publicGone : roomMessages.missing;
      case "unavailable-id":
        return operation === "restore"
          ? "That room is already open elsewhere. Return to the original host tab, or create a new room."
          : "Couldn’t reserve a room code. Try creating the room again.";
      case "network":
      case "disconnected":
      case "socket-closed":
      case "socket-error":
      case "server-error":
        return roomMessages.service;
      case "ssl-unavailable":
      case "invalid-key":
      case "invalid-id":
        return "The room service couldn’t accept the connection. Try again later, or choose Local to play on this device.";
      case "webrtc":
      case "negotiation-failed":
      case "connection-closed":
        return roomMessages.direct;
      default:
        return {
          create: "Couldn’t create the room. Check your connection and select Create private room to retry.",
          join: "Couldn’t join the room. Check the code with your friend and try again.",
          public: "Couldn’t start a public match. Check your connection and select Find public game to retry.",
          restore: "Couldn’t reopen your last room. Ask your friend for a new invite, or create a room.",
          play: "The game couldn’t send that action. Keep both games open and check your connection.",
        }[operation];
    }
  }
  return { roomMessages, roomFailure };
}
