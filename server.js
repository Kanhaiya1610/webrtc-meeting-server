// server.js - V2: A robust signaling server for persistent, admin-controlled meetings

const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid'); // We'll use UUID for a secure admin token

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

const rooms = new Map();

console.log(`✅ Signaling server V2 is running on port ${PORT}`);

function broadcast(roomId, message, excludeId = null) {
    const room = rooms.get(roomId);
    if (room) {
        room.participants.forEach((client, clientId) => {
            if (clientId !== excludeId && client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(message));
            }
        });
    }
}

wss.on('connection', (ws) => {
    let currentRoomId = null;
    let currentClientId = null;

    ws.on('message', (message) => {
        const data = JSON.parse(message);

        switch (data.type) {
            case 'create_room':
                const roomId = Math.random().toString(36).substr(2, 6).toUpperCase();
                const adminToken = uuidv4(); // Secret token for the admin
                currentRoomId = roomId;
                currentClientId = data.username;
                ws.id = currentClientId;
                
                rooms.set(roomId, {
                    adminId: currentClientId,
                    adminToken: adminToken,
                    participants: new Map([[currentClientId, ws]])
                });
                
                ws.send(JSON.stringify({ type: 'room_created', roomId, clientId: currentClientId, adminToken }));
                console.log(`Room created: ${roomId} by ${currentClientId}`);
                break;

            case 'join_room':
                const roomToJoin = rooms.get(data.roomId);
                if (roomToJoin) {
                    currentRoomId = data.roomId;
                    currentClientId = data.username;
                    ws.id = currentClientId;

                    // Is this the admin rejoining?
                    if (data.adminToken && data.adminToken === roomToJoin.adminToken) {
                        console.log(`Admin ${currentClientId} rejoined room ${currentRoomId}`);
                        isAdmin = true;
                    } else {
                        // Announce the new peer to existing participants
                        broadcast(currentRoomId, { type: 'peer_joined', clientId: currentClientId });
                    }
                    
                    const existingParticipants = Array.from(roomToJoin.participants.keys());
                    ws.send(JSON.stringify({ 
                        type: 'existing_participants', 
                        participants: existingParticipants, 
                        roomId: currentRoomId, 
                        clientId: currentClientId,
                        isAdmin: (currentClientId === roomToJoin.adminId)
                    }));

                    roomToJoin.participants.set(currentClientId, ws);
                    console.log(`${currentClientId} joined room ${currentRoomId}`);
                } else {
                    ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
                }
                break;
            
            case 'end_meeting':
                const roomToEnd = rooms.get(data.roomId);
                if (roomToEnd && data.adminToken === roomToEnd.adminToken) {
                    broadcast(data.roomId, { type: 'meeting_ended' });
                    rooms.delete(data.roomId);
                    console.log(`Room ${data.roomId} ended by admin.`);
                }
                break;

            case 'offer':
            case 'answer':
            case 'ice_candidate':
                const targetClient = rooms.get(currentRoomId)?.participants.get(data.targetId);
                if (targetClient) {
                    data.fromId = currentClientId;
                    targetClient.send(JSON.stringify(data));
                }
                break;
            
            case 'admin_mute_user':
                const roomToMute = rooms.get(currentRoomId);
                if (roomToMute && data.adminToken === roomToMute.adminToken) {
                    broadcast(currentRoomId, { type: 'force_mute', targetId: data.targetId });
                }
                break;
            
            case 'chat_message':
                if (currentRoomId) {
                    broadcast(currentRoomId, { 
                        type: 'new_chat_message', 
                        message: data.message, 
                        from: currentClientId,
                        timestamp: new Date().toLocaleTimeString()
                    });
                }
                break;
        }
    });

    ws.on('close', () => {
        const room = rooms.get(currentRoomId);
        if (room && currentClientId) {
            // Only remove participant if they are not the admin. Admin can only leave by ending.
            if (currentClientId !== room.adminId) {
                room.participants.delete(currentClientId);
                broadcast(currentRoomId, { type: 'peer_left', clientId: currentClientId });
                console.log(`${currentClientId} left room ${currentRoomId}`);
            } else {
                console.log(`Admin ${currentClientId} disconnected from ${currentRoomId} (can rejoin).`);
            }
        }
    });
});