const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: [
            "http://localhost:3000",
            "http://localhost:5000",
            "https://nord-chat.netlify.app/" // Replace with your actual Netlify URL
        ],
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 5000;

// Store messages and online users
const messages = [];
const maxMessages = 20;
const onlineUsers = {};

// Serve static files from current directory
app.use(express.static(__dirname));

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/room1', (req, res) => {
    res.sendFile(path.join(__dirname, 'room1.html'));
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', message: 'Server is running' });
});

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Handle user joining
    socket.on('join', (data) => {
        const { username } = data;
        const userIP = socket.handshake.address;
        
        console.log(`User ${username} joined from IP: ${userIP}`);
        
        onlineUsers[username] = socket.id;
        
        // Broadcast user joined
        io.emit('user joined', username);
        
        // Send last 20 messages to new user
        socket.emit('load messages', messages);
    });

    // Handle new messages
    socket.on('message', (msg) => {
        const timestamp = new Date().toLocaleString();
        const messageWithTimestamp = {
            ...msg,
            timestamp: timestamp
        };
        
        // Store message (keep only last 20)
        messages.push(messageWithTimestamp);
        if (messages.length > maxMessages) {
            messages.shift();
        }
        
        console.log(`Message from ${msg.username}: ${msg.text}`);
        
        // Broadcast message to all users
        io.emit('message', messageWithTimestamp);
    });

    // Handle clear messages
    socket.on('clear messages', () => {
        messages.length = 0; // Clear all messages
        io.emit('clear messages'); // Notify all clients
    });

    // Handle user leaving
    socket.on('leave', (data) => {
        const { username } = data;
        if (onlineUsers[username]) {
            delete onlineUsers[username];
            io.emit('user left', username);
        }
    });

    // Handle disconnect
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        
        // Find and remove user from online users
        for (const [username, id] of Object.entries(onlineUsers)) {
            if (id === socket.id) {
                delete onlineUsers[username];
                io.emit('user left', username);
                break;
            }
        }
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Health check available at: http://localhost:${PORT}/health`);
}).on('error', (err) => {
    console.error('Server error:', err);
    process.exit(1);
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
});
