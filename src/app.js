require("dotenv").config();
const express = require("express");
const http = require("http");
const { Pool } = require("pg");
const WebSocket = require("ws");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");

//DATABASE
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// EXPRESS
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const registerRouter = require("./routes/registerRouter.js");
const loginRouter = require("./routes/loginRouter.js");

 app.use("/api/register", registerRouter);
 app.use("/api/login", loginRouter);

//HTTP SERVER
const server = http.createServer(app);

// WEBSOCKET SERVER
const wss = new WebSocket.Server({ server }); // attach WS to same server
console.log("✅ Server running on single port 3000");

// Haversine distance helper
function distance(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// WS connection
wss.on("connection", ws => {
  ws.on("message", async data => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    // AUTH
    if (msg.token) {
      try {
        const decoded = jwt.verify(msg.token, process.env.SECRET);
        ws.user = {
          id: decoded.id,
          name: decoded.name,
          phone: decoded.phone,
          role: decoded.role
        };
        ws.role = decoded.role;
      } catch {
        ws.send(JSON.stringify({ type: "AUTH_ERROR" }));
        return;
      }
    }

    if (msg.latitude) ws.lat = msg.latitude;
    if (msg.longitude) ws.lng = msg.longitude;

    // USER EMERGENCY
    if (ws.role === "user" && msg.message) {
      const result = await pool.query(
        `INSERT INTO alerts
         (user_id,name,phone,message,latitude,longitude,status)
         VALUES ($1,$2,$3,$4,$5,$6,'ACTIVE')
         RETURNING id`,
        [ws.user.id, ws.user.name, ws.user.phone, msg.message, msg.latitude, msg.longitude]
      );
      const alertId = result.rows[0].id;

      // Broadcast
      wss.clients.forEach(client => {
        if (client.readyState !== WebSocket.OPEN) return;

        // Admin receives full details
        if (client.role === "admin") {
          client.send(JSON.stringify({
            type: "NEW_ALERT",
            data: {
              alertId,
              name: ws.user.name,
              phone: ws.user.phone,
              message: msg.message,
              latitude: msg.latitude,
              longitude: msg.longitude
            }
          }));
        }

        // Nearby students receive limited info
        if (client.role === "user" && client.lat) {
          const d = distance(msg.latitude, msg.longitude, client.lat, client.lng);
          if (d <= 200) {
            client.send(JSON.stringify({
              type: "NEARBY_ALERT",
              data: {
                message: msg.message,
                latitude: msg.latitude,
                longitude: msg.longitude
              }
            }));
          }
        }
      });
    }

    // ADMIN resolves alert
    if (ws.role === "admin" && msg.type === "RESOLVE_ALERT") {
      await pool.query("UPDATE alerts SET status='RESOLVED' WHERE id=$1", [msg.alertId]);

      wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({
            type: "ALERT_RESOLVED",
            alertId: msg.alertId
          }));
        }
      });
    }
  });
});

// START SERVER
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(` Server running on port ${PORT}`));
