const express = require('express');
const path = require('path');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const port = process.env.PORT || 3000;

// Serve static files from "public"
app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // By default, only admin can share video; non-admins have sharing disabled.
  socket.canShareVideo = false;

  socket.on('join-room', (roomId, isAdmin, userName) => {
    socket.join(roomId);
    socket.roomId = roomId;
    socket.isAdmin = isAdmin;
    socket.userName = userName;

    if (isAdmin) {
      socket.canShareVideo = true;
    }

    // Gather existing clients (excluding this one)
    const clients = Array.from(io.sockets.adapter.rooms.get(roomId) || []);
    const otherClients = clients
      .filter(id => id !== socket.id)
      .map(id => {
        const clientSocket = io.sockets.sockets.get(id);
        return {
          socketId: id,
          userName: clientSocket.userName || id,
          isAdmin: clientSocket.isAdmin || false,
          canShareVideo: clientSocket.canShareVideo || false
        };
      });

    // Send the new user info about existing users
    socket.emit('existing-users', otherClients);

    // Let others know this user just connected
    socket.to(roomId).emit('user-connected', {
      socketId: socket.id,
      userName: socket.userName,
      isAdmin: socket.isAdmin,
      canShareVideo: socket.canShareVideo
    });
  });

  socket.on('chat-message', (message) => {
    io.in(socket.roomId).emit('chat-message', {
      from: socket.userName || socket.id,
      message: message
    });
  });

  // Signaling (offers, answers, ICE candidates)
  socket.on('signal', (data) => {
    if (data.to) {
      io.to(data.to).emit('signal', {
        from: socket.id,
        type: data.type,
        message: data.message
      });
    } else {
      socket.to(socket.roomId).emit('signal', {
        from: socket.id,
        type: data.type,
        message: data.message
      });
    }
  });

  // Admin actions
  socket.on('kick-user', (targetSocketId) => {
    if (socket.isAdmin) {
      io.to(targetSocketId).emit('kicked');
      const targetSocket = io.sockets.sockets.get(targetSocketId);
      if (targetSocket) targetSocket.disconnect();
    }
  });

  socket.on('make-admin', (targetSocketId) => {
    if (!socket.isAdmin) return;
    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (!targetSocket) return;

    socket.isAdmin = false;
    socket.canShareVideo = false;
    targetSocket.isAdmin = true;
    targetSocket.canShareVideo = true;

    io.in(socket.roomId).emit('admin-changed', {
      oldAdmin: socket.id,
      newAdmin: targetSocketId
    });
  });

  socket.on('allow-sharing', (targetSocketId) => {
    if (!socket.isAdmin) return;
    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (!targetSocket) return;
    targetSocket.canShareVideo = true;
    io.to(targetSocketId).emit('sharing-allowed');
  });

  socket.on('disallow-sharing', (targetSocketId) => {
    if (!socket.isAdmin) return;
    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (!targetSocket) return;
    targetSocket.canShareVideo = false;
    io.to(targetSocketId).emit('sharing-disallowed');
  });

  // Admin mutes a user: simply forward the mute command.
  socket.on('mute-user', (data) => {
    // data: { targetSocketId, mute: boolean }
    if (!socket.isAdmin) return;
    const targetSocket = io.sockets.sockets.get(data.targetSocketId);
    if (targetSocket) {
      targetSocket.emit('mute-user', { mute: data.mute });
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    socket.to(socket.roomId).emit('user-disconnected', socket.id);
  });
});

http.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
