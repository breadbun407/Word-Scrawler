const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
app.use(express.static('public'));

// In-memory room storage
// rooms[roomCode] = { hostId, config, users, sprintState, timer }
const rooms = {};

// Word pools for readable room codes
const adjectives = [
    'brave', 'silent', 'wild', 'clever', 'mighty', 'ancient', 'bright',
    'fuzzy', 'gentle', 'swift', 'crimson', 'frozen', 'amber', 'lone', 'shadow'
];
const nouns = [
    'falcon', 'river', 'forest', 'mountain', 'ember', 'meadow', 'storm',
    'canyon', 'cloud', 'stone', 'hollow', 'valley', 'echo', 'spire', 'grove'
];

// Generate human-readable room code like "brave-river-ember"
function generateRoomCode() {
    const a = adjectives[Math.floor(Math.random() * adjectives.length)];
    const n1 = nouns[Math.floor(Math.random() * nouns.length)];
    const n2 = nouns[Math.floor(Math.random() * nouns.length)];
    return `${a}-${n1}-${n2}`;
}

// Ensure unique room code
function createUniqueRoomCode() {
    let code;
    do {
        code = generateRoomCode();
    } while (rooms[code]);
    return code;
}

// Create new room endpoint
app.get('/create', (req, res) => {
    const code = createUniqueRoomCode();
    rooms[code] = {
        hostId: null,
        config: { durationSeconds: 300 },
        users: {},
        timer: null,
        sprintState: 'idle' // idle | running | ending | ended
    };
    return res.redirect(`/?room=${code}&host=1`);
});

// Socket.io connections
io.on('connection', (socket) => {
    console.log("User connected")

    socket.on('joinRoom', ({ roomId, name, isHost, personalGoalValue, personalGoalUnit }) => {
        if (!roomId || !rooms[roomId]) return socket.emit('roomNotFound');
        socket.join(roomId);

        const room = rooms[roomId];
        if (isHost) room.hostId = socket.id;

        room.users[socket.id] = {
            socketId: socket.id,
            name: name || 'Anonymous',
            isHost: !!isHost,
            lastText: '',
            lastWordCount: 0,
            personalGoalWords: personalGoalUnit === 'percent' ? 0 : Number(personalGoalValue) || 0,
            displayUnit: personalGoalUnit || 'words'
        };

        socket.emit('roomState', {
            config: room.config,
            users: summaryUsers(room, socket.id),
            timer: room.timer ? { endAt: room.timer.endAt } : null,
            sprintState: room.sprintState
        });

        emitUserList(roomId);
    });

    socket.on('configureRoom', ({ roomId, durationSeconds }) => {
        const room = rooms[roomId];
        if (!room || room.hostId !== socket.id) return;

        room.config.durationSeconds = Number(durationSeconds) || 300;
        io.to(roomId).emit('roomConfigured', room.config);
        emitUserList(roomId);
    });

    socket.on('startSprint', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room || room.hostId !== socket.id || room.sprintState === 'running') return;

        room.sprintState = 'running';
        room.finalizing = new Set();
        room.sprintEnded = false;

        const durationMs = (room.config.durationSeconds || 300) * 1000;
        const endAt = Date.now() + durationMs;

        room.timer = {
            endAt,
            timeoutRef: setTimeout(() => {
                requestFinalProgressForDisconnected(roomId);
            }, durationMs)
        };

        io.to(roomId).emit('sprintStarted', { endAt });
        emitUserList(roomId);
    });

    socket.on('progress', ({ roomId, text, wordCount, personalGoalValue, personalGoalUnit }) => {
        const room = rooms[roomId];
        if (!room || room.sprintState !== 'running') return;

        const u = room.users[socket.id];
        if (!u) return;

        u.lastText = typeof text === 'string' ? text : u.lastText;
        u.lastWordCount = Number(wordCount) || 0;
        if (personalGoalValue !== undefined && personalGoalUnit) {
            u.personalGoalWords = Number(personalGoalValue) || 0;
            u.displayUnit = personalGoalUnit;
        }

        io.to(roomId).emit('progressUpdate', summaryUsers(room, socket.id));
    });

    socket.on('finalProgress', ({ roomId, text, wordCount, personalGoalValue, personalGoalUnit }) => {
        const room = rooms[roomId];
        if (!room || room.sprintState !== 'running') return;

        const user = room.users[socket.id];
        if (!user) return;

        user.lastText = text;
        user.lastWordCount = wordCount;
        user.displayUnit = personalGoalUnit;
        user.personalGoalWords = personalGoalValue;

        room.finalizing.add(socket.id);
        checkSprintEnd(roomId);
    });

    socket.on('updateRoomDuration', ({ roomId, durationSeconds }) => {
        const room = rooms[roomId];
        if (!room || room.hostId !== socket.id) return;
        room.config.durationSeconds = durationSeconds;
        io.to(roomId).emit('durationUpdated', { durationSeconds });
    });

    socket.on('disconnect', () => {
        for (const roomId of Object.keys(rooms)) {
            const room = rooms[roomId];
            if (!room.users[socket.id]) continue;

            delete room.users[socket.id];
            emitUserList(roomId);

            if (room.hostId === socket.id) {
                room.hostId = null;
                io.to(roomId).emit('hostLeft');
            }

            if (room.sprintState === 'running') {
                checkSprintEnd(roomId);
            }
        }
    });
});

// Utility functions
function requestFinalProgressForDisconnected(roomId) {
    const room = rooms[roomId];
    if (!room || room.sprintState !== 'running') return;

    // Automatically mark disconnected users as done
    for (const sid of Object.keys(room.users)) {
        if (!room.finalizing.has(sid)) room.finalizing.add(sid);
    }
    checkSprintEnd(roomId);
}

function checkSprintEnd(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    const totalUsers = Object.keys(room.users).length;
    if (room.finalizing.size >= totalUsers && room.sprintState === 'running') {
        const snapshots = Object.values(room.users).map(u => ({
            name: u.name,
            isHost: u.isHost,
            finalWordCount: u.lastWordCount,
            percentOfPersonal: u.personalGoalWords === 0 ? 0 : Math.min(100, Math.round((u.lastWordCount / u.personalGoalWords) * 100)),
            displayUnit: u.displayUnit,
            text: u.lastText,
            socketId: u.socketId
        }));

        console.log("ENDED state here");
        room.sprintState = 'ended';
        clearRoomTimer(room);

        io.to(roomId).emit('sprintEnded', { snapshots, endedAt: Date.now() });
        emitUserList(roomId);
    }
}

function summaryUsers(room, currentSocketId) {
    return Object.values(room.users).map(u => {
        const pGoal = u.personalGoalWords || 1;
        const percent = pGoal === 0 ? 0 : Math.min(100, Math.round((u.lastWordCount / pGoal) * 100));
        return {
            name: u.name,
            isHost: !!u.isHost,
            lastWordCount: u.lastWordCount,
            personalGoalWords: u.personalGoalWords,
            displayUnit: u.displayUnit,
            percentOfPersonal: percent,
            isSelf: u.socketId === currentSocketId
        };
    });
}

function emitUserList(roomId, currentSocketId) {
    if (!rooms[roomId]) return;
    io.to(roomId).emit('userList', summaryUsers(rooms[roomId], currentSocketId));
}

function clearRoomTimer(room) {
    if (!room?.timer) return;
    if (room.timer.timeoutRef) clearTimeout(room.timer.timeoutRef);
    room.timer = null;
}

server.listen(PORT, () => console.log(`Listening on ${PORT}`));
