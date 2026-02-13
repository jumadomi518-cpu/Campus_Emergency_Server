require("dotenv").config();
const express = require("express");
const http = require("http");
const { Pool } = require("pg");
const WebSocket = require("ws");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const webpush = require("web-push");

const {
  clients,
  alertLocks,
  subscriptions,
  notifyNearbyUsers,
  assignNearestResponder,
  handleResponderResponse,
  createAlert,
  getAlertById,
  updateAlertStatus,
  saveValidation,
  countTrueVotes
} = require("./services/alertService");

// DATABASE
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// EXPRESS
const app = express();
app.use(cors({
  origin: [
    "https://emergency-system-frontend.vercel.app",
    "http://localhost:7700"
  ]
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
const registerRouter = require("./routes/registerRouter.js");
const loginRouter = require("./routes/loginRouter.js");
app.use("/api/register", registerRouter);
app.use("/api/login", loginRouter);

// Generate keys
const keys = webpush.generateVAPIDKeys();
console.log(keys);


// WEB PUSH CONFIG
webpush.setVapidDetails(
  'mailto: jumadomi518@gmail.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);


// HTTP + WebSocket Server
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
console.log("Server running on port 3000");

// REST: Save Push Subscription
app.post("/api/subscribe", (req, res) => {
  const { userId, subscription } = req.body;
  subscriptions.set(userId, subscription);
  res.send({ success: true });
});

// REST: Fallback for True/False Validation
app.post("/api/validate-alert", async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).send("Unauthorized");

  const token = auth.split(" ")[1];
  try {
    const decoded = jwt.verify(token, process.env.SECRET);
    const { alertId, vote } = req.body;

    await saveValidation(alertId, decoded.user_id, vote);

    const trueVotes = await countTrueVotes(alertId);
    if (trueVotes >= 2) {
      const alert = await getAlertById(alertId);
      if (alert.status === "PENDING") {
        await updateAlertStatus(alert.id, "ACTIVE");
        assignNearestResponder(alert);
      }
    }

    res.send({ success: true });
  } catch {
    res.status(401).send("Invalid token");
  }
});

// WEBSOCKET CONNECTION
wss.on("connection", async ws => {
  ws.isAuthenticated = false;
  ws.userId = null;
  ws.role = null;
  ws.lat = null;
  ws.lng = null;

  ws.on("message", async data => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    // AUTHENTICATION USING TOKEN
    if (!ws.isAuthenticated) {
      if (!msg.token) {
        ws.send(JSON.stringify({ type: "AUTH_ERROR", message: "Token required" }));
        ws.close();
        return;
      }
      try {
        const decoded = jwt.verify(msg.token, process.env.SECRET);
        ws.user = {
          id: decoded.user_id,
          name: decoded.name,
          phone: decoded.phone,
          role: decoded.role
        };
        ws.userId = decoded.user_id;
        ws.role = decoded.role;
        ws.isAuthenticated = true;

        clients.set(ws.userId, ws);
        ws.send(JSON.stringify({ type: "AUTH_SUCCESS", user: ws.user }));

        // OFFLINE RESPONDER RECOVERY
        if(ws.role !== "user") {
          const result = await pool.query(
            "SELECT * FROM alerts WHERE assigned_to=$1 AND status='IN_PROGRESS'",
            [ws.userId]
          );
          for(const alert of result.rows){
            ws.send(JSON.stringify({
              type: "EMERGENCY_ASSIGNMENT",
              alertId: alert.id,
              message: alert.message,
              latitude: alert.latitude,
              longitude: alert.longitude,
              emergencyType: alert.emergency_type,
              responder: {
                id: ws.userId,
                lat: ws.lat,
                lng: ws.lng
              }
            }));
          }
        }

        return;
      } catch {
        ws.send(JSON.stringify({ type: "AUTH_ERROR", message: "Invalid token" }));
        ws.close();
        return;
      }
    }

    // LOCATION UPDATE
    if (msg.type === "LOCATION_UPDATE") {
      ws.lat = msg.latitude;
      ws.lng = msg.longitude;
      return;
    }

    // USER TRIGGERS EMERGENCY
    if (ws.role === "user" && msg.type === "EMERGENCY") {
      const alert = await createAlert(
        ws.user,
        msg.message,
        msg.latitude,
        msg.longitude,
        msg.emergencyType
      );
      notifyNearbyUsers(alert);
      return;
    }

    // NEARBY USER VALIDATES EMERGENCY
    if (msg.type === "VALIDATE_RESPONSE") {
      await saveValidation(msg.alertId, ws.userId, msg.vote);
      const trueVotes = await countTrueVotes(msg.alertId);
      if (trueVotes >= 2) {
        const alert = await getAlertById(msg.alertId);
        if (alert.status === "PENDING") {
          await updateAlertStatus(alert.id, "ACTIVE");
          assignNearestResponder(alert);
        }
      }
      return;
    }

    // RESPONDER ACCEPT / REJECT
    if (msg.type === "RESPONDER_RESPONSE") {
      await handleResponderResponse(ws, msg);
      return;
    }
  });

  ws.on("close", () => {
    if(ws.userId) clients.delete(ws.userId);
  });
});

// START SERVER
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
