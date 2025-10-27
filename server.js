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
// Enhanced signaling server with chat, admin controls, admin persistence (via identity),
// ICE endpoint, and robust room/participant handling.

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
// Now you can use app
const app = express();

app.use(cors({
  origin: 'https://kanhaiya1610.github.io', // your frontend
  methods: ['GET','POST'],
  credentials: true
}));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 8080;

// rooms: Map<roomId, RoomState>
// RoomState: {
//   adminClientId: string,
//   adminToken: string,
//   adminIdentity?: { email: string }, // optional identity used to persist admin
//   participants: Map<clientId, ParticipantState>
// }
// ParticipantState: { ws: WebSocket, username: string, isMuted: boolean, clientId: string, identity?: { email: string } }
const rooms = new Map();

console.log(`Starting signaling server on port ${PORT}`);

// --- ICE endpoint (simple) ---
app.get('/ice', (req, res) => {
  res.json({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      // Free/test TURN for development only (may be unreliable)
      {
        urls: 'turn:relay.metered.ca:80',
        username: 'openai',
        credential: 'openai'
      }
    ]
  });
});

// Helper: send JSON safely
function safeSend(ws, obj) {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  } catch (e) {
    // ignore send errors
    console.error('safeSend error', e);
  }
}

// Broadcast to all participants in roomId. Optionally exclude clientId.
function broadcast(roomId, message, excludeClientId = null) {
  const room = rooms.get(roomId);
  if (!room) return;
  const msgStr = JSON.stringify(message);
  for (const [clientId, participant] of room.participants.entries()) {
    if (clientId === excludeClientId) continue;
    const ws = participant.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(msgStr);
      } catch (e) {
        console.error('Broadcast send failed for', clientId, e);
      }
    }
  }
}

// Build a minimal room participant list for sending to new joiners (exclude requester)
function getRoomState(roomId, excludeClientId = null) {
  const room = rooms.get(roomId);
  if (!room) return [];
  const list = [];
  for (const [clientId, p] of room.participants.entries()) {
    if (clientId === excludeClientId) continue;
    list.push({
      clientId,
      username: p.username,
      isMuted: !!p.isMuted,
      identity: p.identity || null
    });
  }
  return list;
}

// When a participant disconnects/close, clean up and possibly promote admin
function handleDisconnect(clientId, roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  if (room.participants.has(clientId)) {
    room.participants.delete(clientId);
  }

  // Inform others
  broadcast(roomId, { type: 'peer_left', clientId });

  // If admin left, try to either restore admin to same identity (if someone matches),
  // or promote the first remaining participant.
  if (room.adminClientId === clientId) {
    // Try to find participant with same identity
    const adminIdentity = room.adminIdentity; // maybe undefined
    let promoted = null;
    if (adminIdentity && adminIdentity.email) {
      for (const [cid, p] of room.participants.entries()) {
        if (p.identity && p.identity.email === adminIdentity.email) {
          promoted = cid;
          break;
        }
      }
    }
    if (!promoted) {
      // fallback: pick first participant
      promoted = room.participants.keys().next().value;
    }

    if (promoted) {
      room.adminClientId = promoted;
      room.adminToken = uuidv4();
      const p = room.participants.get(promoted);
      if (p && p.ws && p.ws.readyState === WebSocket.OPEN) {
        safeSend(p.ws, {
          type: 'your_info',
          clientId: promoted,
          isAdmin: true,
          adminToken: room.adminToken,
          roomId
        });
      }
      console.log(`Promoted ${promoted} to admin for room ${roomId}`);
    } else {
      // no participants left
      rooms.delete(roomId);
      console.log(`Deleted empty room ${roomId}`);
    }
  }

  // If room is empty now, delete it
  if (room && room.participants.size === 0) {
    rooms.delete(roomId);
    console.log(`Room ${roomId} removed (empty).`);
  }
}

// --- WebSocket handling ---
wss.on('connection', (ws) => {
  const clientId = uuidv4();
  let currentRoomId = null;
  let currentUsername = `User_${clientId.substring(0, 4)}`;
  let currentIdentity = null; // optional { email: '...' }

  console.log(`Client connected: ${clientId}`);

  // Immediately inform client of its id
  safeSend(ws, { type: 'your_info', clientId, isAdmin: false });

  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      console.error('Invalid JSON from client', clientId, err);
      safeSend(ws, { type: 'error', message: 'Invalid JSON' });
      return;
    }

    // If client sends username or identity in any message, update local copy
    if (data.username && typeof data.username === 'string') {
      currentUsername = data.username.trim().substring(0, 50);
    }
    if (data.identity && typeof data.identity === 'object') {
      // minimal validation — in production verify signatures
      currentIdentity = { ...(data.identity) };
    }

    const type = data.type;
    // console.log(`Message from ${clientId} type=${type} room=${currentRoomId}`);

    switch (type) {
      // ---------------------------------------------------------------------
      case 'create_room': {
        // create new room, set current client as admin
        if (currentRoomId) {
          safeSend(ws, { type: 'error', message: 'Already in a room' });
          return;
        }
        const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
        const adminToken = uuidv4();
        const participants = new Map();
        participants.set(clientId, {
          ws,
          username: currentUsername,
          isMuted: false,
          clientId,
          identity: currentIdentity || null
        });

        const roomState = {
          adminClientId: clientId,
          adminToken,
          adminIdentity: currentIdentity || null,
          participants
        };
        rooms.set(roomId, roomState);
        currentRoomId = roomId;

        // Send room created + your info including admin token
        safeSend(ws, {
          type: 'room_created',
          roomId,
          clientId,
          isAdmin: true,
          adminToken
        });
        safeSend(ws, {
          type: 'your_info',
          clientId,
          isAdmin: true,
          adminToken,
          roomId
        });
        console.log(`Room ${roomId} created by ${clientId} (${currentUsername})`);
        break;
      }

      // ---------------------------------------------------------------------
      case 'join_room': {
        if (currentRoomId) {
          safeSend(ws, { type: 'error', message: 'Already in a room' });
          return;
        }
        const targetRoomId = (data.roomId || '').toString().toUpperCase();
        if (!targetRoomId) {
          safeSend(ws, { type: 'error', message: 'Missing roomId' });
          return;
        }
        const room = rooms.get(targetRoomId);
        if (!room) {
          safeSend(ws, { type: 'error', message: 'Room not found' });
          return;
        }

        // If reconnect: same clientId already present (rare), replace ws
        if (room.participants.has(clientId)) {
          const participant = room.participants.get(clientId);
          participant.ws = ws;
          participant.username = currentUsername;
          participant.identity = currentIdentity || participant.identity;
          currentRoomId = targetRoomId;
          // Send your_info
          const isAdmin = room.adminClientId === clientId;
          safeSend(ws, { type: 'your_info', clientId, isAdmin, roomId: targetRoomId, adminToken: room.adminToken });
          // Send current state
          safeSend(ws, { type: 'room_state', participants: getRoomState(targetRoomId, clientId) });
          break;
        }

        // Add new participant
        room.participants.set(clientId, {
          ws,
          username: currentUsername,
          isMuted: false,
          clientId,
          identity: currentIdentity || null
        });
        currentRoomId = targetRoomId;

        // Notify existing participants (exclude the new joiner)
        broadcast(targetRoomId, {
          type: 'peer_joined',
          clientId,
          username: currentUsername
        }, clientId);

        // Send room state to the newcomer (list of others)
        safeSend(ws, {
          type: 'room_state',
          participants: getRoomState(targetRoomId, clientId)
        });

        // Determine if this joiner should be admin (identity match)
        let isAdmin = false;
        if (room.adminIdentity && currentIdentity && room.adminIdentity.email && currentIdentity.email) {
          // If identity matches the stored adminIdentity, make them admin (persisted admin)
          if (room.adminIdentity.email === currentIdentity.email) {
            room.adminClientId = clientId;
            room.adminToken = uuidv4();
            room.participants.get(clientId).isAdmin = true;
            room.adminIdentity = currentIdentity;
            isAdmin = true;
            console.log(`Restored admin rights to ${clientId} in room ${targetRoomId} by identity match`);
          }
        } else {
          // If not identity-based restoration, check if room admin is missing and we can promote
          isAdmin = room.adminClientId === clientId;
        }

        // Send your info
        safeSend(ws, {
          type: 'your_info',
          clientId,
          isAdmin,
          roomId: targetRoomId,
          adminToken: isAdmin ? room.adminToken : undefined
        });

        console.log(`${clientId} (${currentUsername}) joined room ${targetRoomId}`);
        break;
      }

      // ---------------------------------------------------------------------
      // WebRTC signaling messages: offer / answer / ice_candidate
      case 'offer':
      case 'answer':
      case 'ice_candidate': {
        // Accept either 'targetClientId' or 'target' for compatibility
        const targetId = data.targetClientId || data.target;
        if (!currentRoomId || !targetId) {
          console.warn('Signaling message missing room or target', { type, currentRoomId, targetId });
          return;
        }
        const room = rooms.get(currentRoomId);
        if (!room) return;
        const target = room.participants.get(targetId);
        if (target && target.ws && target.ws.readyState === WebSocket.OPEN) {
          // forward message and include sender info
          const payload = {
            type,
            from: clientId,
            fromId: clientId,
            fromUsername: currentUsername,
            ...data // include sdp, candidate, etc.
          };
          // remove target fields before sending
          delete payload.targetClientId;
          delete payload.target;
          safeSend(target.ws, payload);
        } else {
          console.warn(`Target ${targetId} not available for signaling from ${clientId}`);
        }
        break;
      }

      // ---------------------------------------------------------------------
      // Chat messages
      case 'chat_message': {
        if (!currentRoomId) return;
        if (typeof data.message !== 'string') return;
        const text = data.message.trim().substring(0, 1000);
        if (!text) return;
        broadcast(currentRoomId, {
          type: 'new_chat_message',
          fromClientId: clientId,
          fromUsername: currentUsername,
          message: text,
          timestamp: formatTimestamp()
        });
        break;
      }

      // ---------------------------------------------------------------------
      // Admin controls (mute_toggle, mute_all)
      case 'admin_control': {
        if (!currentRoomId) return;
        const room = rooms.get(currentRoomId);
        if (!room) return;

        // Validate admin token
        if (clientId !== room.adminClientId || data.adminToken !== room.adminToken) {
          safeSend(ws, { type: 'error', message: 'Unauthorized admin action' });
          console.warn('Unauthorized admin attempt by', clientId);
          return;
        }

        const action = data.action;
        console.log(`Admin ${clientId} action ${action} in room ${currentRoomId}`);

        if (action === 'mute_toggle' && data.targetClientId) {
          const target = room.participants.get(data.targetClientId);
          if (!target) return;
          const newState = !!data.muteState;
          target.isMuted = newState;
          // Notify everyone of mute change
          broadcast(currentRoomId, {
            type: 'force_mute',
            targetClientId: data.targetClientId,
            muteState: newState
          });
        } else if (action === 'mute_all') {
          for (const [pid, participant] of room.participants.entries()) {
            if (pid === clientId) continue; // skip admin
            participant.isMuted = true;
            safeSend(participant.ws, {
              type: 'force_mute',
              targetClientId: pid,
              muteState: true
            });
          }
          // Optionally notify admin that action completed
          safeSend(ws, { type: 'action_ack', action: 'mute_all' });
        } else {
          console.warn('Unknown admin action', action);
        }
        break;
      }

      // ---------------------------------------------------------------------
      case 'end_meeting': {
        if (!currentRoomId) return;
        const room = rooms.get(currentRoomId);
        if (!room) return;
        // Only admin can end meeting with valid token
        if (clientId === room.adminClientId && data.adminToken === room.adminToken) {
          broadcast(currentRoomId, { type: 'meeting_ended' });
          // Close participant sockets
          for (const [, participant] of room.participants.entries()) {
            try {
              participant.ws.close();
            } catch (e) {}
          }
          rooms.delete(currentRoomId);
          console.log(`Meeting ${currentRoomId} ended by admin ${clientId}`);
        } else {
          safeSend(ws, { type: 'error', message: 'Unauthorized (end_meeting)' });
        }
        break;
      }

      // ---------------------------------------------------------------------
      default:
        safeSend(ws, { type: 'error', message: 'Unknown message type' });
        console.warn('Unknown message type from', clientId, data.type);
    } // end switch
  }); // end ws.on('message')

  ws.on('close', () => {
    console.log(`Client disconnected: ${clientId}`);
    if (!currentRoomId) return;
    handleDisconnect(clientId, currentRoomId);
  });

  ws.on('error', (err) => {
    console.error('WebSocket error for', clientId, err);
  });
}); // end connection

server.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));

// --- Utility: timestamp formatting ---
function formatTimestamp() {
  return new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
