const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Create a new alert
async function createAlert(user, message, latitude, longitude, emergencyType) {
  const result = await pool.query(
    `INSERT INTO alerts
      (user_id, name, phone, message, latitude, longitude, emergency_type, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'PENDING')
      RETURNING *`,
    [user.id, user.name, user.phone, message, latitude, longitude, emergencyType]
  );
  return result.rows[0];
}

// Get alert by ID
async function getAlertById(alertId) {
  const result = await pool.query("SELECT * FROM alerts WHERE id=$1", [alertId]);
  return result.rows[0];
}

// Update alert status and assigned responder
async function updateAlertStatus(alertId, status, assignedTo = null) {
  const result = await pool.query(
    "UPDATE alerts SET status=$1, assigned_to=$2 WHERE id=$3 RETURNING *",
    [status, assignedTo, alertId]
  );
  return result.rows[0];
}

// Save emergency validation vote
async function saveValidation(alertId, validatorId, vote) {
  await pool.query(
    "INSERT INTO emergency_validation (alert_id, validator_id, vote) VALUES ($1,$2,$3)",
    [alertId, validatorId, vote]
  );
}

// Count True votes for alert
async function countTrueVotes(alertId) {
  const result = await pool.query(
    "SELECT COUNT(*) FROM emergency_validation WHERE alert_id=$1 AND vote=TRUE",
    [alertId]
  );
  return parseInt(result.rows[0].count, 10);
}

module.exports = { pool, createAlert, getAlertById, updateAlertStatus, saveValidation, countTrueVotes };

