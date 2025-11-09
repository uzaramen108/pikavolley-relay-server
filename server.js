import { WebSocketServer } from "ws";
import { createServer } from "http";
import { parse } from "url";

const server = createServer((req, res) => {
  // [수정] API 라우터
  if (req.url === "/rooms" && req.method === "GET") {
    // 1. 현재 'rooms' 맵을 순회하며 [ {id, nicknames}, ... ] 배열 생성
    const activeRooms = [];
    rooms.forEach((roomData, roomId) => {
      // 플레이어가 식별된 방만 목록에 포함 (즉, identify_player를 보낸 방)
      if (roomData.player !== null) {
        activeRooms.push({
          id: roomId,
          nicknames: roomData.nicknames 
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
      inputs: [], // [핵심] 여기에 압축된 '입력값(숫자)'이 누적됩니다.
      options: [], // [frameCounter, options][]
      chats: [], // [frameCounter, playerIndex, chatMessage][]
      frameCounter: 0,
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
      // [핵심 수정 2]
      // 이제 모든 통신은 JSON 기반의 '문자열'이라고 가정합니다.
      // ArrayBuffer는 더 이상 사용하지 않습니다.
      data = JSON.parse(message);
    } catch (e) {
      console.error(`[${roomId}] Failed to parse JSON message:`, message);
      return;
    }

    try {
      switch (data.type) {
        // --- 플레이어 식별 및 메타데이터 기록 ---
        case "identify_player":
          isThisConnectionPlayer = true;
          currentRoom.player = ws;
          console.log(`[${roomId}] Player connected.`);
          
          // ReplaySaver.js의 recordNicknames, recordPartialPublicIPs 역할
          if (data.nicknames) {
            currentRoom.nicknames = data.nicknames;
          }
          if (data.partialPublicIPs) {
            currentRoom.partialPublicIPs = data.partialPublicIPs;
          }
          break;

        // --- 관전자 접속 ---
        case "watch":
          console.log(`[${roomId}] Spectator connected.`);
          currentRoom.spectators.add(ws);

          // [핵심 수정 3]
          // 관전자가 접속하면, '현재까지 누적된 모든 리플레이 데이터 팩'을 전송합니다.
          // (이전의 'history' 전송과 동일한 로직)
          ws.send(
            JSON.stringify({
              type: "replay_pack", // 클라이언트는 이 '팩'을 받아 "빨리 감기" 해야 함
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
        case "inputs":
          if (!isThisConnectionPlayer) return; // 플레이어만 이 메시지를 보낼 수 있음
          
          // data.value는 클라이언트가 (input1 << 5) + input2로
          // '압축한 10비트 숫자'여야 합니다.
          const usersInputNumber = data.value;

          // 1. 리플레이용 'inputs' 리스트에 누적
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
          if (!isThisConnectionPlayer) return;
          
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
          if (!isThisConnectionPlayer) return;
          
          const chatData = [currentRoom.frameCounter, data.whichPlayerSide, data.chatMessage];
          currentRoom.chats.push(chatData); // 1. 누적
          
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
      // [메모리 관리] 5분 뒤 관전자가 없으면 방을 삭제합니다.
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