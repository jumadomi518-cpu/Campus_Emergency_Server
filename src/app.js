require("dotenv").config();
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const webpush = require("web-push");



const {
  clients,
  alertLocks,
//  responderLocks,
  notifyNearbyUsers,
  assignNearestResponder,
  handleResponderResponse,
  createAlert,
  getAlertById,
  updateAlertStatus,
  saveValidation,
  handleWaitingTime,
  countTrueVotes
} = require("./services/alertService");

// DATABASE
const pool = require("./models/pool.js");
const distance = require("./utils/distance.js");


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
  'mailto:' + (process.env.VAPID_EMAIL || 'jumadomi518@mail.com'),
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// HTTP + WEBSOCKET SERVER
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });





console.log("Server running on port", process.env.PORT || 3000);

// REST: Save Push Subscription


app.post("/api/subscribe", async (req, res) => {
  try {
    const { userId, subscription } = req.body;

if (!userId || !subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
  return res.status(400).json({ success: false, message: "Invalid subscription data" });
}

const endpoint = subscription.endpoint;
const { p256dh, auth } = subscription.keys;

// Insert or update subscription
await pool.query(
  `INSERT INTO subscriptions (user_id, endpoint, p256dh, auth)
   VALUES ($1, $2, $3, $4)
   ON CONFLICT (endpoint) DO UPDATE
   SET user_id = $1,
       p256dh = EXCLUDED.p256dh,
       auth = EXCLUDED.auth`,
  [userId, endpoint, p256dh, auth]
);

    console.log(`Saved subscription for user ${userId}: ${endpoint}`);
    res.json({ success: true });
  } catch (err) {
    console.error("Subscribe error:", err);
    res.status(500).json({ success: false });
  }
});

// Get All Subscriptions
app.get("/api/subscriptions", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM subscriptions");
    res.json({ success: true, subscriptions: result.rows });
  } catch (err) {
    console.error("Fetch subscriptions error:", err);
    res.status(500).json({ success: false });
  }
});

// Fallback for True/False Validation
app.post("/api/validate-alert", async (req, res) => {
  try {
    const auth = req.headers.authorization;
    if (!auth) return res.status(401).send("Unauthorized");

    const token = auth.split(" ")[1];
    const decoded = jwt.verify(token, process.env.SECRET);
    const { alertId, vote } = req.body;

    await saveValidation(alertId, decoded.user_id, vote);

    const trueVotes = await countTrueVotes(alertId);
    if (trueVotes >= 1) {
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


app.get("/api/route_path/:id/:traffic", async (req, res) => {
 try {
 const alertId = req.params.id;
 const trafficId = req.params.traffic;
 await pool.query("UPDATE alerts SET traffic_id = $1 WHERE id = $2", [trafficId, alertId]);
 const { rows } = await pool.query("SELECT latitude, longitude, route_path FROM alerts WHERE id = $1", [alertId]);
 res.json({ data: rows });

 } catch (error) {
 console.log("An error occured while handling route coordinates ", error);
 res.json({ status: error });
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
    console.log("Incoming message before auth:", msg);
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
                name: alert?.name,
                phone: alert?.phone,
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

if (msg.type === "SELECTED_ROUTE") {
 console.log("Route selected has been received");

const notifiedUsers = new Set();

const { rows } = await pool.query(
  "SELECT user_id, role, latitude, longitude FROM users"
);

const subs = (await pool.query(
  "SELECT * FROM subscriptions")).rows;

const subsMap = new Map();
subs.forEach((sub) => {
  subsMap.set(sub.user_id, sub);
});

for (const coords of msg.coordsFromResponder) {
  for (const row of rows) {
    if (notifiedUsers.has(row.user_id)) continue;
    const dis = distance(row.latitude, row.longitude, coords[0], coords[1]);
    console.log(`Traffic ${row.user_id} distance to alert `, dis);
    if (dis < 100 && row.role === "traffic") {
      const sub = subsMap.get(row.user_id);

      if (!sub) continue;
      notifiedUsers.add(row.user_id);

      const pushSubscription = {
        endpoint: sub.endpoint,
        keys: {
          p256dh: sub.p256dh,
          auth: sub.auth
        }
      };

      const payload = JSON.stringify({
        title: "This Route Will be used by Emergency Responders",
        body: "Tap to view route.",
        url: `https://emergency-system-frontend.vercel.app/pages/traffic.html?alertId=${msg.alertId}`
      });

      try {
        await webpush.sendNotification(pushSubscription, payload);
        console.log("Push subscription send to traffic " + row.user_id);
      } catch (err) {

       console.error("Push error:", err.message);
       if (err.statusCode === 410 || err.statusCode === 404) {
            await pool.query(
              "DELETE FROM subscriptions WHERE endpoint = $1",
              [sub.endpoint]
            );
          }
      }
    }

  }
}





  const alert = await getAlertById(msg.alertId);
  const victimWs = clients.get(alert.user_id);
  await pool.query("UPDATE alerts SET route_path = $1 WHERE id = $2", [JSON.stringify(msg.coordsFromResponder), msg.alertId]);
   console.log(msg.coordsFromResponder);

    if (!victimWs) {
    console.log("Alert creator is not connected. Route not sent.");
    return;
  }
 if (victimWs.readyState !== WebSocket.OPEN) return;
 victimWs.send(JSON.stringify(msg));

 }



   // LOCATION UPDATE
 if (msg.type === "LOCATION_UPDATE") {
  ws.lat = msg.latitude;
  ws.lng = msg.longitude;

  await pool.query(
    "UPDATE users SET latitude = $1, longitude = $2 WHERE user_id = $3",
    [ws.lat, ws.lng, ws.userId]
  );

  try {
    const result = await pool.query(
      "SELECT * FROM alerts WHERE assigned_to = $1 AND status = 'IN_PROGRESS'",
      [ws.userId]
    );

    if (result.rows.length > 0) {
      const alert = result.rows[0];

      // Forward to victim if ws is a responder
      if (ws.role !== "user") {
        const victimWs = clients.get(alert.user_id);
        if (victimWs && victimWs.readyState === WebSocket.OPEN) {
          victimWs.send(JSON.stringify({
            type: "RESPONDER_LOCATION_UPDATE",
            alertId: alert.id,
            responderId: ws.userId,
            latitude: ws.lat,
            longitude: ws.lng
          }));
        }
      }

      if (alert.traffic_id) {
        const trafficWs = clients.get(alert.traffic_id);
        if (trafficWs && trafficWs.readyState === WebSocket.OPEN) {
          trafficWs.send(JSON.stringify({
            type: "RESPONDER_LOCATION_UPDATE",
            alertId: alert.id,
            responderId: ws.userId,
            latitude: ws.lat,
            longitude: ws.lng
          }));
        }
      }
    }
  } catch (err) {
    console.error("Forward location error:", err);
  }

  return;
}

    // EMERGENCY CREATION
    if(ws.role === "user" && msg.type === "EMERGENCY"){
       console.log("EMERGENCY received:", msg);
  // Validate coordinates
  if(msg.latitude == null || msg.longitude == null){
    console.log("Invalid coordinates for EMERGENCY, ignoring.");
    return;
  }

  createAlert(ws.user, msg.message, msg.latitude, msg.longitude, msg.emergencyType)
    .then(alert => {
      console.log("Alert created:", alert.id);
      notifyNearbyUsers(alert);

//      assignNearestResponder(alert);
    })
    .catch(err => console.error("Error creating alert:", err));
}

    // VALIDATION RESPONSE
    if (msg.type === "VALIDATE_RESPONSE") {
    console.log("Validate response received");
      try {
        await saveValidation(msg.alertId, ws.userId, msg.vote);
        const trueVotes = await countTrueVotes(msg.alertId);
        if (trueVotes >= 0) {
          const alert = await getAlertById(msg.alertId);
          if (alert && alert.status === "PENDING") {
            await updateAlertStatus(alert.id, "ACTIVE");
            assignNearestResponder(alert);
          }
        }
      } catch(err){ console.error("Validation response error:", err); }
      return;
    }

   if (msg.type === "WAITING_TIME") {
   console.log("Waiting time received ", msg.alertId, msg.time);
   handleWaitingTime(msg.alertId, msg.time);
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
