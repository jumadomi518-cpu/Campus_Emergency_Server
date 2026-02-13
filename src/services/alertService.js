const distance = require("../utils/distance");
const { createAlert, getAlertById, updateAlertStatus, saveValidation, countTrueVotes } = require("../models/alertModel");
const webpush = require("web-push");

// IN-MEMORY MAPS
const clients = new Map();          // userId -> ws
const alertLocks = new Map();       // alertId -> responderId
const subscriptions = new Map();    // userId -> push subscription

// NOTIFY NEARBY USERS
function notifyNearbyUsers(alert){
  clients.forEach(client=>{
    if(client.readyState === client.OPEN && client.role === "user" && client.userId !== alert.user_id && client.lat && client.lng){
      const d = distance(alert.latitude, alert.longitude, client.lat, client.lng);
      if(d <= 200){
        // WebSocket notification
        client.send(JSON.stringify({
          type: "VALIDATE_ALERT",
          alertId: alert.id,
          message: alert.message,
          latitude: alert.latitude,
          longitude: alert.longitude,
          emergencyType: alert.emergency_type
        }));

        // Web Push fallback
        const sub = subscriptions.get(client.userId);
        if(sub){
          webpush.sendNotification(sub, JSON.stringify({
            alertId: alert.id,
            message: alert.message,
            emergencyType: alert.emergency_type
          })).catch(err=>console.log("Push failed:", err));
        }
      }
    }
  });
}

// ASSIGN NEAREST RESPONDER
function assignNearestResponder(alert){
  let roles = [];
  if(alert.emergency_type === "ACCIDENT") roles = ["hospital","police"];
  if(alert.emergency_type === "FIRE") roles = ["firefighter"];

  const availableResponders = [];
  clients.forEach(ws=>{
    if(ws.readyState === ws.OPEN && roles.includes(ws.role) && ws.lat && ws.lng && (!alertLocks.get(alert.id) || alertLocks.get(alert.id) !== ws.userId)){
      const d = distance(alert.latitude, alert.longitude, ws.lat, ws.lng);
      availableResponders.push({ ws, distance: d });
    }
  });

  availableResponders.sort((a,b)=>a.distance - b.distance);
  if(availableResponders.length === 0) return;

  const responder = availableResponders[0].ws;
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
}

// HANDLE RESPONDER RESPONSE
async function handleResponderResponse(ws, msg){
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
    // Reject → assign next nearest responder
    alertLocks.delete(alert.id);
    assignNearestResponder(alert);
  }
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
