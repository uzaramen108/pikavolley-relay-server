// [ server.js 파일 전체를 이 코드로 덮어쓰게 ]
import { WebSocketServer } from "ws";
import { createServer } from "http";
import { parse } from "url";

const server = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Pikachu Volleyball Relay Server (Stateful) is running.\n");
});

const wss = new WebSocketServer({ server });

// [수정] 방 구조를 '관전자'와 '게임 내역 리스트'로 변경
const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      spectators: new Set(),
      gameHistory: [], // [핵심] 이 '리스트'가 모든 입력을 저장하네
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
  let isPlayer = false;

  ws.on("message", (message) => {
    try {
      // 1. 메시지가 '문자열'일 경우 (최초 식별)
      if (typeof message === "string") {
        const data = JSON.parse(message);

        if (data.type === "identify_player") {
          isPlayer = true;
          console.log(`[${roomId}] Player connected.`);
        } 
        else if (data.type === "watch") {
          console.log(`[${roomId}] Spectator connected.`);
          currentRoom.spectators.add(ws);

          // [핵심!] 관전자에게 '현재까지 쌓인 내역(리스트)'을 즉시 전송
          ws.send(
            JSON.stringify({
              type: "history",
              history: currentRoom.gameHistory,
            })
          );
        }
      }
      
      // 2. 메시지가 'ArrayBuffer'일 경우 (플레이어의 게임 데이터)
      else if (isPlayer) {
        // [핵심!]
        // 2-A. 이 '리스트'에 게임 데이터를 '누적'하네
        currentRoom.gameHistory.push(message);

        // 2-B. '현재 접속 중인' 모든 관전자에게 '생방송'으로도 보내네
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

  ws.on("close", () => {
    if (currentRoom && !isPlayer) {
      currentRoom.spectators.delete(ws);
      console.log(`[${roomId}] Spectator disconnected.`);
    }
    // [참고] 플레이어가 나가도 'gameHistory'는 방에 계속 남겨두네.
  });
});

const port = process.env.PORT || 8080;
server.listen(port, () => {
  console.log(`Relay Server listening on port ${port}`);
});