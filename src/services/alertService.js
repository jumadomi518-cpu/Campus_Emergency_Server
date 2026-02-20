
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


/*// ASSIGN NEAREST RESPONDER
function assignNearestResponder(alert){
  try {
    // Define roles based on emergency type
    console.log("Notify nearby responders called");
    let roles = [];
    if(alert.emergency_type === "ACCIDENT") roles = ["hospital","police"];
    if(alert.emergency_type === "FIRE") roles = ["firefighter"];

    const availableResponders = [];
    clients.forEach(ws=>{
      if(ws.readyState !== WebSocket.OPEN) return;
      if(!roles.includes(ws.role)) return;
      if(!ws.lat || !ws.lng) return;

      const locked = alertLocks.get(alert.id);
      if(locked && locked === ws.userId) return;

      const d = distance(alert.latitude, alert.longitude, ws.lat, ws.lng);
      availableResponders.push({ ws, distance: d });
    });

    if(availableResponders.length === 0) return;

    // Sort by distance
    availableResponders.sort((a,b) => a.distance - b.distance);

    const responder = availableResponders[0].ws;

    // Atomic lock
    if(alertLocks.has(alert.id)) return;
    alertLocks.set(alert.id, responder.userId);

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
  console.log("Respondee assignment completed");
  } catch(err){ console.error("assignNearestResponder error:", err); }
}*/


async function assignNearestResponder(alert) {
  try {
    console.log("Assign nearest responder called");

    // Determine roles based on emergency type
    let roles = [];
    if (alert.emergency_type === "ACCIDENT") roles = ["hospital", "police"];
    if (alert.emergency_type === "FIRE") roles = ["firefighter"];

    const availableResponders = [];

    // Loop through online WebSocket clients
    clients.forEach(ws => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (!roles.includes(ws.role)) return;
      if (!ws.lat || !ws.lng) return;

      // Skip if someone else already locked this alert
      const locked = alertLocks.get(alert.id);
      if (locked && locked === ws.userId) return;

      const d = distance(alert.latitude, alert.longitude, ws.lat, ws.lng);
      availableResponders.push({ ws, distance: d });
    });

    if (availableResponders.length === 0) {
      console.log("No online responders found, will attempt push notifications");
    }

    // Sort responders by distance (nearest first)
    availableResponders.sort((a, b) => a.distance - b.distance);

    // Pick the nearest one (either online or offline)
    let responder = availableResponders.length > 0 ? availableResponders[0].ws : null;

    if (!responder) {
      if (roles.length > 0) {
  const placeholders = roles.map((_, i) => `$${i + 1}`).join(',');
  const query = `SELECT user_id, latitude, longitude FROM users WHERE role IN (${placeholders})`;
  const { rows: offlineResponders } = await pool.query(query, roles);

  if (offlineResponders.length === 0) {
    console.log("No offline responders found in DB");
    return;
  }
} else {
  console.log("No roles for this emergency type, skipping DB query");
  return;
}

      if (offlineResponders.length === 0) {
        console.log("No offline responders found in DB");
        return;
      }

      // Calculate distance and pick nearest
      offlineResponders.forEach(user => {
        const d = distance(alert.latitude, alert.longitude, user.latitude, user.longitude);
        availableResponders.push({ user, distance: d });
      });

      availableResponders.sort((a, b) => a.distance - b.distance);
      const nearestOffline = availableResponders[0].user;

      // Lock the alert atomically
      if (alertLocks.has(alert.id)) return;
      alertLocks.set(alert.id, nearestOffline.user_id);

      responder = nearestOffline;

      // Send Push Notification to offline responder
      const result = await pool.query(
        "SELECT * FROM subscriptions WHERE user_id = $1",
        [responder.user_id]
      );

      for (const sub of result.rows) {
        const pushSub = {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth }
        };

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
          console.log(`Push sent to offline responder ${responder.user_id}`);
        } catch (err) {
          if (err.statusCode === 410 || err.statusCode === 404) {
            await pool.query(
              "DELETE FROM subscriptions WHERE endpoint = $1",
              [sub.endpoint]
            );
          } else {
            console.error("Push error:", err);
          }
        }
      }

      return;
    }

    // Online responder → send WebSocket
    if (responder.readyState === WebSocket.OPEN) {
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
    }

  } catch (err) {
    console.error("assignNearestResponder error:", err);
  }
}




// HANDLE RESPONDER RESPONSE
async function handleResponderResponse(ws, msg){
  try {
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
      assignNearestResponder(alert);
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
