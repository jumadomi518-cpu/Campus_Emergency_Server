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
    process.env.FRONTEND_URL || "http://localhost:7700"
  ]
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ROUTES
const registerRouter = require("./routes/registerRouter.js");
const loginRouter = require("./routes/loginRouter.js");
app.use("/api/register", registerRouter);
app.use("/api/login", loginRouter);

// WEB PUSH
webpush.setVapidDetails(
  'mailto:' + (process.env.VAPID_EMAIL || 'admin@example.com'),
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// HTTP + WEBSOCKET SERVER
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

console.log("Server running on port", process.env.PORT || 3000);

// REST: Save Push Subscription
app.post("/api/subscribe", (req, res) => {
  try {
    const { userId, subscription } = req.body;
    if(!userId || !subscription) return res.status(400).send({success:false, error:"Invalid body"});
    subscriptions.set(userId, subscription);
    res.send({ success: true });
  } catch(err){
    console.error("Subscribe error:", err);
    res.status(500).send({success:false});
  }
});

// REST: Fallback for True/False Validation
app.post("/api/validate-alert", async (req, res) => {
  try {
    const auth = req.headers.authorization;
    if (!auth) return res.status(401).send("Unauthorized");

    const token = auth.split(" ")[1];
    const decoded = jwt.verify(token, process.env.SECRET);
    const { alertId, vote } = req.body;

    await saveValidation(alertId, decoded.user_id, vote);

    const trueVotes = await countTrueVotes(alertId);
    if (trueVotes >= 2) {
      const alert = await getAlertById(alertId);
      if (alert && alert.status === "PENDING") {
        await updateAlertStatus(alert.id, "ACTIVE");
        assignNearestResponder(alert);
      }
    }

    res.send({ success: true });
  } catch(err){
    console.error("Validate alert error:", err);
    res.status(401).send("Invalid token");
  }
});

//  WEBSOCKET CONNECTION
wss.on("connection", async ws => {
  ws.isAuthenticated = false;
  ws.userId = null;
  ws.role = null;
  ws.lat = null;
  ws.lng = null;

  ws.on("message", async data => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    // AUTH
    if (!ws.isAuthenticated) {
      if (!msg.token) return ws.close();
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

        // Offline responder recovery
        if(ws.role !== "user") {
          try {
            const result = await pool.query(
              "SELECT * FROM alerts WHERE assigned_to=$1 AND status='IN_PROGRESS'",
              [ws.userId]
            );
            for(const alert of result.rows){
              ws.send(JSON.stringify({
                type: "EMERGENCY_ASSIGNMENT",
                alertId: alert.id,
                message: alert.message,
                latitude: alert.latitude || 0,
                longitude: alert.longitude || 0,
                emergencyType: alert.emergency_type,
                responder: { id: ws.userId, lat: ws.lat || 0, lng: ws.lng || 0 }
              }));
            }
          } catch(err){ console.error("Offline recovery error:", err); }
        }

        return;
      } catch(err){
        console.error("Auth error:", err);
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

    // EMERGENCY CREATION
    if (ws.role === "user" && msg.type === "EMERGENCY") {
      try {
        const alert = await createAlert(
          ws.user,
          msg.message,
          msg.latitude,
          msg.longitude,
          msg.emergencyType
        );
        notifyNearbyUsers(alert);
      } catch(err){ console.error("Create alert error:", err); }
      return;
    }

    // VALIDATION RESPONSE
    if (msg.type === "VALIDATE_RESPONSE") {
      try {
        await saveValidation(msg.alertId, ws.userId, msg.vote);
        const trueVotes = await countTrueVotes(msg.alertId);
        if (trueVotes >= 2) {
          const alert = await getAlertById(msg.alertId);
          if (alert && alert.status === "PENDING") {
            await updateAlertStatus(alert.id, "ACTIVE");
            assignNearestResponder(alert);
          }
        }
      } catch(err){ console.error("Validation response error:", err); }
      return;
    }

    // RESPONDER RESPONSE
    if (msg.type === "RESPONDER_RESPONSE") {
      try { await handleResponderResponse(ws, msg); }
      catch(err){ console.error("Responder response error:", err); }
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
