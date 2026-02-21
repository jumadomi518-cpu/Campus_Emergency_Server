
const WebSocket = require("ws");
const distance = require("../utils/distance");
const { createAlert, getAlertById, updateAlertStatus, saveValidation, countTrueVotes } = require("../models/alertModel");
const webpush = require("web-push");
const pool = require("../models/pool.js");


// IN-MEMORY MAPS
const clients = new Map();       // userId ws
const alertLocks = new Map();    // alertId responderId

// CONFIG
const DISTANCE_THRESHOLD = parseInt(process.env.NOTIFY_RADIUS || "10000"); // meters

// NOTIFY NEARBY USERS
async function notifyNearbyUsers(alert) {
  try {
    const { rows: users } = await pool.query(
      "SELECT user_id, latitude, longitude FROM users"
    );

    for (const user of users) {

      if (user.user_id === alert.user_id) continue;

      // Calculate distance using DB location
      const d = distance(
        alert.latitude,
        alert.longitude,
        user.latitude,
        user.longitude
      );

      if (d > DISTANCE_THRESHOLD) continue;

      console.log(`Checking user ${user.user_id}, distance: ${d}`);


      // ONLINE user (WebSocket)
      const client = clients.get(user.user_id);
      if (client && client.readyState === WebSocket.OPEN) {
       console.log("Validate alert send");
        client.send(JSON.stringify({
          type: "VALIDATE_ALERT",
          alertId: alert.id,
          message: alert.message,
          latitude: alert.latitude,
          longitude: alert.longitude,
          emergencyType: alert.emergency_type,
          distance: d
        }));
      }


      // Push notification fallback
      const result = await pool.query(
        "SELECT * FROM subscriptions WHERE user_id = $1",
        [user.user_id]
      );

      for (const sub of result.rows) {
        const pushSub = {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth }
        };

        try {
          await webpush.sendNotification(pushSub, JSON.stringify({
            alertId: alert.id,
            message: alert.message,
            emergencyType: alert.emergency_type,
            distance: d
          }));
        } catch (err) {
          if (err.statusCode === 410 || err.statusCode === 404) {
            await pool.query(
              "DELETE FROM subscriptions WHERE endpoint = $1",
              [sub.endpoint]
            );
          }
        }
      }
    }

  } catch (err) {
    console.error("notifyNearbyUsers error:", err);
  }
}


async function assignNearestResponder(alert, rejectedUser = null) {
  try {
    console.log("Assign nearest responder called");
    console.log("Rejected user:", rejectedUser || "none");

    // Determine roles based on emergency type
    let roles = [];
    if (alert.emergency_type === "ACCIDENT") roles = ["hospital", "police"];
    if (alert.emergency_type === "FIRE") roles = ["firefighter"];

    if (roles.length === 0) {
      console.log("No roles for this emergency type");
      return;
    }

    const availableOnline = [];

    // Loop through online WebSocket clients
    for (const ws of clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (!roles.includes(ws.role)) continue;
      if (ws.lat == null || ws.lng == null) continue;
      if (rejectedUser && String(ws.userId) === String(rejectedUser)) continue;

      // Skip if someone else already locked this alert
      const locked = alertLocks.get(alert.id);
      if (locked && locked !== ws.userId) continue;

      const d = distance(alert.latitude, alert.longitude, ws.lat, ws.lng);
      availableOnline.push({ ws, distance: d });
    }

    // Sort online responders by distance
    availableOnline.sort((a, b) => a.distance - b.distance);

    let responder = null;

    // Pick nearest online responder if available
    if (availableOnline.length > 0) {
      responder = availableOnline[0].ws;
      alertLocks.set(alert.id, responder.userId);

      // Send WebSocket message
      responder.send(JSON.stringify({
        type: "EMERGENCY_ASSIGNMENT",
        alertId: alert.id,
        name: alert?.name,
        phone: alert?.phone,
        message: alert.message,
        latitude: alert.latitude,
        longitude: alert.longitude,
        emergencyType: alert.emergency_type,
        responder: {
          id: responder.userId,
          lat: responder.lat,
          lng: responder.lng
        }
      }));
      console.log(`Emergency assigned to online responder ${responder.userId}`);
      return;
    }
console.log("No online responders checking DB");
    // No online responders → check offline DB
    const lowerRoles = roles.map(r => r.toLowerCase());
    const placeholders = lowerRoles.map((_, i) => `$${i + 1}`).join(',');
    const queryParams = [...lowerRoles, rejectedUser];

    const query = `
      SELECT user_id, latitude, longitude
      FROM users
      WHERE LOWER(role) IN (${placeholders})
      AND ($${lowerRoles.length + 1} IS NULL OR user_id != $${lowerRoles.length + 1})
    `;
    const { rows: offlineResponders } = await pool.query(query, queryParams);

    if (offlineResponders.length === 0) {
      console.log("No offline responders found in DB");
      return;
    }

    // Find nearest offline responder
    offlineResponders.forEach(user => {
      user.distance = distance(alert.latitude, alert.longitude, user.latitude, user.longitude);
    });
    offlineResponders.sort((a, b) => a.distance - b.distance);
    const nearestOffline = offlineResponders[0];

    // Lock alert for offline responder
    if (!alertLocks.has(alert.id)) {
      alertLocks.set(alert.id, nearestOffline.user_id);
    }

    // Normalize offline responder
    responder = {
      userId: nearestOffline.user_id,
      lat: nearestOffline.latitude,
      lng: nearestOffline.longitude,
      ws: null
    };

    // Send push notifications
    const { rows: subs } = await pool.query(
      "SELECT * FROM subscriptions WHERE user_id = $1",
      [responder.userId]
    );

    for (const sub of subs) {
      const pushSub = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } };
      try {
        await webpush.sendNotification(pushSub, JSON.stringify({
          title: "Emergency Alert",
          body: `New ${alert.emergency_type} alert nearby: ${alert.message}`,
          data: {
            url: `https://emergency-system-frontend.vercel.app/login?redirect=/responder.html?alertId=${alert.id}`,
            alertId: alert.id,
            emergencyType: alert.emergency_type,
            latitude: alert.latitude,
            longitude: alert.longitude
          }
        }));
        console.log(`Push sent to offline responder ${responder.userId}`);
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          await pool.query("DELETE FROM subscriptions WHERE endpoint = $1", [sub.endpoint]);
        } else {
          console.error("Push error:", err);
        }
      }
    }

  } catch (err) {
    console.error("assignNearestResponder error:", err);
  }
}

// HANDLE RESPONDER RESPONSE
async function handleResponderResponse(ws, msg){
  try {
    console.log(msg.userId);
    const alert = await getAlertById(msg.alertId);
    if(!alert) return;

    if(msg.accept){
      await updateAlertStatus(alert.id, "IN_PROGRESS", ws.userId);

      const victimWs = clients.get(alert.user_id);
      if(victimWs && victimWs.readyState === WebSocket.OPEN){
        victimWs.send(JSON.stringify({
          type: "RESPONDER_ACCEPTED",
          alertId: alert.id,
          responder: { id: ws.userId, name: ws.user.name, role: ws.role, lat: ws.lat, lng: ws.lng }
        }));
      }

    } else {
      // Reject → release lock and assign next responder
      alertLocks.delete(alert.id);
      assignNearestResponder(alert, msg.userId);
    }
  } catch(err){ console.error("handleResponderResponse error:", err); }
}

module.exports = {
  clients,
  alertLocks,
  notifyNearbyUsers,
  assignNearestResponder,
  handleResponderResponse,
  createAlert,
  getAlertById,
  updateAlertStatus,
  saveValidation,
  countTrueVotes
};
