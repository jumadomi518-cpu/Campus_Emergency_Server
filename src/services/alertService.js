const distance = require("../utils/distance");
const { createAlert, getAlertById, updateAlertStatus, saveValidation, countTrueVotes } = require("../models/alertModel");
const webpush = require("web-push");

// IN-MEMORY MAPS
const clients = new Map();       // userId ws
const alertLocks = new Map();    // alertId responderId
const subscriptions = new Map(); // userId push subscription

// CONFIG
const DISTANCE_THRESHOLD = parseInt(process.env.NOTIFY_RADIUS || "200"); // meters

// NOTIFY NEARBY USERS
function notifyNearbyUsers(alert){
  try {
    clients.forEach(client => {
      if(client.readyState !== client.OPEN) return;
      if(client.role !== "user" || client.userId === alert.user_id) return;
      if(!client.lat || !client.lng) return;

      const d = distance(alert.latitude, alert.longitude, client.lat, client.lng);
      if(d > DISTANCE_THRESHOLD) return;

      // WebSocket notification
      try {
        client.send(JSON.stringify({
          type: "VALIDATE_ALERT",
          alertId: alert.id,
          message: alert.message,
          latitude: alert.latitude,
          longitude: alert.longitude,
          emergencyType: alert.emergency_type
        }));
      } catch(err){ console.error("WS notify error:", err); }

      // Web Push fallback
      const sub = subscriptions.get(client.userId);
      if(sub){
        webpush.sendNotification(sub, JSON.stringify({
          alertId: alert.id,
          message: alert.message,
          emergencyType: alert.emergency_type
        })).catch(err=>{
          console.log(`Push failed for user ${client.userId}:`, err);

        });
      }
    });
  } catch(err){ console.error("notifyNearbyUsers error:", err); }
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
      if(ws.readyState !== ws.OPEN) return;
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
    if(alertLocks.has(alert.id)) return; // someone else got it first
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
      if(victimWs && victimWs.readyState === victimWs.OPEN){
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
  subscriptions,
  notifyNearbyUsers,
  assignNearestResponder,
  handleResponderResponse,
  createAlert,
  getAlertById,
  updateAlertStatus,
  saveValidation,
  countTrueVotes
};
