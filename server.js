import { WebSocketServer } from "ws";
import { createServer } from "http";
import { parse } from "url";

const server = createServer((req, res) => {
  if (req.url === "/rooms" && req.method === "GET") {
    // 1. 현재 'rooms' 맵을 순회하며 [ {id, nicknames}, ... ] 배열 생성
    const activeRooms = [];
    rooms.forEach((roomData, roomId) => {
      if (roomData.player !== null) {
        activeRooms.push({
          id: roomId,
          nicknames: roomData.nicknames,
          ips: roomData.partialPublicIPs
        });
      }
    });
    
    // 2. JSON 형태로 응답
    res.writeHead(200, { 
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*" // [중요] CORS 오류 방지
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
      spectators: new Set(), // 실시간 관전자 목록
      player: null, // '플레이어'로 식별된 ws. (P1 호스트)

      // --- ReplaySaver 데이터 구조 ---
      roomID: roomId,
      nicknames: ['', ''],
      partialPublicIPs: ['*.*.*.*', '*.*.*.*'],
      inputs: [],
      options: [], // [frameCounter, options][]
      chats: [], // [frameCounter, playerIndex, chatMessage][]
      frameCounter: 0,
      IsGameEnd: false,
      endFrame: null,
      // ------------------------------
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
        case "watch":
          console.log(`[${roomId}] Spectator connected.`);
          currentRoom.spectators.add(ws);

          // 관전자가 접속하면, '현재까지 누적된 모든 리플레이 데이터 팩'을 전송합니다.
          // (이전의 'history' 전송과 동일한 로직)
          ws.send(
            JSON.stringify({
              type: "replay_pack", // Accumulated input data
              pack: {
                version: 'p2p-online-spectator',
                roomID: currentRoom.roomID,
                nicknames: currentRoom.nicknames,
                partialPublicIPs: currentRoom.partialPublicIPs,
                chats: currentRoom.chats,
                options: currentRoom.options,
                inputs: currentRoom.inputs,
              }
            })
          );
          break;

        // --- (A) 핵심: 플레이어 '입력' 데이터 수신 ---
        case "inputs": // Realtime input data
          const usersInputNumber = data.value;
          if (usersInputNumber == -1 && !currentRoom.IsGameEnd) {
              console.log(`[${roomId}] 'End of Stream' (-1) 신호 수신. 게임을 종료 처리합니다.`);
              currentRoom.IsGameEnd = true;
              currentRoom.endFrame = currentRoom.frameCounter;
          }
          if (!isThisConnectionPlayer) {
            return; // Prevent data jacking
          }
          currentRoom.inputs.push(usersInputNumber);
          currentRoom.frameCounter++; // 서버도 프레임 카운터 동기화

          // 2. 현재 접속 중인 모든 관전자에게 '실시간' 전송
          const liveInputMessage = JSON.stringify({
            type: "live_input", // 클라이언트는 이 메시지를 받아 '실시간' 처리
            value: usersInputNumber
          });
          currentRoom.spectators.forEach((spectator) => {
            if (spectator.readyState === 1 /* WebSocket.OPEN */) {
              spectator.send(liveInputMessage);
            }
          });
          break;

        // --- (B) '옵션' 데이터 수신 ---
        case "options":
          if (!isThisConnectionPlayer) {
            return;
          }
          
          const optionsData = [currentRoom.frameCounter, data.options];
          currentRoom.options.push(optionsData); // 1. 누적

          // 2. 실시간 전송
          const liveOptionsMessage = JSON.stringify({
            type: "live_options",
            value: optionsData
          });
          currentRoom.spectators.forEach((spectator) => {
            if (spectator.readyState === 1) {
              spectator.send(liveOptionsMessage);
            }
          });
          break;

        // --- (C) '채팅' 데이터 수신 ---
        case "chat":
          if (!isThisConnectionPlayer) {
            return;
          }
          
          const chatData = [currentRoom.frameCounter, data.whichPlayerSide, data.chatMessage];
          currentRoom.chats.push(chatData);
          
          // 2. 실시간 전송
          const liveChatMessage = JSON.stringify({
            type: "live_chat",
            value: chatData
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
      // 플레이어가 나가도 리플레이 데이터는 유지됩니다 (render.com이 재시작하기 전까지)
      setTimeout(() => {
        if (currentRoom.player === null && currentRoom.spectators.size === 0) {
          console.log(`[${roomId}] Room empty for 5 mins. Deleting history.`);
          rooms.delete(roomId);
        }
      }, 300000); // 5 minutes

    } else {
      currentRoom.spectators.delete(ws);
      console.log(`[${roomId}] Spectator disconnected.`);
      // 관전자가 나갔을 때도 방이 비었는지 확인
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