

  const express = require("express");
const loginRouter = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

 loginRouter.post("/", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: "Email and password required" });
  }

  try {
    const { rows } = await pool.query(
      "SELECT * FROM users WHERE email = $1",
      [email]
    );

    if (!rows.length) {
      return res.status(401).json({
        success: false,
        message: "User with this email does not exist"
      });
    }

    const user = rows[0];
    const match = await bcrypt.compare(password, user.password);

    if (!match) {
      return res.status(401).json({
        success: false,
        message: "Incorrect password"
      });
    }

    const token = jwt.sign(
      {
        user_id: user.user_id,
        name: user.name,
        phone: user.phone,
        email: user.email,
        status: user.status,
        role: user.role
      },
      process.env.SECRET,
      { expiresIn: "30d" }
    );

    return res.json({
      success: true,
      role: user.role,
      token
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = loginRouter;
