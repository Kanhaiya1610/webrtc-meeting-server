// server.js - A robust signaling server for many-to-many meetings

const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

const rooms = new Map(); // This will store all our rooms

console.log(`✅ Signaling server is running on port ${PORT}`);

// Helper function to broadcast a message to everyone in a room
function broadcast(roomId, message) {
    if (rooms.has(roomId)) {
        rooms.get(roomId).participants.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
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
                currentRoomId = roomId;
                currentClientId = 'admin';
                ws.id = 'admin';
                
                rooms.set(roomId, {
                    adminId: 'admin',
                    participants: new Map([['admin', ws]])
                });
                
                ws.send(JSON.stringify({ type: 'room_created', roomId, clientId: 'admin' }));
                console.log(`Room created: ${roomId} by admin`);
                break;

            case 'join_room':
                if (rooms.has(data.roomId)) {
                    currentRoomId = data.roomId;
                    currentClientId = `user-${Math.random().toString(36).substr(2, 9)}`;
                    ws.id = currentClientId;

                    const room = rooms.get(data.roomId);
                    
                    broadcast(currentRoomId, { type: 'peer_joined', clientId: currentClientId });

                    const existingParticipants = Array.from(room.participants.keys());
                    ws.send(JSON.stringify({ type: 'existing_participants', participants: existingParticipants, roomId: currentRoomId, clientId: currentClientId }));

                    room.participants.set(currentClientId, ws);
                    console.log(`${currentClientId} joined room ${currentRoomId}`);
                } else {
                    ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
                }
                break;

            case 'offer':
            case 'answer':
            case 'ice_candidate':
                if (rooms.has(currentRoomId)) {
                    const targetClient = rooms.get(currentRoomId).participants.get(data.targetId);
                    if (targetClient) {
                        // Add the sender's ID to the message for the recipient
                        data.fromId = currentClientId;
                        targetClient.send(JSON.stringify(data));
                    }
                }
                break;
        }
    });

    ws.on('close', () => {
        if (currentRoomId && currentClientId) {
            const room = rooms.get(currentRoomId);
            if (!room) return;

            if (currentClientId === 'admin') {
                broadcast(currentRoomId, { type: 'meeting_ended' });
                rooms.delete(currentRoomId);
                console.log(`Room ${currentRoomId} closed.`);
            } else {
                room.participants.delete(currentClientId);
                broadcast(currentRoomId, { type: 'peer_left', clientId: currentClientId });
            }
        }
    });
});