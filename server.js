const express = require("express");
const http = require("http");
const dotenv = require("dotenv");
dotenv.config();
const socketIo = require("socket.io");
const cors = require("cors");
const { Pool } = require("pg");
const app = express();

const allowedOrigins = [
  "http://localhost:3000",
  "http://chiragcloudclient.s3-website.eu-north-1.amazonaws.com",
];
const corsOptions = {
  origin: function (origin, callback) {
    if (allowedOrigins.indexOf(origin) !== -1 || !origin) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
};

app.use(cors(corsOptions));

const fs = require("fs");

console.log("DB_SSL_CERT: ", process.env.DB_SSL_CERT);
// Create a PostgreSQL connection
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASS,
  port: process.env.DB_PORT,
  ssl: {
    rejectUnauthorized: false, // Ensure to accept the server's SSL certificate
    ca: process.env.DB_SSL_CERT, // Path to your SSL certificate file (if needed)
  },
});

pool.connect((err) => {
  if (err) {
    console.error("Error connecting to PostgreSQL:", err.stack);
  } else {
    console.log("Connected to PostgreSQL");
  }
});

// Object to track connected users in each room
const roomUsers = {};

// Create documents table if not exists
pool.query(
  `CREATE TABLE IF NOT EXISTS documents (
    room_id VARCHAR(255) PRIMARY KEY,
    content TEXT
  )`,
  (err) => {
    if (err) {
      console.error("Error creating table:", err);
    }
  }
);

const server = http.createServer(app); // Creating a Server

const io = socketIo(server, {
  cors: {
    origin: "http://localhost:3000",
    methods: ["GET", "POST"],
  },
});

// Handle socket connections
io.on("connection", (socket) => {
  // Join-Room event listener
  socket.on("join-room", ({ roomId, username }) => {
    console.log("Socket connection Start");
    socket.join(roomId);
    console.log(
      "Connected with socket id:" +
        socket.id +
        "  roomId:" +
        roomId +
        " user:" +
        username
    );

    // Initialize the room in the roomUsers object if it doesn't exist
    if (typeof roomUsers[roomId] === "undefined") {
      console.log(`Initializing roomUsers for roomId: ${roomId}`);
      roomUsers[roomId] = [];
    }

    // Check if the user is already in the room to prevent duplicate entries
    const existingUser = roomUsers[roomId].find(
      (user) => user.username === username
    );
    if (!existingUser) {
      console.log(`Adding new user ${username} to room ${roomId}`);
      roomUsers[roomId].push({ id: socket.id, username });

      // Notify other users in the room that a new user has joined
      socket.broadcast.to(roomId).emit("user-joined", username);
      console.log(
        `        Notified other users in room ${roomId} of new user ${username}
`
      );
    } else {
      console.log(
        `        User ${username} already in room ${roomId}, not re-adding or notifying.
`
      );
    }
    console.log(JSON.stringify(roomUsers));

    // Broadcast the list of connected users to everyone in the room except him
    io.in(roomId).emit(
      "connected-users",
      roomUsers[roomId].map((user) => user.username)
    ); // send array of UserNames

    console.log("Query Execution>>> ");
    pool.query(
      "SELECT content FROM documents WHERE room_id = $1", // Use parameterized queries to prevent SQL injection
      [roomId],
      (err, results) => {
        if (err) {
          console.error("Error retrieving document state:", err);
          socket.emit("document-error", "Error retrieving document state");
          return;
        }
        const existingDocumentState =
          results.rows.length > 0 ? JSON.parse(results.rows[0].content) : {};
        socket.emit("initialize-document", existingDocumentState);
      }
    );
  });
  // Join-Room Ends

  socket.on("text-change", ({ delta, roomId, username }) => {
    pool.query(
      `INSERT INTO documents (room_id, content) VALUES ($1, $2)
      ON CONFLICT (room_id) DO UPDATE SET content = $2`,
      [roomId, JSON.stringify(delta)],
      (err) => {
        if (err) {
          console.error("Error updating document state:", err);
          return;
        }
        socket.to(roomId).emit("text-change", { delta, username });
      }
    );
  });

  socket.on("save-document", ({ roomId, content }) => {
    pool.query(
      "UPDATE documents SET content = $1 WHERE room_id = $2",
      [content, roomId],
      (err) => {
        if (err) {
          console.error("Error saving document:", err);
          return;
        }
        // console.log(Document saved for room ${roomId});
      }
    );
  });

  socket.on("cursor-selection", ({ roomId, username, cursorPos }) => {
    console.log(
      "Cursor selection updated for " +
        username +
        " " +
        JSON.stringify(cursorPos)
    );
    socket.to(roomId).emit("remote-cursor-selection", { username, cursorPos });
  });

  socket.on("cursor-move", ({ roomId, username, cursorPos }) => {
    console.log(
      "cursor movement change for " + username + JSON.stringify(cursorPos)
    );
    socket.to(roomId).emit("remote-cursor-move", { username, cursorPos });
  });

  socket.on("leave-room", ({ roomId, username }) => {
    socket.leave(roomId);
    console.log(`User  ${username}  left from Room: ${roomId}`);
    // Remove the user from the room list
    roomUsers[roomId] = roomUsers[roomId].filter(
      (user) => user.username !== username
    );

    // Notify other users in the room
    socket.to(roomId).emit("user-left", username);

    // Update the list of connected users in Current ROOM // Broadcasting not on all available rooms
    io.in(roomId).emit(
      "connected-users",
      roomUsers[roomId].map((user) => user.username)
    );
  });
});

app.get("/", (req, res) => {
  res.send("Hello, World!");
});

// Start the server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () =>
  console.log(`Server running on http://localhost:${PORT}`)
);
