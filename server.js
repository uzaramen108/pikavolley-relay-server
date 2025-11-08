// 'ws' 라이브러리가 필요하네. npm install ws
import { WebSocketServer } from "ws";
import { createServer } from "http";
import { parse } from "url";

// Render.com은 HTTP 서버가 응답해야 '정상'으로 인식하네.
const server = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Pikachu Volleyball Relay Server is running.\n");
});

const wss = new WebSocketServer({ server });

// 모든 방(Room)을 관리할 객체일세
// key: roomId, value: { players: Set<WebSocket>, spectators: Set<WebSocket> }
const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      players: new Set(),
      spectators: new Set(),
    });
  }
  return rooms.get(roomId);
}

wss.on("connection", (ws, req) => {
  let currentRoom = null;
  let isPlayer = false;

  // 1. URL에서 Room ID를 파싱하네
  const { pathname } = parse(req.url);
  const roomId = pathname.split("/").pop();
  if (!roomId) {
    ws.close(1008, "Room ID required");
    return;
  }

  // 2. 메시지 핸들러
  ws.on("message", (message) => {
    try {
      // 2-A. 첫 메시지 (JSON으로 된 식별 정보)
      if (typeof message === "string") {
        const data = JSON.parse(message);
        currentRoom = getRoom(roomId);

        if (data.type === "identify_player") {
          console.log(`[${roomId}] Player ${data.player} connected.`);
          isPlayer = true;
          currentRoom.players.add(ws);
        } else if (data.type === "watch") {
          console.log(`[${roomId}] Spectator connected.`);
          currentRoom.spectators.add(ws);
        }
      } 
      // 2-B. 게임 데이터 (ArrayBuffer)
      else if (isPlayer && currentRoom) {
        // 플레이어에게서 받은 데이터를 모든 관전자에게 '방송'하네
        currentRoom.spectators.forEach((spectator) => {
          if (spectator.readyState === 1 /* WebSocket.OPEN */) {
            spectator.send(message); // 받은 ArrayBuffer 그대로 전송
          }
        });
      }
    } catch (e) {
      console.error("Failed to process message:", e);
    }
  });

  // 3. 연결 종료 핸들러
  ws.on("close", () => {
    if (currentRoom) {
      console.log(`[${roomId}] A client disconnected.`);
      if (isPlayer) {
        currentRoom.players.delete(ws);
      } else {
        currentRoom.spectators.delete(ws);
      }
      // 방이 비었으면 메모리에서 삭제
      if (currentRoom.players.size === 0 && currentRoom.spectators.size === 0) {
        rooms.delete(roomId);
        console.log(`[${roomId}] Room closed.`);
      }
    }
  });
});

const port = process.env.PORT || 8080;
server.listen(port, () => {
  console.log(`Relay Server listening on port ${port}`);
});