
const WebSocket = require("ws");
const distance = require("../utils/distance");
const { createAlert, getAlertById, updateAlertStatus, saveValidation, countTrueVotes } = require("../models/alertModel");
const webpush = require("web-push");
const { Pool } = require("pg");
const pool = new Pool({
connectionString: process.env.DATABASE_URL,
ssl: { rejectUnauthorized: false }
 });


// IN-MEMORY MAPS
const clients = new Map();       // userId ws
const alertLocks = new Map();    // alertId responderId

// CONFIG
const DISTANCE_THRESHOLD = parseInt(process.env.NOTIFY_RADIUS || "200"); // meters

// NOTIFY NEARBY USERS
async function notifyNearbyUsers(alert) {
  try {
    for (const client of clients.values()) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (client.userId === alert.user_id) continue; // don't notify the sender
      if (!client.lat || !client.lng) continue; // skip if location unknown

      // Calculate distance between alert and user
      const d = distance(alert.latitude, alert.longitude, client.lat, client.lng);
      if (d > DISTANCE_THRESHOLD) continue; // skip users too far away

      // Send WebSocket notification
      client.send(JSON.stringify({
        type: "VALIDATE_ALERT",
        alertId: alert.id,
        name: client.user?.name || "Unknown",
        phone: client.user?.phone || "Unknown",
        message: alert.message,
        latitude: alert.latitude,
        longitude: alert.longitude,
        emergencyType: alert.emergency_type,
        distance: d
      }));

      // Push fallback (optional)
      const result = await pool.query(
        "SELECT * FROM subscriptions WHERE user_id = $1",
        [client.userId]
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
            await pool.query("DELETE FROM subscriptions WHERE endpoint = $1", [sub.endpoint]);
          }
        }
      }
    }
  } catch (err) {
    console.error("notifyNearbyUsers error:", err);
  }
}


// ASSIGN NEAREST RESPONDER
function assignNearestResponder(alert){
  try {
    // Define roles based on emergency type
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

  } catch(err){ console.error("assignNearestResponder error:", err); }
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
