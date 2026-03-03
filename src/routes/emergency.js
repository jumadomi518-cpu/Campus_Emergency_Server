
const { Router } = require("express");
const router = new Router();
const { createAlert, notifyNearbyUsers } = require("../services/alertService.js");
const jwt = require("jsonwebtoken");

function authMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: "No token provided" });
    }

    const token = authHeader.split(" ")[1];

    const decoded = jwt.verify(token, process.env.SECRET);
    console.log("Decoded: ", decoded);
    req.user = decoded;

    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
}



router.post("/", authMiddleware, async (req, res) => {
  try {

     const { latitude, longitude, message, emergencyType } = req.body;

    // Validate coordinates
    if (latitude == null || longitude == null) {
      return res.status(400).json({ error: "Latitude and longitude are required." });
    }

    // Validate emergency type
    if (!emergencyType) {
      return res.status(400).json({ error: "Emergency type is required." });
    }

    // Create alert
    const alert = await createAlert(
      req.user,
      message,
      latitude,
      longitude,
      emergencyType
    );

    console.log("Alert created:", alert.id);

    await notifyNearbyUsers(alert);

    return res.status(201).json({
      success: true,
      message: "Emergency alert created successfully.",
      alertId: alert.id
    });

  } catch (error) {
    console.error("Error creating emergency:", error);

    return res.status(500).json({
      error: "Internal server error.",
      details: process.env.NODE_ENV === "development" ? error.message : undefined
    });
  }
});

module.exports = router;
