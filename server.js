// Load environment variables from .env file
require('dotenv').config();

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const axios = require('axios'); // Import axios for making HTTP requests

const app = express();

// CORS configuration
app.use(cors({
  origin: ['https://kanhaiya1610.github.io', 'http://localhost:3000', 'http://localhost:5500'],
  methods: ['GET', 'POST' , 'OPTIONS' , 'PUT', 'DELETE'],
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
// Get Gemini API Key from environment variables
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

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

// ===== NEW: SECURE TRANSLATION ENDPOINT =====
// Available languages (for prompt generation)
const CAPTION_LANGUAGES = {
  'en-US': 'English (US)',
  'en-GB': 'English (UK)',
  'es-ES': 'Spanish (Spain)',
  'es-MX': 'Spanish (Mexico)',
  'fr-FR': 'French',
  'de-DE': 'German',
  'it-IT': 'Italian',
  'pt-BR': 'Portuguese (Brazil)',
  'pt-PT': 'Portuguese (Portugal)',
  'ru-RU': 'Russian',
  'ja-JP': 'Japanese',
  'ko-KR': 'Korean',
  'zh-CN': 'Chinese (Simplified)',
  'zh-TW': 'Chinese (Traditional)',
  'hi-IN': 'Hindi',
  'ar-SA': 'Arabic',
  'nl-NL': 'Dutch',
  'pl-PL': 'Polish',
  'tr-TR': 'Turkish',
  'sv-SE': 'Swedish'
};

app.post('/translate', async (req, res) => {
  if (!GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY is not set.');
    return res.status(500).json({ error: 'Translation service is not configured.' });
  }

  const { text, sourceLang, targetLang } = req.body;

  if (!text || !sourceLang || !targetLang) {
    return res.status(400).json({ error: 'Missing required parameters.' });
  }

  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${GEMINI_API_KEY}`;
  
  // Get full language names for a better prompt
  const sourceLangName = CAPTION_LANGUAGES[sourceLang] || sourceLang;
  const targetLangName = CAPTION_LANGUAGES[targetLang] || targetLang;

  const prompt = `Translate the following text from ${sourceLangName} to ${targetLangName}. Respond with *only* the translated text, no other commentary, labels, or quotation marks: "${text}"`;
  
  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
  };

  try {
    const geminiResponse = await axios.post(apiUrl, payload, {
      headers: { 'Content-Type': 'application/json' }
    });

    const candidate = geminiResponse.data.candidates?.[0];
    let translatedText = candidate?.content?.parts?.[0]?.text;

    if (translatedText) {
      // Clean the response
      translatedText = translatedText.trim().replace(/^"|"$/g, '');
      res.json({ translatedText: translatedText });
    } else {
      console.error('Invalid response structure from Gemini:', geminiResponse.data);
      throw new Error('Invalid API response structure');
    }
  } catch (error) {
    console.error('Gemini API call failed:', error.message);
    if (error.response) {
      console.error('Gemini Error Data:', error.response.data);
    }
    res.status(500).json({ error: 'Translation failed' });
  }
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
  
  // Don't log spammy messages like captions
  if (message.type !== 'caption') {
    console.log(`📢 Broadcast to room ${roomId}: ${message.type} (${successCount} recipients)`);
  }
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
    if (!['ice_candidate', 'offer', 'answer', 'caption'].includes(type)) {
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

      // ===============================================
      // ===== THIS IS THE NEWLY ADDED BLOCK =====
      // ===============================================
      case 'caption': {
        if (!currentRoomId) return;
        
        // Check for text
        if (typeof data.text !== 'string') return;
        
        // Broadcast the caption to everyone else
        broadcast(currentRoomId, {
          type: 'caption',
          fromClientId: clientId,
          fromUsername: currentUsername,
          text: data.text,
          isFinal: !!data.isFinal, // Ensure boolean
          language: data.language
        }, clientId); // Exclude the sender
        
        break;
      }
      // ===============================================
      // ===== END OF NEWLY ADDED BLOCK =====
      // ===============================================
      
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
          target.isAdminMuted = newState;
          
          broadcast(currentRoomId, {
            type: 'force_mute',
            targetClientId: data.targetClientId,
            muteState: newState,
            isAdminMuted: newState
          });
          
          console.log(`🎤 Admin ${newState ? 'muted' : 'unmuted'} ${data.targetClientId}`);
          
        } else if (action === 'mute_all') {
          for (const [pid, participant] of room.participants.entries()) {
            if (pid === clientId) continue; // Skip admin
            
            participant.isMuted = true;
            participant.isAdminMuted = true;
            participant.handRaised = false; // Lower all hands when muting all
            
            if (participant.ws && participant.ws.readyState === WebSocket.OPEN) {
              safeSend(participant.ws, {
                type: 'force_mute',
                targetClientId: pid,
                muteState: true,
                isAdminMuted: true
              });
            }
          }
          
          // Broadcast to lower all hands
          broadcast(currentRoomId, {
            type: 'all_hands_lowered'
          });
          
          console.log(`🔇 All participants muted in room ${currentRoomId}`);
          
        } else if (action === 'transfer_admin' && data.targetClientId) {
          const newAdmin = room.participants.get(data.targetClientId);
          if (!newAdmin) return;
          
          // Transfer admin rights
          const oldAdminId = room.adminClientId;
          room.adminClientId = data.targetClientId;
          room.adminToken = uuidv4();
          
          // Notify new admin
          safeSend(newAdmin.ws, {
            type: 'your_info',
            clientId: data.targetClientId,
            isAdmin: true,
            adminToken: room.adminToken,
            roomId: currentRoomId
          });
          
          safeSend(newAdmin.ws, {
            type: 'promoted_to_admin',
            byUsername: currentUsername
          });
          
          // Notify old admin
          safeSend(ws, {
            type: 'your_info',
            clientId,
            isAdmin: false,
            roomId: currentRoomId
          });
          
          // Broadcast to all
          broadcast(currentRoomId, {
            type: 'admin_changed',
            oldAdminId,
            newAdminId: data.targetClientId,
            newAdminName: newAdmin.username
          });
          
          console.log(`👑 Admin transferred from ${oldAdminId} to ${data.targetClientId}`);
        }
        
        break;
      }
      
      case 'raise_hand': {
        if (!currentRoomId) return;
        
        const room = rooms.get(currentRoomId);
        if (!room) return;
        
        const participant = room.participants.get(clientId);
        if (participant) {
          participant.handRaised = !!data.handRaised;
          
          // Broadcast hand status to all
          broadcast(currentRoomId, {
            type: 'hand_status_changed',
            clientId,
            username: currentUsername,
            handRaised: participant.handRaised
          });
          
          console.log(`✋ ${currentUsername} ${participant.handRaised ? 'raised' : 'lowered'} hand`);
        }
        
        break;
      }
      
      case 'request_unmute': {
        if (!currentRoomId) return;
        
        const room = rooms.get(currentRoomId);
        if (!room) return;
        
        // Send request to admin
        const admin = room.participants.get(room.adminClientId);
        if (admin && admin.ws && admin.ws.readyState === WebSocket.OPEN) {
          safeSend(admin.ws, {
            type: 'unmute_request',
            fromClientId: clientId,
            fromUsername: currentUsername
          });
          
          // Confirm to requester
          safeSend(ws, {
            type: 'unmute_request_sent'
          });
          
          console.log(`🙋 ${currentUsername} requested to unmute`);
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
  console.log(`🔐 Translate endpoint: http://localhost:${PORT}/translate`);
  console.log(`❤️ Health check: http://localhost:${PORT}/health`);

  if (!GEMINI_API_KEY) {
    console.warn('⚠️ WARNING: GEMINI_API_KEY is not set in .env file. Translation will fail.');
  }
});
