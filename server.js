// // server.js - Refactored for Google Meet Clone Functionality

// const WebSocket = require('ws');
// const { v4: uuidv4 } = require('uuid');

// const PORT = process.env.PORT || 8080; // Render uses PORT env variable
// const wss = new WebSocket.Server({ port: PORT });

// const rooms = new Map(); // Map<roomId, RoomState>
// // RoomState: { adminClientId: string, adminToken: string, participants: Map<clientId, ParticipantState> }
// // ParticipantState: { ws: WebSocket, username: string, isMuted: boolean }

// console.log(`✅ Signaling Server (Meet Clone) running on port ${PORT}`);

// // --- Helper Functions ---
// function broadcast(roomId, message, excludeClientId = null) {
//     const room = rooms.get(roomId);
//     if (!room) return;

//     const messageString = JSON.stringify(message);
//     room.participants.forEach((participant, clientId) => {
//         if (clientId !== excludeClientId && participant.ws.readyState === WebSocket.OPEN) {
//             try {
//                 participant.ws.send(messageString);
//             } catch (error) {
//                 console.error(`Error sending message to ${clientId}:`, error);
//                 // Optionally remove participant if send fails repeatedly
//             }
//         }
//     });
// }

// function getRoomState(roomId, excludeClientId = null) {
//     const room = rooms.get(roomId);
//     if (!room) return [];
//     const participantList = [];
//     room.participants.forEach((participant, clientId) => {
//         if(clientId !== excludeClientId) {
//             participantList.push({
//                 clientId: clientId,
//                 username: participant.username,
//                 isMuted: participant.isMuted // Send current known mute state
//             });
//         }
//     });
//     return participantList;
// }

// function formatTimestamp() {
//      // Simple hh:mm AM/PM format
//      return new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
// }

// // --- WebSocket Connection Logic ---
// wss.on('connection', (ws) => {
//     let currentClientId = uuidv4(); // Assign a unique ID immediately
//     let currentRoomId = null;
//     let currentUsername = `User_${currentClientId.substring(0, 4)}`; // Default username

//     console.log(`Client connected: ${currentClientId}`);

//     // Send the client its unique ID immediately
//     ws.send(JSON.stringify({ type: 'your_info', clientId: currentClientId, isAdmin: false }));

//     ws.on('message', (message) => {
//         let data;
//         try {
//             data = JSON.parse(message);
//             // Basic input validation
//             if (!data.type || typeof data.type !== 'string') throw new Error("Invalid message format: missing or invalid type");
//         } catch (error) {
//             console.error(`Failed to parse message or invalid format from ${currentClientId}:`, message, error);
//             ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format received.' }));
//             return;
//         }

//         // Store username as soon as provided
//         if(data.username && typeof data.username === 'string') {
//              currentUsername = data.username.trim().substring(0, 50); // Sanitize/limit length
//              // Update participant record if already in a room
//              const room = rooms.get(currentRoomId);
//              if (room && room.participants.has(currentClientId)) {
//                  room.participants.get(currentClientId).username = currentUsername;
//              }
//         }

//         // Room management requires clientId which we now have immediately
//         const room = rooms.get(currentRoomId);

//         console.log(`Message from ${currentClientId} (${currentUsername}) in room ${currentRoomId}:`, data.type); // Log type

//         switch (data.type) {
//             case 'create_room':
//                 if (currentRoomId) { // Prevent creating if already in a room
//                     ws.send(JSON.stringify({ type: 'error', message: 'Already in a room.' }));
//                     return;
//                 }
//                 const newRoomId = Math.random().toString(36).substring(2, 8).toUpperCase(); // 6 chars
//                 const adminToken = uuidv4(); // Secure token for admin actions
//                 currentRoomId = newRoomId;

//                 rooms.set(newRoomId, {
//                     adminClientId: currentClientId,
//                     adminToken: adminToken,
//                     participants: new Map([[currentClientId, { ws: ws, username: currentUsername, isMuted: false }]])
//                 });

//                 // Send confirmation to creator *including* admin token
//                 ws.send(JSON.stringify({ type: 'room_created', roomId: newRoomId }));
//                  // Also send 'your_info' again with admin status and token
//                  ws.send(JSON.stringify({ type: 'your_info', clientId: currentClientId, isAdmin: true, adminToken: adminToken, roomId: newRoomId }));

//                 console.log(`Room created: ${newRoomId} by ${currentClientId} (${currentUsername})`);
//                 break;

//             case 'join_room':
//                  if (currentRoomId) { // Prevent joining multiple rooms
//                      ws.send(JSON.stringify({ type: 'error', message: 'Already in a room.' }));
//                      return;
//                  }
//                 const targetRoomId = data.roomId?.toUpperCase(); // Normalize ID
//                 const roomToJoin = rooms.get(targetRoomId);

//                 if (!targetRoomId || !roomToJoin) {
//                     ws.send(JSON.stringify({ type: 'error', message: 'Room not found or invalid ID.' }));
//                     return;
//                 }

//                 if (!currentUsername || currentUsername.startsWith('User_')) {
//                      // If username wasn't sent with join, assign default and request proper one later if needed
//                      currentUsername = data.username || `User_${currentClientId.substring(0, 4)}`;
//                 }

//                  // Check if client is already in the participant list (e.g., reconnecting)
//                  if (roomToJoin.participants.has(currentClientId)) {
//                      console.log(`Client ${currentClientId} (${currentUsername}) rejoining room ${targetRoomId}`);
//                      // Update WebSocket object
//                      roomToJoin.participants.get(currentClientId).ws = ws;
//                  } else {
//                      // Add new participant
//                      roomToJoin.participants.set(currentClientId, { ws: ws, username: currentUsername, isMuted: false });
//                      console.log(`${currentClientId} (${currentUsername}) joined room ${targetRoomId}`);

//                      // Notify existing participants (excluding the newcomer)
//                      broadcast(targetRoomId, {
//                          type: 'peer_joined',
//                          clientId: currentClientId,
//                          username: currentUsername
//                      }, currentClientId); // Exclude self
//                  }

//                 currentRoomId = targetRoomId;

//                  // Send current room state (list of participants) to the newcomer
//                  const participantList = getRoomState(targetRoomId, currentClientId); // Exclude self
//                  ws.send(JSON.stringify({ type: 'room_state', participants: participantList }));

//                  // Also send 'your_info' again, confirming room and admin status
//                  const isAdmin = (currentClientId === roomToJoin.adminClientId);
//                  ws.send(JSON.stringify({ type: 'your_info', clientId: currentClientId, isAdmin: isAdmin, roomId: currentRoomId }));

//                 break;

//             // --- WebRTC Signaling ---
//             case 'offer':
//             case 'answer':
//             case 'ice_candidate':
//                 if (!room || !data.targetClientId) {
//                      console.warn(`Signaling message from ${currentClientId} with no room or target.`);
//                     return;
//                 }
//                 const targetClient = room.participants.get(data.targetClientId);
//                 if (targetClient && targetClient.ws.readyState === WebSocket.OPEN) {
//                     // Add sender info
//                     const messageToSend = { ...data, fromId: currentClientId, username: currentUsername };
//                     targetClient.ws.send(JSON.stringify(messageToSend));
//                     // console.log(`Relayed ${data.type} from ${currentClientId} to ${data.targetClientId}`); // Verbose
//                 } else {
//                     console.warn(`Target client ${data.targetClientId} not found or not open for ${data.type} from ${currentClientId}.`);
//                 }
//                 break;

//             // --- Chat ---
//             case 'chat_message':
//                 if (room && data.message && typeof data.message === 'string') {
//                     const messageText = data.message.trim().substring(0, 500); // Sanitize/limit length
//                     if (messageText) {
//                         broadcast(currentRoomId, {
//                             type: 'new_chat_message',
//                             fromClientId: currentClientId,
//                             fromUsername: currentUsername,
//                             message: messageText,
//                             timestamp: formatTimestamp()
//                         });
//                     }
//                 }
//                 break;

//              // --- Admin Controls ---
//              case 'admin_control':
//                  if (!room) return; // Must be in a room
//                  // Verify admin status using the token
//                  if (currentClientId !== room.adminClientId || data.adminToken !== room.adminToken) {
//                      console.warn(`Unauthorized admin action attempt by ${currentClientId} in room ${currentRoomId}`);
//                      ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized action.' }));
//                      return;
//                  }

//                  console.log(`Admin ${currentClientId} action in room ${currentRoomId}:`, data.action);

//                  if (data.action === 'mute_toggle' && data.targetClientId) {
//                      const targetParticipant = room.participants.get(data.targetClientId);
//                      if (targetParticipant) {
//                          const newState = data.muteState === true; // Ensure boolean
//                          targetParticipant.isMuted = newState;
//                          console.log(`Admin toggled mute for ${data.targetClientId} to ${newState}`);
//                          // Broadcast the new state to everyone (including the target)
//                          broadcast(currentRoomId, {
//                              type: 'force_mute',
//                              targetClientId: data.targetClientId,
//                              muteState: newState
//                          });
//                      }
//                  } else if (data.action === 'mute_all') {
//                       room.participants.forEach((participant, clientId) => {
//                           // Mute everyone except the admin
//                           if (clientId !== currentClientId) {
//                               participant.isMuted = true;
//                                broadcast(currentRoomId, {
//                                    type: 'force_mute',
//                                    targetClientId: clientId,
//                                    muteState: true
//                                });
//                           }
//                       });
//                       console.log(`Admin muted all in room ${currentRoomId}`);
//                  }
//                  break;

//             case 'end_meeting':
//                 if (!room) return;
//                 // Verify admin using token
//                 if (currentClientId === room.adminClientId && data.adminToken === room.adminToken






// backend/server.js
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 8080;
const rooms = new Map(); // roomId -> { adminClientId, adminToken, participants: Map(clientId, ws) }

// ----------------------------
// ICE / STUN endpoint (no secrets)
// ----------------------------
app.get('/ice', (req, res) => {
  res.json({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      // Optional free TURN (for testing only, not 100% reliable)
      {
        urls: 'turn:relay.metered.ca:80',
        username: 'openai',
        credential: 'openai'
      }
    ]
  });
});

function broadcast(roomId, message) {
  const room = rooms.get(roomId);
  if (!room) return;
  for (const [_, participant] of room.participants) {
    if (participant.readyState === WebSocket.OPEN) {
      participant.send(JSON.stringify(message));
    }
  }
}

wss.on('connection', (ws) => {
  let currentClientId = uuidv4();
  let currentRoomId = null;

  ws.send(JSON.stringify({ type: 'your_info', clientId: currentClientId }));

  ws.on('message', (message) => {
    let data;
    try {
      data = JSON.parse(message);
    } catch (err) {
      console.error('Invalid JSON:', err);
      return;
    }

    switch (data.type) {
      case 'create_room': {
        const roomId = uuidv4().slice(0, 6);
        const adminToken = uuidv4();
        rooms.set(roomId, {
          adminClientId: currentClientId,
          adminToken,
          participants: new Map([[currentClientId, ws]])
        });
        currentRoomId = roomId;
        ws.send(
          JSON.stringify({
            type: 'room_created',
            roomId,
            clientId: currentClientId,
            isAdmin: true,
            adminToken
          })
        );
        break;
      }

      case 'join_room': {
        const { roomId } = data;
        const room = rooms.get(roomId);
        if (!room) {
          ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
          return;
        }
        currentRoomId = roomId;
        room.participants.set(currentClientId, ws);

        // Notify others
        broadcast(roomId, {
          type: 'peer_joined',
          clientId: currentClientId
        });

        ws.send(
          JSON.stringify({
            type: 'joined_room',
            roomId,
            clientId: currentClientId,
            isAdmin: false
          })
        );
        break;
      }

      case 'offer':
      case 'answer':
      case 'candidate': {
        const { target, ...payload } = data;
        const room = rooms.get(currentRoomId);
        if (room && room.participants.has(target)) {
          const peer = room.participants.get(target);
          if (peer.readyState === WebSocket.OPEN) {
            peer.send(JSON.stringify({ ...payload, from: currentClientId }));
          }
        }
        break;
      }

      case 'end_meeting': {
        const room = rooms.get(currentRoomId);
        if (
          room &&
          room.adminClientId === currentClientId &&
          data.adminToken === room.adminToken
        ) {
          broadcast(currentRoomId, { type: 'meeting_ended' });
          room.participants.forEach((sock) => sock.close());
          rooms.delete(currentRoomId);
        } else {
          ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
        }
        break;
      }

      default:
        console.log('Unknown message:', data);
    }
  });

  ws.on('close', () => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    room.participants.delete(currentClientId);
    broadcast(currentRoomId, { type: 'peer_left', clientId: currentClientId });

    // If admin leaves, promote next participant
    if (room.adminClientId === currentClientId) {
      const next = room.participants.keys().next().value;
      if (next) {
        room.adminClientId = next;
        room.adminToken = uuidv4();
        const newAdmin = room.participants.get(next);
        if (newAdmin && newAdmin.readyState === WebSocket.OPEN) {
          newAdmin.send(
            JSON.stringify({
              type: 'your_info',
              clientId: next,
              isAdmin: true,
              adminToken: room.adminToken,
              roomId: currentRoomId
            })
          );
        }
      } else {
        rooms.delete(currentRoomId);
      }
    }
  });
});

server.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
