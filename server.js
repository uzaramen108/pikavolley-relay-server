/**
 * We use the render.com server registered with the repository
 * (https://github.com/uzaramen108/pikavolley-relay-server) containing this js file.
 * This server receives input, chat, and options data from players who create rooms, stores them,
 * and sends them to spectators. When a player leaves a room, the room data is deleted after one minute.
 */

import { WebSocketServer } from "ws";
import { createServer } from "http";
import { parse } from "url";

const server = createServer((req, res) => {
  if (req.url === "/rooms" && req.method === "GET") {
    const activeRooms = [];
    rooms.forEach((roomData, roomId) => {
      if (roomData.player !== null) {
        activeRooms.push({
          id: roomId,
          nicknames: roomData.nicknames,
          ips: roomData.partialPublicIPs,
        });
      }
    });

    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify({ rooms: activeRooms }));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Pikachu Volleyball Replay Server (Input-based) is running.\n");
});

const wss = new WebSocketServer({ server });

const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    console.log(`[${roomId}] Creating new replay room structure.`);
    rooms.set(roomId, {
      spectators: new Set(),
      player: null,

      roomID: roomId,
      nicknames: ["", ""],
      partialPublicIPs: ["*.*.*.*", "*.*.*.*"],
      inputs: [],
      options: [], // [frameCounter, options][]
      chats: [], // [frameCounter, playerIndex, chatMessage][]
      frameCounter: 0,
      IsGameEnd: false,
      endFrame: null,
    });
  }
  return rooms.get(roomId);
}

wss.on("connection", (ws, req) => {
  const { pathname } = parse(req.url);
  const roomId = pathname.split("/").pop();
  if (!roomId) {
    ws.close(1008, "Room ID required");
    return;
  }

  const currentRoom = getRoom(roomId);
  let isThisConnectionPlayer = false;

  ws.on("message", (message) => {
    let data;
    try {
      data = JSON.parse(message);
    } catch (e) {
      console.error(`[${roomId}] Failed to parse JSON message:`, message);
      return;
    }

    try {
      switch (data.type) {
        // --- Receive Player data ---
        case "identify_player":
          isThisConnectionPlayer = true;
          currentRoom.player = ws;
          console.log(`[${roomId}] Player connected.`);
          if (data.nicknames) {
            currentRoom.nicknames = data.nicknames;
          }
          if (data.partialPublicIPs) {
            currentRoom.partialPublicIPs = data.partialPublicIPs;
          }
          break;

        // --- Receive spectator data ---
        case "watch":
          console.log(`[${roomId}] Spectator connected.`);
          currentRoom.spectators.add(ws);

          ws.send(
            JSON.stringify({
              type: "replay_pack", // Accumulated input data
              pack: {
                version: "p2p-online-spectator",
                roomID: currentRoom.roomID,
                nicknames: currentRoom.nicknames,
                partialPublicIPs: currentRoom.partialPublicIPs,
                chats: currentRoom.chats,
                options: currentRoom.options,
                inputs: currentRoom.inputs,
              },
            }),
          );
          break;

        // --- Receive Realtime input data ---
        case "inputs": 
          const usersInputNumber = data.value;
          if (usersInputNumber == -1 && !currentRoom.IsGameEnd) {
            console.log(`[${roomId}] 'Received end of Stream' (-1) signal.`);
            currentRoom.IsGameEnd = true;
            currentRoom.endFrame = currentRoom.frameCounter;
          }
          if (!isThisConnectionPlayer) {
            return; // Prevent data jacking
          }
          currentRoom.inputs.push(usersInputNumber);
          currentRoom.frameCounter++;

          const liveInputMessage = JSON.stringify({
            type: "live_input",
            value: usersInputNumber,
          });
          currentRoom.spectators.forEach((spectator) => {
            if (spectator.readyState === 1 /* WebSocket.OPEN */) {
              spectator.send(liveInputMessage);
            }
          });
          break;
        
        // --- Receive Option data ---
        case "options":
          if (!isThisConnectionPlayer) {
            return;
          }

          const optionsData = [currentRoom.frameCounter, data.options];
          console.log(optionsData);
          currentRoom.options.push(optionsData);

          const liveOptionsMessage = JSON.stringify({
            type: "live_options",
            value: optionsData,
          });
          currentRoom.spectators.forEach((spectator) => {
            if (spectator.readyState === 1) {
              spectator.send(liveOptionsMessage);
            }
          });
          break;

        // --- Receive Chat data ---
        case "chat":
          if (!isThisConnectionPlayer) {
            return;
          }

          const chatData = [
            currentRoom.frameCounter,
            data.whichPlayerSide,
            data.chatMessage,
          ];
          console.log(chatData);
          currentRoom.chats.push(chatData);

          const liveChatMessage = JSON.stringify({
            type: "live_chat",
            value: chatData,
          });
          currentRoom.spectators.forEach((spectator) => {
            if (spectator.readyState === 1) {
              spectator.send(liveChatMessage);
            }
          });
          break;
      }
    } catch (e) {
      console.error(`[${roomId}] Failed to process message:`, e);
    }
  });

  ws.on("close", () => {
    if (isThisConnectionPlayer) {
      console.log(`[${roomId}] Player disconnected.`);
      currentRoom.player = null;
      setTimeout(() => {
        if (currentRoom.player === null && currentRoom.spectators.size === 0) {
          console.log(`[${roomId}] Room empty for 5 mins. Deleting history.`);
          rooms.delete(roomId);
        }
      }, 60000); // rooms will be deleted after 1 minutes
    } else {
      currentRoom.spectators.delete(ws);
      console.log(`[${roomId}] Spectator disconnected.`);
      if (currentRoom.player === null && currentRoom.spectators.size === 0) {
        console.log(`[${roomId}] Room empty. Deleting history.`);
        rooms.delete(roomId);
      }
    }
  });
});

const port = process.env.PORT || 8080;
server.listen(port, () => {
  console.log(`Relay Server listening on port ${port}`);
});
