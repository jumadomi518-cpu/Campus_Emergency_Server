
const { Router } = require("express");
const router = new Router();
const { createAlert, notifyNearbyUsers } = require("../services/alertService.js");

router.post("/", async (req, res) => {
  try {
    const { latitude, longitude, message, emergencyType } = req.body;

    // Validate role
    if (req.user.role !== "user") {
      return res.status(403).json({ error: "Only users can create emergencies." });
    }

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
      req.user.id,
      message,
      latitude,
      longitude,
      emergencyType
    );

    console.log("Alert created:", alert.id);

    // Notify responders
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
