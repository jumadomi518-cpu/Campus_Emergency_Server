
const WebSocket = require("ws");
const distance = require("../utils/distance");
const { createAlert, getAlertById, updateAlertStatus, saveValidation, countTrueVotes } = require("../models/alertModel");
const webpush = require("web-push");
const pool = require("../models/pool.js");


// IN-MEMORY MAPS
const clients = new Map();       // userId ws
const alertLocks = new Map();    // alertId responderId
//const responderLocks = new Map(); // responderId




// CONFIG
const DISTANCE_THRESHOLD = parseInt(process.env.NOTIFY_RADIUS || "10000"); // meters

// NOTIFY NEARBY USERS
async function notifyNearbyUsers(alert) {

 if (alertLocks.has(alert.id)) {
  console.log("Alert already locked");
  return;
}
  try {
    const { rows: users } = await pool.query(
      "SELECT user_id, role, latitude, longitude FROM users"
    );

    for (const user of users) {

      if (user.user_id === alert.user_id) continue;
      if (user.role !== "user") continue;
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
            title: "Mbiu Emergency Alert",
            body: `An emergency has been triggered ${d.toFixed(2)} meters from you, tap to validate`,
            url: `https://emergency-system-frontend.vercel.app/pages/user.html?alertId=${alert.id}`
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

//handle waiting time
 async function  handleWaitingTime(alertId, time) {
 if (!alertId) return;
try {
 const { rows } = await pool.query("SELECT assigned_to FROM alerts WHERE id = $1", [alertId]);
 const assigned = rows[0].assigned_to;
 const client = clients.get(assigned);

if (client && client.readyState === WebSocket.OPEN) {
  client.send(JSON.stringify({ type: "WAITING_TIME", time: time}));
   console.log("Waiting time send to the responder");
 }

} catch (error) {

console.log("An error occured while handling waiting time", error);
}
   }


async function assignNearestResponder(alert, rejectedUser = null) {
  try {
    console.log("Assign nearest responder (Push Only)");

    //Determine roles
    let roles = [];
    if (alert.emergency_type === "ACCIDENT") roles = ["hospital", "police"];
    if (alert.emergency_type === "FIRE") roles = ["firefighter"];

    if (roles.length === 0) {
      console.log("No roles mapped for this emergency type");
      return;
    }

    //Get responders from DB (exclude rejected)
    const placeholders = roles.map((_, i) => `$${i + 1}`).join(",");
    const roleValues = [...roles];

    let query = `
      SELECT user_id, latitude, longitude 
      FROM users 
      WHERE role IN (${placeholders})
      AND latitude IS NOT NULL
      AND longitude IS NOT NULL
    `;

    if (rejectedUser) {
      query += ` AND user_id != $${roleValues.length + 1}`;
      roleValues.push(rejectedUser);
    }

    const { rows: responders } = await pool.query(query, roleValues);

    if (responders.length === 0) {
      console.log("No responders found in database");
      return;
    }

    // Calculate distances
    const respondersWithDistance = responders.map(user => ({
      user,
      distance: distance(
        alert.latitude,
        alert.longitude,
        user.latitude,
        user.longitude
      )
    }));

    respondersWithDistance.sort((a, b) => a.distance - b.distance);

    const nearest = respondersWithDistance[0].user;


    if (alertLocks.has(alert.id)) {
      console.log("Alert already locked");
      return;
    }

    alertLocks.set(alert.id, nearest.user_id);
    console.log("Alert locked for:", nearest.user_id);

    //Get push subscriptions
    const { rows: subscriptions } = await pool.query(
      "SELECT endpoint, p256dh, auth FROM subscriptions WHERE user_id = $1",
      [nearest.user_id]
    );

    if (subscriptions.length === 0) {
      console.log("No push subscriptions found for user:", nearest.user_id);
      alertLocks.delete(alert.id); // unlock
      return;
    }

    //Send Push Notification
    const payload = JSON.stringify({
      title: "Emergency Alert",
      body: `New ${alert.emergency_type}: ${alert.message}`,
      url: `https://emergency-system-frontend.vercel.app/responder.html?alertId=${alert.id}`
    });

    for (const sub of subscriptions) {
      const pushSub = {
        endpoint: sub.endpoint,
        keys: {
          p256dh: sub.p256dh,
          auth: sub.auth
        }
      };

      try {
        await webpush.sendNotification(pushSub, payload);
        console.log("Push sent to responder:", nearest.user_id);
      } catch (err) {
        console.error("Push error:", err.statusCode, err.body);

        // Remove expired subscriptions
        if (err.statusCode === 410 || err.statusCode === 404) {
          await pool.query(
            "DELETE FROM subscriptions WHERE endpoint = $1",
            [sub.endpoint]
          );
          console.log("Deleted expired subscription");
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
//      responderLocks.set(ws.userId, alert.id);
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
  //responderLocks,
  notifyNearbyUsers,
  assignNearestResponder,
  handleResponderResponse,
  createAlert,
  getAlertById,
  updateAlertStatus,
  saveValidation,
  countTrueVotes,
  handleWaitingTime
};
