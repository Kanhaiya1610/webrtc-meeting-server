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
// Enhanced WebRTC Signaling Server with TURN support and robust connection handling
// backend/server.js
// Enhanced WebRTC Signaling Server with robust TURN/STUN configuration

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');

const app = express();

// CORS configuration
app.use(cors({
  origin: ['https://kanhaiya1610.github.io', 'http://localhost:3000', 'http://localhost:5500'],
  methods: ['GET', 'POST'],
  credentials: true
}));

app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ 
  server,
  clientTracking: true,
  perMessageDeflate: false
});

const PORT = process.env.PORT || 8080;

// Data structures
const rooms = new Map();
const connections = new Map();

console.log(`🚀 Starting Enhanced WebRTC Signaling Server on port ${PORT}`);

// ===== ENHANCED ICE SERVER CONFIGURATION =====
// This configuration prioritizes TURN over STUN for better reliability
app.get('/ice', (req, res) => {
  res.json({
    iceServers: [
      // Primary TURN servers (ExpressTurn) - These will be tried first
      {
        urls: [
          'turn:relay1.expressturn.com:3480'
        ],
        username: '000000002076989935',
        credential: 'byPInHD6SuzB8VIXUHdaOwkZlLM='
      },
      {
        urls: [
          'turn:relay1.expressturn.com:3478'
        ],
        username: '000000002076989935',
        credential: 'byPInHD6SuzB8VIXUHdaOwkZlLM='
      },
      {
        urls: [
          'turns:relay1.expressturn.com:443?transport=tcp'
        ],
        username: '000000002076989935',
        credential: 'byPInHD6SuzB8VIXUHdaOwkZlLM='
      },
      // Backup TURN servers (OpenRelay)
      {
        urls: 'turn:openrelay.metered.ca:80',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      },
      {
        urls: 'turn:openrelay.metered.ca:443',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      },
      {
        urls: 'turn:openrelay.metered.ca:443?transport=tcp',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      },
      // STUN servers as fallback (Google)
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' },
      { urls: 'stun:stun4.l.google.com:19302' }
    ],
    // ICE transport policy - try relay first for better success rate
    iceTransportPolicy: 'all', // 'all' allows both relay and direct
    iceCandidatePoolSize: 10 // Gather more candidates
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    rooms: rooms.size,
    connections: wss.clients.size,
    timestamp: new Date().toISOString()
  });
});

// ===== UTILITY FUNCTIONS =====

function safeSend(ws, obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return false;
  }
  
  try {
    ws.send(JSON.stringify(obj));
    return true;
  } catch (error) {
    console.error('Error sending message:', error.message);
    return false;
  }
}

function broadcast(roomId, message, excludeClientId = null) {
  const room = rooms.get(roomId);
  if (!room) return;
  
  const msgStr = JSON.stringify(message);
  let successCount = 0;
  
  for (const [clientId, participant] of room.participants.entries()) {
    if (clientId === excludeClientId) continue;
    
    if (participant.ws && participant.ws.readyState === WebSocket.OPEN) {
      try {
        participant.ws.send(msgStr);
        successCount++;
      } catch (error) {
        console.error(`Failed to broadcast to ${clientId}:`, error.message);
      }
    }
  }
  
  console.log(`📢 Broadcast to room ${roomId}: ${message.type} (${successCount} recipients)`);
}

function getRoomState(roomId, excludeClientId = null) {
  const room = rooms.get(roomId);
  if (!room) return [];
  
  const participants = [];
  for (const [clientId, p] of room.participants.entries()) {
    if (clientId === excludeClientId) continue;
    
    participants.push({
      clientId,
      username: p.username,
      isMuted: !!p.isMuted,
      identity: p.identity || null
    });
  }
  
  return participants;
}

function handleDisconnect(clientId, roomId) {
  console.log(`🔌 Handling disconnect for ${clientId} in room ${roomId}`);
  
  const room = rooms.get(roomId);
  if (!room) return;
  
  // Remove participant
  if (room.participants.has(clientId)) {
    room.participants.delete(clientId);
    console.log(`Removed ${clientId} from room ${roomId}`);
  }
  
  // Notify others
  broadcast(roomId, { type: 'peer_left', clientId });
  
  // Handle admin transfer
  if (room.adminClientId === clientId) {
    const adminIdentity = room.adminIdentity;
    let newAdmin = null;
    
    // Try to find someone with same identity
    if (adminIdentity && adminIdentity.email) {
      for (const [cid, p] of room.participants.entries()) {
        if (p.identity && p.identity.email === adminIdentity.email) {
          newAdmin = cid;
          break;
        }
      }
    }
    
    // Otherwise, promote first participant
    if (!newAdmin && room.participants.size > 0) {
      newAdmin = room.participants.keys().next().value;
    }
    
    if (newAdmin) {
      room.adminClientId = newAdmin;
      room.adminToken = uuidv4();
      
      const newAdminParticipant = room.participants.get(newAdmin);
      if (newAdminParticipant && newAdminParticipant.ws) {
        safeSend(newAdminParticipant.ws, {
          type: 'your_info',
          clientId: newAdmin,
          isAdmin: true,
          adminToken: room.adminToken,
          roomId
        });
        console.log(`👑 Promoted ${newAdmin} to admin in room ${roomId}`);
      }
    } else {
      // No participants left, delete room
      rooms.delete(roomId);
      console.log(`🗑️ Deleted empty room ${roomId}`);
    }
  }
  
  // Clean up empty rooms
  if (room && room.participants.size === 0) {
    rooms.delete(roomId);
    console.log(`🗑️ Deleted empty room ${roomId}`);
  }
  
  // Remove from connection tracking
  connections.delete(clientId);
}

function formatTimestamp() {
  return new Date().toLocaleTimeString([], { 
    hour: 'numeric', 
    minute: '2-digit',
    hour12: true 
  });
}

function validateMessage(data) {
  if (!data || typeof data !== 'object') {
    return { valid: false, error: 'Invalid message format' };
  }
  
  if (!data.type || typeof data.type !== 'string') {
    return { valid: false, error: 'Missing or invalid message type' };
  }
  
  return { valid: true };
}

// ===== WEBSOCKET CONNECTION HANDLING =====

wss.on('connection', (ws, req) => {
  const clientId = uuidv4();
  let currentRoomId = null;
  let currentUsername = `User_${clientId.substring(0, 4)}`;
  let currentIdentity = null;
  
  // Track connection
  connections.set(clientId, { ws, lastPing: Date.now() });
  
  console.log(`✅ Client connected: ${clientId} (Total: ${wss.clients.size})`);
  
  // Send initial info
  safeSend(ws, { 
    type: 'your_info', 
    clientId, 
    isAdmin: false 
  });
  
  // ===== PING/PONG FOR CONNECTION HEALTH =====
  ws.isAlive = true;
  
  ws.on('pong', () => {
    ws.isAlive = true;
    const conn = connections.get(clientId);
    if (conn) {
      conn.lastPing = Date.now();
    }
  });
  
  // ===== MESSAGE HANDLER =====
  ws.on('message', (raw) => {
    let data;
    
    try {
      data = JSON.parse(raw);
    } catch (error) {
      console.error(`Invalid JSON from ${clientId}:`, error.message);
      safeSend(ws, { type: 'error', message: 'Invalid JSON format' });
      return;
    }
    
    // Validate message
    const validation = validateMessage(data);
    if (!validation.valid) {
      console.error(`Invalid message from ${clientId}:`, validation.error);
      safeSend(ws, { type: 'error', message: validation.error });
      return;
    }
    
    // Update username and identity if provided
    if (data.username && typeof data.username === 'string') {
      currentUsername = data.username.trim().substring(0, 50);
    }
    
    if (data.identity && typeof data.identity === 'object') {
      currentIdentity = { ...data.identity };
    }
    
    const { type } = data;
    
    // Log message (except verbose signaling)
    if (!['ice_candidate', 'offer', 'answer'].includes(type)) {
      console.log(`📨 ${clientId} (${currentUsername}): ${type}`);
    }
    
    // ===== MESSAGE ROUTING =====
    
    switch (type) {
      case 'create_room': {
        if (currentRoomId) {
          safeSend(ws, { type: 'error', message: 'Already in a room' });
          return;
        }
        
        const roomId = generateRoomId();
        const adminToken = uuidv4();
        
        const participants = new Map();
        participants.set(clientId, {
          ws,
          username: currentUsername,
          isMuted: false,
          clientId,
          identity: currentIdentity,
          lastSeen: Date.now()
        });
        
        rooms.set(roomId, {
          adminClientId: clientId,
          adminToken,
          adminIdentity: currentIdentity,
          participants,
          createdAt: Date.now()
        });
        
        currentRoomId = roomId;
        
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
        
        console.log(`🎉 Room ${roomId} created by ${clientId} (${currentUsername})`);
        break;
      }
      
      case 'join_room': {
        if (currentRoomId) {
          safeSend(ws, { type: 'error', message: 'Already in a room' });
          return;
        }
        
        const targetRoomId = (data.roomId || '').toString().toUpperCase();
        if (!targetRoomId) {
          safeSend(ws, { type: 'error', message: 'Missing room ID' });
          return;
        }
        
        const room = rooms.get(targetRoomId);
        if (!room) {
          safeSend(ws, { type: 'error', message: 'Room not found' });
          return;
        }
        
        // Check if reconnecting (same clientId)
        if (room.participants.has(clientId)) {
          const participant = room.participants.get(clientId);
          participant.ws = ws;
          participant.username = currentUsername;
          participant.lastSeen = Date.now();
          
          currentRoomId = targetRoomId;
          
          const isAdmin = room.adminClientId === clientId;
          safeSend(ws, {
            type: 'your_info',
            clientId,
            isAdmin,
            roomId: targetRoomId,
            adminToken: isAdmin ? room.adminToken : undefined
          });
          
          safeSend(ws, {
            type: 'room_state',
            participants: getRoomState(targetRoomId, clientId)
          });
          
          console.log(`🔄 ${clientId} (${currentUsername}) reconnected to room ${targetRoomId}`);
          break;
        }
        
        // New participant
        room.participants.set(clientId, {
          ws,
          username: currentUsername,
          isMuted: false,
          clientId,
          identity: currentIdentity,
          lastSeen: Date.now()
        });
        
        currentRoomId = targetRoomId;
        
        // Notify existing participants
        broadcast(targetRoomId, {
          type: 'peer_joined',
          clientId,
          username: currentUsername
        }, clientId);
        
        // Send room state to newcomer
        safeSend(ws, {
          type: 'room_state',
          participants: getRoomState(targetRoomId, clientId)
        });
        
        // Check if should be admin (identity match)
        let isAdmin = false;
        if (room.adminIdentity && currentIdentity && 
            room.adminIdentity.email && currentIdentity.email &&
            room.adminIdentity.email === currentIdentity.email) {
          room.adminClientId = clientId;
          room.adminToken = uuidv4();
          isAdmin = true;
          console.log(`👑 Admin rights restored to ${clientId} via identity`);
        }
        
        safeSend(ws, {
          type: 'your_info',
          clientId,
          isAdmin,
          roomId: targetRoomId,
          adminToken: isAdmin ? room.adminToken : undefined
        });
        
        console.log(`🎊 ${clientId} (${currentUsername}) joined room ${targetRoomId}`);
        break;
      }
      
      case 'offer':
      case 'answer':
      case 'ice_candidate': {
        const targetId = data.targetClientId || data.target;
        
        if (!currentRoomId || !targetId) {
          console.warn(`${type} from ${clientId}: missing room or target`);
          return;
        }
        
        const room = rooms.get(currentRoomId);
        if (!room) return;
        
        const target = room.participants.get(targetId);
        if (!target || !target.ws || target.ws.readyState !== WebSocket.OPEN) {
          console.warn(`Target ${targetId} not available for ${type}`);
          return;
        }
        
        const payload = {
          type,
          from: clientId,
          fromId: clientId,
          fromUsername: currentUsername,
          ...data
        };
        
        delete payload.targetClientId;
        delete payload.target;
        
        safeSend(target.ws, payload);
        break;
      }
      
      case 'chat_message': {
        if (!currentRoomId) return;
        
        if (typeof data.message !== 'string') return;
        
        const message = data.message.trim().substring(0, 1000);
        if (!message) return;
        
        broadcast(currentRoomId, {
          type: 'new_chat_message',
          fromClientId: clientId,
          fromUsername: currentUsername,
          message,
          timestamp: formatTimestamp()
        });
        
        break;
      }
      
      case 'admin_control': {
        if (!currentRoomId) return;
        
        const room = rooms.get(currentRoomId);
        if (!room) return;
        
        // Verify admin token
        if (clientId !== room.adminClientId || data.adminToken !== room.adminToken) {
          safeSend(ws, { type: 'error', message: 'Unauthorized admin action' });
          console.warn(`⚠️ Unauthorized admin attempt by ${clientId}`);
          return;
        }
        
        const action = data.action;
        console.log(`👮 Admin ${clientId} action: ${action} in room ${currentRoomId}`);
        
        if (action === 'mute_toggle' && data.targetClientId) {
          const target = room.participants.get(data.targetClientId);
          if (!target) return;
          
          const newState = !!data.muteState;
          target.isMuted = newState;
          
          broadcast(currentRoomId, {
            type: 'force_mute',
            targetClientId: data.targetClientId,
            muteState: newState
          });
          
        } else if (action === 'mute_all') {
          for (const [pid, participant] of room.participants.entries()) {
            if (pid === clientId) continue; // Skip admin
            
            participant.isMuted = true;
            
            if (participant.ws && participant.ws.readyState === WebSocket.OPEN) {
              safeSend(participant.ws, {
                type: 'force_mute',
                targetClientId: pid,
                muteState: true
              });
            }
          }
          
          console.log(`🔇 All participants muted in room ${currentRoomId}`);
        }
        
        break;
      }
      
      case 'end_meeting': {
        if (!currentRoomId) return;
        
        const room = rooms.get(currentRoomId);
        if (!room) return;
        
        // Verify admin
        if (clientId !== room.adminClientId || data.adminToken !== room.adminToken) {
          safeSend(ws, { type: 'error', message: 'Unauthorized' });
          return;
        }
        
        console.log(`🛑 Meeting ${currentRoomId} ended by admin ${clientId}`);
        
        // Notify all participants
        broadcast(currentRoomId, { type: 'meeting_ended' });
        
        // Close all connections
        for (const [, participant] of room.participants.entries()) {
          try {
            if (participant.ws && participant.ws.readyState === WebSocket.OPEN) {
              participant.ws.close();
            }
          } catch (error) {
            console.error('Error closing participant connection:', error);
          }
        }
        
        // Delete room
        rooms.delete(currentRoomId);
        break;
      }
      
      default:
        console.warn(`Unknown message type: ${type} from ${clientId}`);
        safeSend(ws, { type: 'error', message: 'Unknown message type' });
    }
  });
  
  // ===== DISCONNECT HANDLER =====
  ws.on('close', () => {
    console.log(`❌ Client disconnected: ${clientId}`);
    
    if (currentRoomId) {
      handleDisconnect(clientId, currentRoomId);
    }
    
    connections.delete(clientId);
  });
  
  // ===== ERROR HANDLER =====
  ws.on('error', (error) => {
    console.error(`WebSocket error for ${clientId}:`, error.message);
  });
});

// ===== ROOM ID GENERATION =====
function generateRoomId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let roomId;
  
  do {
    roomId = '';
    for (let i = 0; i < 6; i++) {
      roomId += chars.charAt(Math.floor(Math.random() * chars.length));
    }
  } while (rooms.has(roomId));
  
  return roomId;
}

// ===== HEARTBEAT / PING INTERVAL =====
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log('⏱️ Terminating inactive connection');
      return ws.terminate();
    }
    
    ws.isAlive = false;
    ws.ping();
  });
}, 30000); // Every 30 seconds

// ===== CLEANUP ON SERVER SHUTDOWN =====
wss.on('close', () => {
  clearInterval(heartbeatInterval);
});

// ===== PERIODIC ROOM CLEANUP =====
setInterval(() => {
  const now = Date.now();
  const ROOM_TIMEOUT = 24 * 60 * 60 * 1000; // 24 hours
  
  for (const [roomId, room] of rooms.entries()) {
    if (room.participants.size === 0 && (now - room.createdAt) > ROOM_TIMEOUT) {
      rooms.delete(roomId);
      console.log(`🧹 Cleaned up old empty room: ${roomId}`);
    }
  }
}, 60 * 60 * 1000); // Every hour

// ===== START SERVER =====
server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`📡 WebSocket endpoint: ws://localhost:${PORT}`);
  console.log(`🌐 ICE endpoint: http://localhost:${PORT}/ice`);
  console.log(`❤️ Health check: http://localhost:${PORT}/health`);
});